import type { PermissionMode } from '@ari/contracts/common'
import type { Writable } from 'node:stream'
import { createLogger } from '@ari/shared/logger'
import { mapClaudeLine } from './mapper'
import type { AdapterSession, Driver, ProviderAdapter } from '../driver'
import type { PumpableProcess } from '../process-stream'
import { streamProcessEvents } from '../process-stream'
import { spawnCli } from '../spawn-cli'

const log = createLogger('providers:claude')

/** Time the CLI gets to honor an interrupt frame before the kill fallback fires. */
const INTERRUPT_KILL_FALLBACK_MS = 2000

export type ApprovalDecision = 'approve' | 'deny'

/**
 * Builds the argv for a one-shot `claude` turn. Kept pure for tests; flag
 * drift is caught by fixture tests plus the diagnostics card (M4.15).
 */
export function buildClaudeArgs(session: AdapterSession): string[] {
  const args = ['-p', session.prompt, '--output-format', 'stream-json', '--verbose']
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
 * Mid-session steering and approval responses ride in as plain user turns —
 * the one stream-json input shape every claude CLI version accepts.
 */
export function buildUserFrame(text: string): unknown {
  return { type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }
}

/** Cooperative interrupt request; the driver still kills the process if the stream ignores it. */
export function buildInterruptFrame(requestId = 'int-1'): unknown {
  return { type: 'control_request', request_id: requestId, request: { subtype: 'interrupt' } }
}

export function buildApprovalResponseFrame(
  approvalId: string,
  decision: ApprovalDecision,
): unknown {
  const directive =
    decision === 'approve' ? `Approve tool use ${approvalId}.` : `Deny tool use ${approvalId}.`
  return buildUserFrame(directive)
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
  /** Answers a pending permission prompt with a directive user turn. */
  respondApproval(approvalId: string, decision: ApprovalDecision): void
}

/**
 * Wires a spawned `claude` stream-json process into an adapter with stdin
 * control: steering frames, approval responses, and interrupt with a timed
 * kill fallback for CLIs that never honor the control frame.
 */
export function wireClaudeControl(child: ControlProcessLike): ClaudeControlAdapter {
  let killFallback: ReturnType<typeof setTimeout> | null = null

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

  const iterator = streamProcessEvents(child, mapClaudeLine, {
    label: 'claude',
    stderrLog: (text) => log.debug('claude stderr', { text: text.slice(0, 500) }),
  })[Symbol.asyncIterator]()

  return {
    start: () => ({ [Symbol.asyncIterator]: () => iterator }),
    send: (frame) => {
      writeLine(frame)
    },
    steer: (text) => {
      writeLine(buildUserFrame(text))
    },
    respondApproval: (approvalId, decision) => {
      writeLine(buildApprovalResponseFrame(approvalId, decision))
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
      if (!child.killed) child.kill()
      return Promise.resolve()
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

    return Promise.resolve(wireClaudeControl(child))
  }
}
