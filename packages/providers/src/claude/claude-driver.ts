import type { PermissionMode } from '@ari/contracts/common'
import type { Writable } from 'node:stream'
import { createLogger } from '@ari/shared/logger'
import { mapClaudeLine } from './mapper'
import type { AdapterSession, Driver, ProviderAdapter } from '../driver'
import type { PumpableProcess } from '../process-stream'
import { streamProcessEvents } from '../process-stream'
import { spawnCli } from '../spawn-cli'
import { teardownChild } from '../teardown'

const log = createLogger('providers:claude')

/** Time the CLI gets to honor an interrupt frame before the kill fallback fires. */
const INTERRUPT_KILL_FALLBACK_MS = 2000

/**
 * Decision vocabulary accepted by the stdin control layer. `always-allow`
 * persists a session-scoped allow rule for the tool; `allow` is one-shot.
 */
export type ApprovalDecision = 'allow' | 'always-allow' | 'deny'

/**
 * Builds the argv for a `claude` turn driven over bidirectional stream-json.
 * The prompt itself rides stdin as the first user frame (see
 * {@linkcode buildUserFrame}); approvals arrive as can_use_tool control
 * requests because of `--permission-prompt-tool stdio`. Kept pure for tests;
 * flag drift is caught by fixture tests plus the diagnostics card (M4.15).
 */
export function buildClaudeArgs(session: AdapterSession): string[] {
  const args = [
    '--output-format',
    'stream-json',
    '--verbose',
    '--input-format',
    'stream-json',
    '--permission-prompt-tool',
    'stdio',
  ]
  if (session.modelId) args.push('--model', session.modelId)
  if (session.resumeOf) args.push('--resume', session.resumeOf)
  args.push('--permission-mode', permissionModeFlag(session.permissionMode))
  return args
}

function permissionModeFlag(mode: PermissionMode): string {
  switch (mode) {
    case 'ask':
      return 'default'
    case 'allow-edits':
      return 'acceptEdits'
    case 'full':
      return 'bypassPermissions'
  }
}

/**
 * Stream-json input user frame — the initial turn prompt and mid-session
 * steering messages ride stdin in this shape.
 */
export function buildUserFrame(text: string): unknown {
  return { type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }
}

/** Cooperative interrupt request; the driver still kills the process if the stream ignores it. */
export function buildInterruptFrame(requestId = 'int-1'): unknown {
  return { type: 'control_request', request_id: requestId, request: { subtype: 'interrupt' } }
}

/**
 * Builds the control_response answering a can_use_tool control request.
 * `always-allow` persists an allow rule for the tool for the rest of the CLI
 * session (`destination: 'session'`); plain `allow` is one-shot.
 */
export function buildApprovalResponseFrame(
  requestId: string,
  decision: ApprovalDecision,
  toolName?: string,
): unknown {
  if (decision === 'deny') {
    return {
      type: 'control_response',
      response: { subtype: 'success', request_id: requestId, response: { behavior: 'deny', message: 'Denied by user in Ari.' } },
    }
  }
  const allow: Record<string, unknown> = { behavior: 'allow' }
  if (decision === 'always-allow' && toolName !== undefined && toolName !== 'unknown') {
    allow['updatedPermissions'] = [
      { type: 'addRules', rules: [{ toolName }], behavior: 'allow', destination: 'session' },
    ]
  }
  return {
    type: 'control_response',
    response: { subtype: 'success', request_id: requestId, response: allow },
  }
}

/** Error control_response for control requests Ari does not handle; without it the CLI would wait forever. */
export function buildUnsupportedControlResponse(requestId: string, subtype: string | undefined): unknown {
  return {
    type: 'control_response',
    response: {
      subtype: 'error',
      request_id: requestId,
      error: { message: `Ari does not support control request subtype ${subtype ?? '<none>'}` },
    },
  }
}

/**
 * Structural subset of a spawned child the stdin control layer relies on;
 * test doubles satisfy it without spawning a real process.
 */
export interface ControlProcessLike extends PumpableProcess {
  stdin: Writable | null
  readonly killed: boolean
  kill(): boolean
}

/**
 * ProviderAdapter plus the Claude stdin control protocol: raw frames,
 * mid-session steering, and approval responses over the writable stdin.
 */
export interface ClaudeControlAdapter extends ProviderAdapter {
  /** Writes one control frame as a JSON line to the CLI stdin. */
  send(frame: unknown): void
  /** Steers a running turn by appending a user message. */
  steer(text: string): void
  /** Answers a pending can_use_tool permission prompt via control_response. */
  respondApproval(approvalId: string, decision: ApprovalDecision): void
}

/**
 * Wires a spawned `claude` stream-json process into an adapter with stdin
 * control: the initial prompt frame, steering frames, can_use_tool approval
 * responses over the real control protocol, error answers for unsupported
 * control requests, and interrupt with a timed kill fallback for CLIs that
 * never honor the control frame.
 */
export function wireClaudeControl(
  child: ControlProcessLike,
  options: { initialPrompt?: unknown } = {},
): ClaudeControlAdapter {
  let killFallback: ReturnType<typeof setTimeout> | null = null
  /** request_id → tool name of live can_use_tool prompts, for always-allow rules. */
  const pendingPermissions = new Map<string, string>()

  const clearKillFallback = (): void => {
    if (killFallback !== null) {
      clearTimeout(killFallback)
      killFallback = null
    }
  }

  child.on('close', () => clearKillFallback())

  // EPIPE during teardown is routine once the CLI exits; keep it from crashing the host.
  child.stdin?.on('error', (err: Error) => log.debug('claude stdin error', { message: err.message }))

  /** Best-effort write; false means stdin is gone and callers must fall back. */
  const writeLine = (frame: unknown): boolean => {
    const stdin = child.stdin
    if (!stdin || stdin.destroyed || stdin.writableEnded) {
      log.debug('claude stdin unavailable; dropping control frame')
      return false
    }
    stdin.write(`${JSON.stringify(frame)}\n`)
    return true
  }

  /** Answers control requests Ari cannot serve so the CLI never stalls on them. */
  const answerUnhandledControl = (line: string): void => {
    let parsed: {
      type?: string
      request_id?: string
      request?: { subtype?: string; tool_name?: string }
    }
    try {
      parsed = JSON.parse(line) as typeof parsed
    } catch {
      return
    }
    if (parsed.type !== 'control_request' || typeof parsed.request_id !== 'string') return
    if (parsed.request?.subtype === 'can_use_tool') {
      pendingPermissions.set(parsed.request_id, parsed.request.tool_name ?? 'unknown')
      return
    }
    writeLine(buildUnsupportedControlResponse(parsed.request_id, parsed.request?.subtype))
  }

  const iterator = streamProcessEvents(child, (line: string) => {
    answerUnhandledControl(line)
    return mapClaudeLine(line)
  }, {
    label: 'claude',
    stderrLog: (text) => log.debug('claude stderr', { text: text.slice(0, 500) }),
  })[Symbol.asyncIterator]()

  // The turn's prompt rides stdin as the first stream-json user frame now that
  // --input-format stream-json replaced the one-shot -p argv form.
  if (options.initialPrompt !== undefined) {
    writeLine(options.initialPrompt)
  }

  return {
    start: () => ({ [Symbol.asyncIterator]: () => iterator }),
    send: (frame) => {
      writeLine(frame)
    },
    steer: (text) => {
      writeLine(buildUserFrame(text))
    },
    respondApproval: (approvalId, decision) => {
      writeLine(buildApprovalResponseFrame(approvalId, decision, pendingPermissions.get(approvalId)))
      pendingPermissions.delete(approvalId)
    },
    interrupt: () => {
      if (child.killed || killFallback !== null) return
      const delivered = writeLine(buildInterruptFrame())
      killFallback = setTimeout(() => {
        killFallback = null
        if (!child.killed) child.kill()
      }, INTERRUPT_KILL_FALLBACK_MS)
      if (!delivered) {
        clearKillFallback()
        if (!child.killed) child.kill()
      }
    },
    dispose: () => {
      clearKillFallback()
      return teardownChild(child)
    },
  }
}

export class ClaudeDriver implements Driver {
  readonly kind = 'claude' as const

  constructor(private readonly binaryPath: string) {}

  create(session: AdapterSession): Promise<ProviderAdapter> {
    const child = spawnCli(this.binaryPath, buildClaudeArgs(session), {
      cwd: session.workspacePath,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    log.debug('claude spawned', { pid: child.pid })

    return Promise.resolve(wireClaudeControl(child, { initialPrompt: buildUserFrame(session.prompt) }))
  }
}
