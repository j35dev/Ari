import type { PermissionMode } from '@ari/contracts/common'
import type { AgentEvent } from '@ari/contracts/agent-event'
import type { Writable } from 'node:stream'
import { createLogger } from '@ari/shared/logger'
import { mapClaudeLine, type NativeLine } from './mapper'
import { ClaudeBackgroundTasks } from './background-tasks'
import { claudeSessionPool, type ClaudeSessionPool } from './session-pool'
import type { AdapterApprovalDecision, AdapterSession, Driver, ProviderAdapter } from '../driver'
import { ONE_SHOT_PROVIDER_CAPABILITIES } from '../driver'
import { loadImageData, missingImagesNote, stagedImagesOf } from '../attachments'
import type { PumpableProcess } from '../process-stream'
import { streamProcessEvents } from '../process-stream'
import { spawnCli } from '../spawn-cli'
import { teardownChild } from '../teardown'

const log = createLogger('providers:claude')
const CLAUDE_CAPABILITIES = {
  ...ONE_SHOT_PROVIDER_CAPABILITIES,
  steering: 'live',
  liveResponses: 'approvals',
  nativeChildren: { ...ONE_SHOT_PROVIDER_CAPABILITIES.nativeChildren, visibility: 'lifecycle' },
  processContinuity: 'between-turns',
  terminalStatus: 'explicit',
} as const

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
    '--include-partial-messages',
    '--permission-prompt-tool',
    'stdio',
  ]
  if (session.modelId) args.push('--model', session.modelId)
  if (session.effort) args.push('--effort', session.effort)
  if (session.resumeOf) args.push('--resume', session.resumeOf)
  // Not stored with the conversation, so it is sent on every spawn, resumed or not.
  if (session.instructions) args.push('--append-system-prompt', argvSafeText(session.instructions))
  args.push('--permission-mode', permissionModeFlag(session.permissionMode))
  return args
}

/**
 * Makes free text safe to pass as one argument through a Windows `.cmd` shim.
 *
 * A global npm install of `claude` is a shim that re-parses its arguments
 * with cmd.exe. That second parse does not understand `\"`, so a double quote
 * inside the argument ends the quoted region and whatever follows — `&`, `<`,
 * `>` — is executed as shell syntax; `%NAME%` is expanded even inside quotes.
 * The text can carry a session title, which a model or a user chose. Without
 * a double quote or a percent sign in it there is nothing for cmd.exe to act
 * on, so those two are replaced on every platform rather than only where the
 * shim happens to be in use.
 */
export function argvSafeText(text: string): string {
  return text
    .replace(/"/g, "'")
    .replace(/%/g, ' percent ')
    .replace(/\s*[\r\n]+\s*/g, ' ')
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
 * steering messages ride stdin in this shape. Staged images ride as
 * Anthropic-style base64 image blocks; steering frames stay text-only.
 */
export function buildUserFrame(
  text: string,
  images: { dataBase64: string; mimeType: string }[] = [],
): unknown {
  const content: unknown[] = []
  if (text.length > 0) content.push({ type: 'text', text })
  for (const image of images) {
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: image.mimeType, data: image.dataBase64 },
    })
  }
  return { type: 'user', message: { role: 'user', content } }
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
      response: {
        subtype: 'success',
        request_id: requestId,
        response: { behavior: 'deny', message: 'Denied by user in Ari.' },
      },
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
export function buildUnsupportedControlResponse(
  requestId: string,
  subtype: string | undefined,
): unknown {
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
  pid?: number | undefined
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
  /** Steers a running turn by appending a user message; false when stdin is gone. */
  steer(text: string): boolean
  /** Answers a pending can_use_tool permission prompt via control_response. */
  respondApproval(approvalId: string, decision: AdapterApprovalDecision): void
}

/**
 * The control protocol answers with a behavior, not an option id, so the ids
 * in {@linkcode CLAUDE_APPROVAL_OPTIONS} and the decisions are one vocabulary —
 * hence no lookup table that could drift out of step. A caller naming an exact
 * option outside that set is allowed rather than denied: this channel has no
 * way to express a third outcome, and silently denying a tool the user meant
 * to run is the worse failure.
 */
function approvalDecision(decision: AdapterApprovalDecision): ApprovalDecision {
  if (typeof decision !== 'object') return decision
  return decision.optionId === 'deny' || decision.optionId === 'always-allow'
    ? decision.optionId
    : 'allow'
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
  return wireClaudeProcess(child).beginTurn(options.initialPrompt)
}

/** One continuous stdout reader, reused without restarting Claude or its agents. */
export interface ClaudeControlProcess {
  readonly closed: boolean
  readonly sessionRef: string | null
  readonly lastActivity: number
  readonly hasRunningTasks: boolean
  onBackground: ((events: AgentEvent[]) => void) | null
  onEnded: (() => void) | null
  beginTurn(prompt?: unknown, park?: () => boolean, continuing?: boolean): ClaudeControlAdapter
  shutdown(): Promise<void>
}

export function wireClaudeProcess(child: ControlProcessLike): ClaudeControlProcess {
  let killFallback: ReturnType<typeof setTimeout> | null = null
  let closed = false
  let closing = false
  let lastActivity = Date.now()
  let sessionRef: string | null = null
  const tasks = new ClaudeBackgroundTasks()
  const pendingBackground: AgentEvent[] = []
  let backgroundHandler: ClaudeControlProcess['onBackground'] = null
  let endedHandler: ClaudeControlProcess['onEnded'] = null
  interface Turn {
    queue: AgentEvent[]
    notify: (() => void) | null
    completed: boolean
    interrupted: boolean
  }
  let active: Turn | null = null
  /** request_id → tool name of live can_use_tool prompts, for always-allow rules. */
  const pendingPermissions = new Map<string, string>()

  const clearKillFallback = (): void => {
    if (killFallback !== null) {
      clearTimeout(killFallback)
      killFallback = null
    }
  }

  child.on('close', () => {
    closed = true
    clearKillFallback()
  })

  // EPIPE during teardown is routine once the CLI exits; keep it from crashing the host.
  child.stdin?.on('error', (err: Error) =>
    log.debug('claude stdin error', { message: err.message }),
  )

  /** Best-effort write; false means stdin is gone and callers must fall back. */
  const writeLine = (frame: unknown): boolean => {
    const stdin = child.stdin
    if (closed || closing || !stdin || stdin.destroyed || stdin.writableEnded) {
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
      if (active === null) {
        // A permission needs a live turn to present it; do not leave idle
        // background agents waiting forever on an invisible approval.
        writeLine(buildApprovalResponseFrame(parsed.request_id, 'deny'))
        return
      }
      pendingPermissions.set(parsed.request_id, parsed.request.tool_name ?? 'unknown')
      return
    }
    writeLine(buildUnsupportedControlResponse(parsed.request_id, parsed.request?.subtype))
  }

  const stream = streamProcessEvents(
    child,
    (line: string) => {
      try {
        answerUnhandledControl(line)
        const native = JSON.parse(line) as NativeLine
        const events = [...tasks.observe(native), ...mapClaudeLine(line)]
        return active === null
          ? events.filter((event) => event.type !== 'approval-requested')
          : events
      } catch (error) {
        return [
          {
            type: 'error',
            message: `Invalid Claude stream message: ${String(error)}`,
            rawJson: null,
          },
        ]
      }
    },
    {
      label: 'claude',
      continueAfterDone: true,
      stderrLog: (text) => log.debug('claude stderr', { text: text.slice(0, 500) }),
    },
  )

  const background = (event: AgentEvent): void => {
    if (
      event.type !== 'background-task' &&
      event.type !== 'text-delta' &&
      event.type !== 'thinking-delta' &&
      event.type !== 'tool-started' &&
      event.type !== 'tool-completed'
    )
      return
    if (backgroundHandler) backgroundHandler([event])
    else pendingBackground.push(event)
  }
  async function pump(): Promise<void> {
    try {
      for await (const event of stream) {
        lastActivity = Date.now()
        if (event.type === 'session-ref') sessionRef = event.ref
        const turn = active
        if (!turn) {
          background(event)
          continue
        }
        turn.queue.push(event)
        if (event.type === 'done') {
          turn.completed = true
          active = null
        }
        turn.notify?.()
        turn.notify = null
      }
    } finally {
      closed = true
      clearKillFallback()
      endedHandler?.()
    }
  }
  void pump().catch((error: unknown) => log.warn('claude stream failed', { error: String(error) }))

  const controls = {
    send: (frame) => {
      writeLine(frame)
    },
    respondApproval: (approvalId, decision) => {
      writeLine(
        buildApprovalResponseFrame(
          approvalId,
          approvalDecision(decision),
          pendingPermissions.get(approvalId),
        ),
      )
      pendingPermissions.delete(approvalId)
    },
  } satisfies Pick<ClaudeControlAdapter, 'send' | 'respondApproval'>

  const shutdown = (): Promise<void> => {
    closing = true
    clearKillFallback()
    return teardownChild(child)
  }
  return {
    get closed() {
      return closed || closing
    },
    get sessionRef() {
      return sessionRef
    },
    get lastActivity() {
      return lastActivity
    },
    get hasRunningTasks() {
      return tasks.running().length > 0
    },
    get onBackground() {
      return backgroundHandler
    },
    set onBackground(handler) {
      backgroundHandler = handler
      if (handler && pendingBackground.length > 0) handler(pendingBackground.splice(0))
    },
    get onEnded() {
      return endedHandler
    },
    set onEnded(handler) {
      endedHandler = handler
    },
    shutdown,
    beginTurn: (prompt, park, continuing = false) => {
      if (closed || closing || active)
        throw new Error('Claude process is unavailable for a new turn')
      const turn: Turn = {
        queue: tasks.running(),
        notify: null,
        completed: false,
        interrupted: false,
      }
      active = turn
      backgroundHandler = null
      endedHandler = null
      let parked = false
      const iterator = (async function* () {
        while (true) {
          while (turn.queue.length > 0) {
            const event = turn.queue.shift()!
            yield event
            if (event.type === 'done') return
          }
          if (closed) return
          await new Promise<void>((resolve) => {
            turn.notify = resolve
            if (turn.queue.length > 0 || closed) resolve()
          })
        }
      })()
      if (prompt !== undefined && !writeLine(prompt)) {
        active = null
        throw new Error('Claude stdin is unavailable')
      }
      return {
        ...controls,
        capabilities: () => ({
          ...CLAUDE_CAPABILITIES,
          processContinuity: park ? 'between-turns' : 'turn-only',
        }),
        start: () => ({ [Symbol.asyncIterator]: () => iterator }),
        continuesBackgroundWork: () => continuing,
        keepsBackgroundWork: () => parked,
        steer: (text) =>
          active === turn &&
          !turn.interrupted &&
          text.length > 0 &&
          writeLine(buildUserFrame(text)),
        interrupt: () => {
          turn.interrupted = true
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
        dispose: async () => {
          if (turn.completed && !turn.interrupted && !closed && !closing && park?.()) {
            parked = true
            return
          }
          await shutdown()
        },
      }
    },
  }
}

export interface ClaudeDriverOptions {
  pool?: ClaudeSessionPool | null
  /** Test seam. Production uses {@link spawnCli}. */
  spawn?: (
    binaryPath: string,
    args: string[],
    options: {
      cwd: string
      env?: Record<string, string | undefined>
      stdio: ['pipe', 'pipe', 'pipe']
      windowsHide: boolean
    },
  ) => ControlProcessLike
}

export class ClaudeDriver implements Driver {
  capabilities() {
    return {
      ...CLAUDE_CAPABILITIES,
      processContinuity: this.options.pool === null ? 'turn-only' : 'between-turns',
    } as const
  }
  readonly kind = 'claude' as const
  readonly systemInstructions = true

  hasLiveSession(sessionId: string): boolean {
    return (
      (this.options.pool === undefined ? claudeSessionPool : this.options.pool)?.has(sessionId) ??
      false
    )
  }

  constructor(
    private readonly binaryPath: string,
    private readonly options: ClaudeDriverOptions = {},
  ) {}

  create(session: AdapterSession): Promise<ProviderAdapter> {
    const pool = this.options.pool === undefined ? claudeSessionPool : this.options.pool
    const key = JSON.stringify([
      this.binaryPath,
      session.workspacePath,
      session.modelId,
      session.effort ?? null,
      session.permissionMode,
      session.instructions ?? null,
      session.runtimeEnv ?? null,
    ])
    const reused = pool?.take(session.sessionId, key, session.resumeOf) ?? null
    const spawnOptions = {
      cwd: session.workspacePath,
      ...(session.runtimeEnv ? { env: session.runtimeEnv } : {}),
      stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    }
    const child = reused
      ? null
      : this.options.spawn !== undefined
        ? this.options.spawn(this.binaryPath, buildClaudeArgs(session), spawnOptions)
        : spawnCli(this.binaryPath, buildClaudeArgs(session), spawnOptions)
    if (child) log.debug('claude spawned', { pid: child.pid })
    const process = reused ?? wireClaudeProcess(child!)

    return loadImageData(stagedImagesOf(session))
      .then(({ loaded, missing }) =>
        process.beginTurn(
          buildUserFrame(session.prompt + missingImagesNote(missing), loaded),
          pool ? () => pool.put(session.sessionId, key, process) : undefined,
          reused !== null,
        ),
      )
      .catch(async (error: unknown) => {
        await process.shutdown()
        throw error
      })
  }
}

export { claudeSessionPool, ClaudeSessionPool } from './session-pool'
