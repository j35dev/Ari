import type { PermissionMode } from '@ari/contracts/common'
import type { AgentEvent } from '@ari/contracts/agent-event'
import type { Readable, Writable } from 'node:stream'
import { createLogger } from '@ari/shared/logger'
import { formatUnknownError } from '@ari/shared/result'
import { mapCodexLine, createAppServerMapper, appServerCorrelation } from './mapper'
import type { AppServerCorrelation, AppServerRequestId } from './mapper'
import { CodexNativeChildren } from './native-children'
import { AppServerConnection } from './appserver-connection'
import type { CodexChildProcess } from './appserver-connection'
import { createAppServerProbe, type AppServerProbe } from './appserver-probe'
import type { AdapterApprovalDecision, AdapterSession, Driver, ProviderAdapter } from '../driver'
import { UNKNOWN_PROVIDER_CAPABILITIES, ONE_SHOT_PROVIDER_CAPABILITIES } from '../driver'
import { promptWithAttachments } from '../attachments'
import { streamProcessEvents } from '../process-stream'
import { spawnCli, writeCliPrompt } from '../spawn-cli'
import { teardownChild } from '../teardown'

const log = createLogger('providers:codex')

/**
 * Argv for a one-shot `codex exec` turn. Approval/sandbox flags map Ari
 * permission modes onto codex's own policy flags. The reasoning level rides
 * the config override `model_reasoning_effort` — `exec` has no `--effort`
 * flag, and the picker advertises the level the native catalog probe read.
 */
export function buildCodexArgs(session: AdapterSession): string[] {
  const args = ['--json', '--skip-git-repo-check']
  if (session.modelId) args.push('--model', session.modelId)
  if (hasEffort(session.effort)) args.push('-c', `model_reasoning_effort=${session.effort}`)
  // Policy flags belong to the top-level CLI, including when resuming a turn.
  const policy = sandboxFlags(session.permissionMode)
  // `exec resume <id>` continues the thread a queued follow-up belongs to.
  // A fresh `exec` drops that thread and the agent starts over.
  // Both `exec` and `exec resume` document `-` as reading the prompt from stdin.
  if (session.resumeOf) return [...policy, 'exec', 'resume', session.resumeOf, ...args, '-']
  return [...policy, 'exec', ...args, '-']
}

/** True when the session picked a thought/reasoning level to apply. */
function hasEffort(effort: string | null | undefined): effort is string {
  return typeof effort === 'string' && effort.length > 0
}

function sandboxFlags(mode: PermissionMode): string[] {
  switch (mode) {
    case 'ask':
      return ['--ask-for-approval', 'on-request']
    case 'allow-edits':
      return ['--sandbox', 'workspace-write', '--ask-for-approval', 'on-failure']
    case 'full':
      return ['--sandbox', 'danger-full-access', '--ask-for-approval', 'never']
  }
}

/** Injectable seams for tests; production uses the defaults. */
export interface CodexDriverOptions {
  /** Capability probe; when omitted, app-server mode is skipped entirely. */
  probe?: AppServerProbe | null
  /** Legacy one-shot spawner seam; defaults to the real Windows-safe spawn. */
  spawnLegacy?: (binaryPath: string, args: string[]) => LegacyChildProcess
  /** App-server process factory seam; defaults to the real spawner. */
  spawnAppServer?: (
    binaryPath: string,
    cwd: string,
    env: Record<string, string | undefined> | undefined,
  ) => CodexChildProcess
}

/** Structural child surface the exec --json pump needs. */
export interface LegacyChildProcess {
  stdin: Writable
  stdout: Readable
  stderr: Readable
  readonly pid?: number | undefined
  readonly killed: boolean
  kill(): boolean
  on(event: 'close', listener: (code: number | null) => void): unknown
}

export class CodexDriver implements Driver {
  readonly kind = 'codex' as const

  capabilities() {
    return this.options.probe === null
      ? ONE_SHOT_PROVIDER_CAPABILITIES
      : UNKNOWN_PROVIDER_CAPABILITIES
  }

  constructor(
    private readonly binaryPath: string,
    private readonly options: CodexDriverOptions = {},
  ) {}

  async create(session: AdapterSession): Promise<ProviderAdapter> {
    // `undefined` (production `new CodexDriver(bin)`) probes the binary;
    // `null` skips app-server entirely (legacy-only tests).
    const probe = this.options.probe === undefined ? createAppServerProbe() : this.options.probe
    if (probe !== null) {
      try {
        if (await probe.supportsAppServer(this.binaryPath)) {
          const adapter = await createCodexAppServerAdapter(
            this.binaryPath,
            session,
            this.options.spawnAppServer
              ? (binaryPath, cwd, env) => this.options.spawnAppServer!(binaryPath, cwd, env)
              : undefined,
          )
          log.info('turn started over codex app-server', { sessionId: session.sessionId })
          return adapter
        }
      } catch (error) {
        log.warn('codex app-server failed; falling back to exec --json', {
          error: formatUnknownError(error),
        })
      }
    }
    return this.createLegacy(session)
  }

  /** One-shot `exec --json` transport; stdin carries the prompt, then closes. */
  private createLegacy(session: AdapterSession): ProviderAdapter {
    const args = buildCodexArgs(session)
    const child =
      this.options.spawnLegacy !== undefined
        ? this.options.spawnLegacy(this.binaryPath, args)
        : spawnCli(this.binaryPath, args, {
            cwd: session.workspacePath,
            ...(session.runtimeEnv ? { env: session.runtimeEnv } : {}),
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
          })
    log.debug('codex spawned', { pid: child.pid })
    writeCliPrompt(child.stdin, promptWithAttachments(session))

    const iterator = streamProcessEvents(child, mapCodexLine, {
      label: 'codex',
      stderrLog: (text) => log.debug('codex stderr', { text: text.slice(0, 500) }),
    })[Symbol.asyncIterator]()

    return {
      capabilities: () => ONE_SHOT_PROVIDER_CAPABILITIES,
      start: () => ({ [Symbol.asyncIterator]: () => iterator }),
      interrupt: () => {
        if (!child.killed) child.kill()
      },
      dispose: () => teardownChild(child),
    }
  }
}

/** Ari permission modes onto the app-server thread options. */
export function threadOptions(mode: PermissionMode): {
  sandbox: string | null
  approvalPolicy: string
} {
  switch (mode) {
    case 'ask':
      // Keep codex's configured sandbox default; approvals gate everything.
      return { sandbox: null, approvalPolicy: 'on-request' }
    case 'allow-edits':
      return { sandbox: 'workspace-write', approvalPolicy: 'on-request' }
    case 'full':
      return { sandbox: 'danger-full-access', approvalPolicy: 'never' }
  }
}

export interface CodexAppServerAdapter extends ProviderAdapter {
  respondApproval(approvalId: string, decision: AdapterApprovalDecision): void
  /** False when there is no live turn or the server refused the steer. */
  steer(text: string): Promise<boolean>
  /** Bounded, transient wire evidence; child output never becomes root prose. */
  diagnostics(): CodexFrameDiagnostic[]
}

export interface CodexFrameDiagnostic extends AppServerCorrelation {
  requestId: AppServerRequestId | null
  method: string
  disposition: 'child' | 'native-collaboration' | 'stale' | 'unscoped' | 'unsupported'
  rawJson: string
  /** Large payloads retain their identity and the start of their wire frame. */
  truncated?: boolean
}

/**
 * Maps the coarse decision vocabulary onto the server's decision ids, for
 * callers that never learned which options this request offered. Callers
 * holding the offered list answer with the exact id instead.
 */
const APPROVAL_DECISIONS = {
  allow: 'accept',
  'always-allow': 'acceptForSession',
  deny: 'decline',
} as const

function serverDecision(decision: AdapterApprovalDecision): string {
  // The ids ARE the server's vocabulary, so an exact answer needs no mapping —
  // including for decisions `APPROVAL_DECISIONS` has no name for, like cancel.
  return typeof decision === 'string' ? APPROVAL_DECISIONS[decision] : decision.optionId
}

/**
 * Live adapter over one `codex app-server` process for a single turn:
 * initialize → thread/start|thread/resume → turn/start, folding server
 * notifications into AgentEvents until turn/completed. Approval prompts are
 * parked until {@linkcode respondApproval}; steering rides `turn/steer`.
 */
export async function createCodexAppServerAdapter(
  binaryPath: string,
  session: AdapterSession,
  spawn?: (
    binaryPath: string,
    cwd: string,
    env: Record<string, string | undefined> | undefined,
  ) => CodexChildProcess,
): Promise<CodexAppServerAdapter> {
  const mapper = createAppServerMapper()
  const connection = AppServerConnection.start({
    binaryPath,
    ...(session.runtimeEnv ? { env: session.runtimeEnv } : {}),
    cwd: session.workspacePath,
    ...(spawn !== undefined ? { spawn } : {}),
  })

  const queue: AgentEvent[] = []
  let notify: (() => void) | null = null
  const push = (events: AgentEvent[]): void => {
    if (events.length === 0) return
    queue.push(...events)
    notify?.()
    notify = null
  }

  const pendingApprovals = new Map<
    string,
    { requestId: AppServerRequestId; correlation: AppServerCorrelation }
  >()
  const releaseApprovals = (threadId: string, turnId: string | null): void => {
    for (const [approvalId, pending] of pendingApprovals) {
      if (
        pending.correlation.threadId !== threadId ||
        (pending.correlation.turnId !== null && pending.correlation.turnId !== turnId)
      )
        continue
      connection.respond(pending.requestId, { decision: 'decline' })
      pendingApprovals.delete(approvalId)
    }
  }
  const children = new CodexNativeChildren()
  const expireChildApprovals = (): void => {
    for (const [approvalId, pending] of pendingApprovals) {
      const { threadId, turnId } = pending.correlation
      if (
        threadId === null ||
        threadId === rootThreadId ||
        children.acceptsRequest(threadId, turnId)
      )
        continue
      connection.respond(pending.requestId, { decision: 'decline' })
      pendingApprovals.delete(approvalId)
    }
  }
  const diagnostics: CodexFrameDiagnostic[] = []
  const diagnose = (
    line: string,
    method: string,
    disposition: CodexFrameDiagnostic['disposition'],
  ) => {
    const correlation = appServerCorrelation(parseParams(line))
    const id = (JSON.parse(line) as { id?: unknown }).id
    diagnostics.push({
      ...correlation,
      requestId: typeof id === 'string' || typeof id === 'number' ? id : null,
      method,
      disposition,
      rawJson: line.slice(0, 64_000),
      ...(line.length > 64_000 ? { truncated: true } : {}),
    })
    // Keep evidence bounded by count and bytes; do not persist child content.
    while (
      diagnostics.length > 200 ||
      diagnostics.reduce((size, frame) => size + frame.rawJson.length, 0) > 1_000_000
    ) {
      diagnostics.shift()
    }
    log.debug('codex correlated frame', { ...correlation, method, disposition })
  }
  let rootThreadId: string | null = null
  let activeTurnId: string | null = null
  let startRequested = false
  let startConfirmed = false
  let rootTurnStarted = false
  let interrupted = false
  let terminal = false
  let disposed = false
  const beforeThread: string[] = []
  const beforeTurn: string[] = []

  const handleFrame = (line: string): void => {
    if (rootThreadId === null) {
      beforeThread.push(line)
      return
    }
    const params = parseParams(line)
    const correlation = appServerCorrelation(params)
    const frame = JSON.parse(line) as { method?: string; id?: AppServerRequestId }
    const requestId = typeof frame.id === 'number' || typeof frame.id === 'string' ? frame.id : null
    const method = frame.method ?? ''
    if (terminal || disposed) {
      diagnose(line, method, 'stale')
      return
    }
    if (correlation.threadId === null) {
      diagnose(line, method, 'unscoped')
      if (requestId !== null)
        connection.reject(requestId, -32602, 'Request has no thread ownership')
      return
    }
    const isRoot = correlation.threadId === rootThreadId
    if (isRoot) {
      // Only the start/resume response owns the persisted resume reference.
      if (method === 'thread/started') return
      if (!startRequested && method !== 'thread/tokenUsage/updated') {
        diagnose(line, method, 'stale')
        return
      }
      if (startRequested && !startConfirmed) {
        beforeTurn.push(line)
        return
      }
      if (method === 'turn/started' && activeTurnId === null) activeTurnId = correlation.turnId
      if (
        (correlation.turnId !== null && correlation.turnId !== activeTurnId) ||
        ((method === 'turn/completed' || method === 'turn/started') &&
          correlation.turnId === null) ||
        (method === 'turn/completed' && activeTurnId === null)
      ) {
        diagnose(line, method, 'stale')
        if (requestId !== null)
          connection.reject(requestId, -32602, 'Request belongs to an inactive turn')
        return
      }
    } else {
      diagnose(line, method, 'child')
      if (
        requestId !== null &&
        method.endsWith('/requestApproval') &&
        !children.acceptsRequest(correlation.threadId, correlation.turnId)
      ) {
        diagnose(line, method, 'stale')
        connection.reject(requestId, -32602, 'Request belongs to an inactive child turn')
        return
      }
      push(children.observe(method, params))
      expireChildApprovals()
      if (method === 'turn/completed') releaseApprovals(correlation.threadId, correlation.turnId)
      // Child messages, context, usage, references and terminals never enter
      // the root mapper, including its stateful item/usage de-duplication.
      if (requestId === null) return
    }
    if (isRoot && method === 'turn/started') rootTurnStarted = true
    if (isRoot && (method === 'item/started' || method === 'item/completed')) {
      if ((params['item'] as { type?: string } | undefined)?.type === 'collabAgentToolCall') {
        diagnose(line, method, 'native-collaboration')
      }
      push(children.observeCollaboration(params))
      expireChildApprovals()
    }
    const inbound = mapper.mapLine(line)
    if (inbound.kind === 'server-request') {
      if (inbound.approvalId === null) {
        diagnose(line, method, 'unsupported')
        connection.reject(inbound.requestId, -32601, `Ari does not support ${method}`)
        push([
          {
            type: 'notice',
            message: `Unsupported Codex request ${method} (thread ${correlation.threadId}).`,
          },
        ])
        return
      }
      // Include the wire request as well as its full ownership. Two threads
      // may reuse item ids, and a later request may revisit the same item.
      const approvalId = `codex-appr-${encodeURIComponent(
        JSON.stringify([
          correlation.threadId,
          correlation.turnId,
          correlation.itemId,
          inbound.requestId,
        ]),
      )}`
      pendingApprovals.set(approvalId, { requestId: inbound.requestId, correlation })
      push(
        inbound.events.map((event) =>
          event.type === 'approval-requested'
            ? {
                ...event,
                approvalId,
                ...{
                  providerThreadId: correlation.threadId!,
                  ...(correlation.turnId ? { providerTurnId: correlation.turnId } : {}),
                  ...(correlation.itemId ? { providerItemId: correlation.itemId } : {}),
                },
              }
            : event,
        ),
      )
      return
    }
    if (inbound.kind === 'notification' && method === 'turn/completed') {
      terminal = true
      activeTurnId = null
      const status = (params['turn'] as { status?: string } | undefined)?.status
      push(children.end())
      push(
        inbound.events.map((event) =>
          event.type === 'done'
            ? {
                ...event,
                ...(['completed', 'interrupted', 'failed'].includes(status ?? '')
                  ? {
                      stopReason:
                        status === 'interrupted'
                          ? 'interrupted'
                          : status === 'failed'
                            ? 'error'
                            : 'completed',
                    }
                  : {}),
              }
            : event,
        ),
      )
      return
    }
    push(inbound.events)
  }
  connection.onFrame = handleFrame
  // EOF must wake the iterator even when no RPC is pending to reject.
  void connection.waitClosed().then(() => {
    notify?.()
    notify = null
  })

  const startupRequest = (method: string, params: unknown, timeoutMs: number): Promise<unknown> =>
    connection.request(method, params, timeoutMs).catch((error: unknown) => {
      connection.kill()
      throw error
    })
  await startupRequest(
    'initialize',
    { clientInfo: { name: 'ari', version: '0.1.0' }, capabilities: {} },
    15_000,
  )

  const options = threadOptions(session.permissionMode)
  const baseThreadParams: Record<string, unknown> = {
    cwd: session.workspacePath,
    approvalPolicy: options.approvalPolicy,
    ...(options.sandbox !== null ? { sandbox: options.sandbox } : {}),
    ...(session.modelId !== null && session.modelId !== 'default'
      ? { model: session.modelId }
      : {}),
  }
  const threadResult = (await startupRequest(
    session.resumeOf !== null ? 'thread/resume' : 'thread/start',
    session.resumeOf !== null
      ? { ...baseThreadParams, threadId: session.resumeOf }
      : baseThreadParams,
    30_000,
  )) as { thread?: { id?: string }; threadId?: string } | null
  const threadId =
    typeof threadResult?.thread?.id === 'string'
      ? threadResult.thread.id
      : typeof threadResult?.threadId === 'string'
        ? threadResult.threadId
        : null
  if (threadId === null) {
    connection.kill()
    throw new Error('codex app-server returned no thread id')
  }
  rootThreadId = threadId
  push([{ type: 'session-ref', ref: threadId }])
  for (const line of beforeThread.splice(0)) handleFrame(line)

  const finish = (): void => {
    disposed = true
    activeTurnId = null
    for (const { requestId } of pendingApprovals.values()) {
      connection.respond(requestId, { decision: 'decline' })
    }
    pendingApprovals.clear()
    connection.kill()
  }

  const iterator = (async function* generate(): AsyncGenerator<AgentEvent, void, undefined> {
    // The user turn rides out on first pull; its completion closes the stream.
    startRequested = true
    void connection
      .request('turn/start', {
        threadId,
        input: [{ type: 'text', text: promptWithAttachments(session) }],
        ...(session.modelId !== null && session.modelId !== 'default'
          ? { model: session.modelId }
          : {}),
        // turn/start's `effort` carries forward to later turns on this thread,
        // which is where the picker's reasoning level has to land.
        ...(hasEffort(session.effort) ? { effort: session.effort } : {}),
      })
      .then((result) => {
        if (terminal || disposed) return
        const turn = (result as { turn?: { id?: string } } | null)?.turn
        if (typeof turn?.id === 'string') activeTurnId = turn.id
        startConfirmed = true
        // Notifications may precede the response. Replay only after its
        // authoritative turn id is known, so old completions cannot win.
        for (const line of beforeTurn.splice(0)) handleFrame(line)
        if (!rootTurnStarted && activeTurnId !== null && !terminal) {
          // Some servers confirm the turn only in the response. Resumed
          // baseline updates replayed before it remain history, while future
          // usage belongs to this confirmed turn.
          mapper.mapLine(
            JSON.stringify({
              method: 'turn/started',
              params: {
                threadId,
                turn: { id: activeTurnId },
              },
            }),
          )
          rootTurnStarted = true
        }
      })
      .catch((error: unknown) => {
        if (terminal || disposed) return
        terminal = true
        activeTurnId = null
        log.debug('codex turn/start failed', { error: String(error) })
        push([
          { type: 'error', message: formatUnknownError(error), rawJson: null },
          { type: 'done' },
        ])
      })

    while (true) {
      while (queue.length > 0) {
        const event = queue.shift()
        if (event === undefined) continue
        yield event
        if (event.type === 'done') {
          finish()
          return
        }
      }
      if (connection.closed && queue.length === 0) {
        push(children.end())
        if (interrupted) {
          const done: AgentEvent & { stopReason: 'interrupted' } = {
            type: 'done',
            stopReason: 'interrupted',
          }
          push([done])
        } else {
          push([
            {
              type: 'error',
              message: 'codex app-server ended before completing the turn',
              rawJson: null,
            },
            { type: 'done', ...{ stopReason: 'error' } },
          ])
        }
        continue
      }
      await new Promise<void>((resolve) => {
        notify = resolve
        // Re-check after subscribing to avoid missed-notification races.
        if (queue.length > 0 || connection.closed) resolve()
      })
    }
  })()

  return {
    capabilities: () => ({
      ...ONE_SHOT_PROVIDER_CAPABILITIES,
      steering: 'live',
      liveResponses: 'approvals',
      terminalStatus: 'explicit',
      nativeChildren: {
        visibility: 'lifecycle',
        inspect: false,
        message: false,
        stop: false,
        approvals: true,
      },
    }),
    diagnostics: () => diagnostics.map((frame) => ({ ...frame })),
    start: () => ({ [Symbol.asyncIterator]: () => iterator }),
    interrupt: () => {
      if (terminal || disposed) return
      interrupted = true
      if (activeTurnId === null) {
        finish()
        return
      }
      // The turn/completed(interrupted) notification closes the stream.
      void connection
        .request('turn/interrupt', { threadId, turnId: activeTurnId }, 10_000)
        .catch((error: unknown) => {
          log.debug('codex interrupt failed', { error: String(error) })
          finish()
        })
    },
    respondApproval: (approvalId, decision) => {
      const pending = pendingApprovals.get(approvalId)
      if (pending === undefined || terminal || disposed) return
      pendingApprovals.delete(approvalId)
      connection.respond(pending.requestId, { decision: serverDecision(decision) })
    },
    steer: async (text) => {
      if (activeTurnId === null || terminal || disposed || connection.closed) {
        log.debug('codex steer ignored: no active turn')
        return false
      }
      try {
        await connection.request(
          'turn/steer',
          {
            threadId,
            expectedTurnId: activeTurnId,
            input: [{ type: 'text', text }],
          },
          10_000,
        )
        return true
      } catch (error: unknown) {
        // Report the failure to the caller instead of pushing an error event:
        // an error event settles the whole turn as `error`, which holds the
        // queue — stranding the very message we just failed to deliver. The
        // message stays queued and runs as the follow-up turn.
        log.debug('codex steer failed', { error: formatUnknownError(error) })
        return false
      }
    },
    dispose: async () => {
      finish()
      await Promise.race([
        connection.waitClosed(),
        new Promise<void>((resolve) => setTimeout(resolve, 1000).unref?.()),
      ])
    },
  }
}

function parseParams(line: string): Record<string, unknown> {
  try {
    const frame = JSON.parse(line) as Record<string, unknown>
    return (frame['params'] ?? {}) as Record<string, unknown>
  } catch {
    return {}
  }
}
