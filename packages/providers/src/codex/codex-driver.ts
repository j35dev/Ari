import type { PermissionMode } from '@ari/contracts/common'
import type { AgentEvent } from '@ari/contracts/agent-event'
import type { Readable } from 'node:stream'
import { createLogger } from '@ari/shared/logger'
import { formatUnknownError } from '@ari/shared/result'
import { mapCodexLine, createAppServerMapper } from './mapper'
import type { AppServerInbound } from './mapper'
import { AppServerConnection } from './appserver-connection'
import type { CodexChildProcess } from './appserver-connection'
import { createAppServerProbe, type AppServerProbe } from './appserver-probe'
import type { AdapterApprovalDecision, AdapterSession, Driver, ProviderAdapter } from '../driver'
import { streamProcessEvents } from '../process-stream'
import { spawnCli } from '../spawn-cli'
import { teardownChild } from '../teardown'

const log = createLogger('providers:codex')

/**
 * Argv for a one-shot `codex exec` turn. Approval/sandbox flags map Ari
 * permission modes onto codex's own policy flags.
 */
export function buildCodexArgs(session: AdapterSession): string[] {
  const args = ['exec', '--json', '--skip-git-repo-check']
  if (session.modelId) args.push('--model', session.modelId)
  args.push(...sandboxFlags(session.permissionMode))
  args.push(session.prompt)
  return args
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
  spawnAppServer?: (binaryPath: string, cwd: string) => CodexChildProcess
}

/** Structural child surface the exec --json pump needs. */
export interface LegacyChildProcess {
  stdout: Readable
  stderr: Readable
  readonly pid?: number | undefined
  readonly killed: boolean
  kill(): boolean
  on(event: 'close', listener: (code: number | null) => void): unknown
}

export class CodexDriver implements Driver {
  readonly kind = 'codex' as const

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
            this.options.spawnAppServer,
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

  /** One-shot `exec --json` transport; stdin is not writable in this mode. */
  private createLegacy(session: AdapterSession): ProviderAdapter {
    const child =
      this.options.spawnLegacy !== undefined
        ? this.options.spawnLegacy(this.binaryPath, buildCodexArgs(session))
        : spawnCli(this.binaryPath, buildCodexArgs(session), {
            cwd: session.workspacePath,
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
          })
    log.debug('codex spawned', { pid: child.pid })

    const iterator = streamProcessEvents(child, mapCodexLine, {
      label: 'codex',
      stderrLog: (text) => log.debug('codex stderr', { text: text.slice(0, 500) }),
    })[Symbol.asyncIterator]()

    return {
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
  steer(text: string): void
}

const APPROVAL_DECISIONS: Record<AdapterApprovalDecision, string> = {
  allow: 'accept',
  'always-allow': 'acceptForSession',
  deny: 'decline',
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
  spawn?: (binaryPath: string, cwd: string) => CodexChildProcess,
): Promise<CodexAppServerAdapter> {
  const mapper = createAppServerMapper()
  const connection = AppServerConnection.start({
    binaryPath,
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

  const pendingApprovals = new Map<string, number>()
  let activeTurnId: string | null = null

  connection.onFrame = (line: string) => {
    const inbound: AppServerInbound = mapper.mapLine(line)
    if (inbound.kind === 'server-request' && inbound.approvalId !== null) {
      pendingApprovals.set(inbound.approvalId, inbound.requestId)
    } else if (inbound.kind === 'notification' && inbound.method === 'turn/started') {
      const turn = parseParams(line)['turn'] as { id?: unknown } | undefined
      if (typeof turn?.['id'] === 'string') activeTurnId = turn['id']
    }
    push(inbound.events)
  }

  await connection.request(
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
  const threadResult = (await connection.request(
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
  push([{ type: 'session-ref', ref: threadId }])

  const finish = (): void => {
    for (const requestId of pendingApprovals.values()) {
      connection.respond(requestId, { decision: 'decline' })
    }
    pendingApprovals.clear()
    connection.kill()
  }

  const iterator = (async function* generate(): AsyncGenerator<AgentEvent, void, undefined> {
    // The user turn rides out on first pull; its completion closes the stream.
    void connection
      .request('turn/start', {
        threadId,
        input: [{ type: 'text', text: session.prompt }],
        ...(session.modelId !== null && session.modelId !== 'default'
          ? { model: session.modelId }
          : {}),
      })
      .then((result) => {
        const turn = (result as { turn?: { id?: string } } | null)?.turn
        if (typeof turn?.id === 'string') activeTurnId = turn.id
      })
      .catch((error: unknown) => {
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
        push([
          { type: 'error', message: 'codex app-server ended before completing the turn', rawJson: null },
          { type: 'done' },
        ])
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
    start: () => ({ [Symbol.asyncIterator]: () => iterator }),
    interrupt: () => {
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
      const requestId = pendingApprovals.get(approvalId)
      if (requestId === undefined) return
      pendingApprovals.delete(approvalId)
      connection.respond(requestId, { decision: APPROVAL_DECISIONS[decision] })
    },
    steer: (text) => {
      if (activeTurnId === null) {
        log.debug('codex steer ignored: no active turn')
        return
      }
      void connection
        .request(
          'turn/steer',
          {
            threadId,
            expectedTurnId: activeTurnId,
            input: [{ type: 'text', text }],
          },
          10_000,
        )
        .catch((error: unknown) => {
          push([{ type: 'error', message: `steering failed: ${formatUnknownError(error)}`, rawJson: null }])
        })
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
