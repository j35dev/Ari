import type { DriverKind, PermissionMode } from '@ari/contracts/common'
import type { AgentEvent } from '@ari/contracts/agent-event'
import { createLogger } from '@ari/shared/logger'
import { formatUnknownError } from '@ari/shared/result'
import type { AdapterSession, Driver, ProviderAdapter } from '../driver'
import { AcpConnection, AcpConnectionError } from './connection'
import type { AcpChildProcess, AcpLaunch } from './connection'
import { AcpUpdateFolder, stopReasonEvents } from './protocol'
import type { AcpConfigOption, AcpNewSessionResult, AcpRequestPermission } from './protocol'

const log = createLogger('providers:acp')

/** Approval vocabulary shared with `approval.respond` commands. */
export type AdapterApprovalDecision = 'allow' | 'deny' | 'always-allow'

export interface AcpAdapter extends ProviderAdapter {
  /** Answers a pending `session/request_permission` originated approval. */
  respondApproval(approvalId: string, decision: AdapterApprovalDecision): void
}

/**
 * Connects the ACP agent, opens the session bound to the workspace, applies
 * model + permission-mode config options when the agent advertises them,
 * and returns an adapter whose event stream folds session updates.
 *
 * The prompt is sent on the first `start()` pull; permission requests are
 * bridged to Ari's approval flow and parked until respondApproval arrives
 * (or the turn ends/cancels).
 */
export async function createAcpAdapter(
  launch: AcpLaunch,
  session: AdapterSession,
  spawn?: (childLaunch: AcpLaunch, cwd: string) => AcpChildProcess,
): Promise<AcpAdapter> {
  const pendingPermissions = new Map<
    string,
    { options: AcpRequestPermission['options']; resolve: (outcome: unknown) => void }
  >()
  let permissionSeq = 0

  const folder = new AcpUpdateFolder()
  const queue: AgentEvent[] = []
  let notify: (() => void) | null = null
  const push = (events: AgentEvent[]): void => {
    if (events.length === 0) return
    queue.push(...events)
    notify?.()
    notify = null
  }

  const onRequestPermission = (request: AcpRequestPermission): Promise<unknown> => {
    return new Promise((resolve) => {
      const approvalId = `acp-perm-${++permissionSeq}`
      pendingPermissions.set(approvalId, { options: request.options, resolve })
      push([
        {
          type: 'approval-requested',
          approvalId,
          toolName: request.toolCall?.title ?? request.toolCall?.kind ?? 'tool',
          summaryJson: JSON.stringify({
            kind: request.toolCall?.kind ?? null,
            rawInput: request.toolCall?.rawInput ?? null,
            locations: request.toolCall?.locations ?? [],
            options: request.options ?? [],
          }),
        },
      ])
    })
  }

  let connection: AcpConnection
  try {
    connection = await AcpConnection.connect({
      launch,
      cwd: session.workspacePath,
      ...(spawn !== undefined ? { spawn } : {}),
    })
  } catch (error) {
    throw new Error(formatAcpSetupError(error), { cause: error })
  }

  connection.onRequestPermission = onRequestPermission
  connection.onSessionUpdate = (notification) => push(folder.fold(notification))

  /**
   * Resumes the agent's persisted session when possible (agent advertises
   * `loadSession` and Ari knows a prior session id) so multi-turn context
   * survives Ari's spawn-per-turn model; otherwise opens a fresh one. A load
   * failure degrades to a fresh session rather than failing the turn.
   */
  const openSession = async (): Promise<AcpNewSessionResult> => {
    const resumeId = session.resumeOf
    if (
      typeof resumeId === 'string' &&
      resumeId.length > 0 &&
      connection.initialize.agentCapabilities?.loadSession === true
    ) {
      try {
        return await connection.loadSession(resumeId, session.workspacePath)
      } catch (error) {
        log.warn('acp: session/load failed; starting a fresh session', {
          resumeId,
          error: String(error instanceof Error ? error.message : error),
        })
      }
    }
    return connection.newSession(session.workspacePath)
  }

  let created: AcpNewSessionResult
  try {
    created = await openSession()
  } catch (error) {
    connection.kill()
    throw new Error(formatAcpSetupError(error), { cause: error })
  }
  const sessionId = created.sessionId as string
  // Publish the agent's session id so Ari can resume it via session/load on
  // the next turn instead of losing all context.
  push([{ type: 'session-ref', ref: sessionId }])

  await applyModel(connection, sessionId, created.configOptions ?? [], session.modelId)
  await applyPermissionMode(connection, sessionId, created.configOptions ?? [], created.modes?.availableModes ?? [], session.permissionMode)

  const finish = (): void => {
    for (const pending of pendingPermissions.values()) pending.resolve({ outcome: { outcome: 'cancelled' } })
    pendingPermissions.clear()
    connection.kill()
  }

  // ACP has no mid-turn injection method, so steering rides out as the next
  // `session/prompt` the moment the current one reports its stop reason — one
  // continuous stream from the user's point of view, no queue-then-restart.
  const steeredTexts: string[] = []
  const launchPrompt = (text: string): void => {
    void connection
      .prompt(sessionId, text)
      .then((stopReason) => {
        const next = steeredTexts.shift()
        if (next === undefined || connection.closed) {
          push(stopReasonEvents(stopReason))
          return
        }
        log.debug('acp steering applied at turn boundary', { sessionId })
        launchPrompt(next)
      })
      .catch((error: unknown) => {
        log.debug('acp prompt failed', { error: String(error) })
        // Texts consumed as steering but never delivered must not vanish.
        const lost = steeredTexts.splice(0)
        push([
          ...(lost.length > 0
            ? ([{ type: 'error', message: `steering lost after transport failure: ${lost.join(' | ')}`, rawJson: null }] satisfies AgentEvent[])
            : []),
          { type: 'error', message: formatUnknownError(error), rawJson: null },
          { type: 'done' },
        ])
      })
  }

  const iterator = (async function* generate(): AsyncGenerator<AgentEvent, void, undefined> {
    // The turn's prompt rides out on first pull; its completion closes the stream
    // — after any steered follow-ups have been chained onto it.
    launchPrompt(session.prompt)

    while (true) {
      while (queue.length > 0) {
        const event = queue.shift()
        if (event === undefined) continue
        yield event
        if (event.type === 'done') return
      }
      if (connection.closed && queue.length === 0) {
        yield { type: 'error', message: `${launch.label} ended before completing the turn`, rawJson: null }
        yield { type: 'done' }
        return
      }
      await new Promise<void>((resolve) => {
        notify = resolve
        if (queue.length > 0 || connection.closed) resolve()
      })
    }
  })()

  return {
    start: () => ({ [Symbol.asyncIterator]: () => iterator }),
    interrupt: () => connection.cancel(sessionId),
    steer: (text) => {
      steeredTexts.push(text)
    },
    respondApproval: (approvalId, decision) => {
      const pending = pendingPermissions.get(approvalId)
      if (pending === undefined) return
      pendingPermissions.delete(approvalId)
      const kinds =
        decision === 'deny'
          ? ['reject_once', 'reject_always']
          : decision === 'always-allow'
            ? ['allow_always', 'allow_once']
            : ['allow_once', 'allow_always']
      const optionId = optionFor(pending.options, kinds)
      pending.resolve(
        optionId !== undefined
          ? { outcome: { outcome: 'selected', optionId } }
          : { outcome: { outcome: 'cancelled' } },
      )
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

function formatAcpSetupError(error: unknown): string {
  if (error instanceof AcpConnectionError) return error.message
  return `ACP transport unavailable: ${formatUnknownError(error)}`
}

/**
 * Permission options carry semantic kinds; map a decision onto whichever
 * flavor the agent offered, in priority order. Falls back to undefined so
 * the caller can cancel instead of fabricating an option id.
 */
function optionFor(
  options: AcpRequestPermission['options'],
  kinds: string[],
): string | undefined {
  const list = options ?? []
  for (const kind of kinds) {
    const match = list.find((o) => o.kind === kind && typeof o.optionId === 'string')
    if (match !== undefined) return match.optionId
  }
  return undefined
}

async function applyModel(
  connection: AcpConnection,
  sessionId: string,
  configOptions: AcpConfigOption[],
  modelId: string | null,
): Promise<void> {
  if (modelId === null || modelId === 'default') return
  const option = findOption(configOptions, 'model')
  if (option === null || option.options === undefined) return
  const value = option.options.find((v) => v.value === modelId)?.value
  if (value === undefined) {
    log.debug('acp: requested model not advertised by agent', { modelId })
    return
  }
  try {
    await connection.setConfigOption(sessionId, option.id as string, value)
  } catch (error) {
    log.debug('acp: set_config_option(model) failed', { error: String(error) })
  }
}
/**
 * Maps Ari permission modes onto whatever mode selector the agent exposes
 * (config options preferred, legacy modes fallback). Heuristic per PLAN §4:
 * unmatched agents keep their default instead of guessing wrong.
 */
async function applyPermissionMode(
  connection: AcpConnection,
  sessionId: string,
  configOptions: AcpConfigOption[],
  availableModes: { id?: string; name?: string }[],
  mode: PermissionMode,
): Promise<void> {
  const wanted = MODE_PATTERNS[mode]
  const option = findOption(configOptions, 'mode')
  if (option !== null && option.options !== undefined) {
    const match = option.options.find((v) => matchesAny(v.value, wanted))
    if (match?.value !== undefined && option.id !== undefined) {
      try {
        await connection.setConfigOption(sessionId, option.id, match.value)
      } catch (error) {
        log.debug('acp: set_config_option(mode) failed', { error: String(error) })
      }
    }
    return
  }
  const legacy = availableModes.find((m) => matchesAny(m.id, wanted))
  if (legacy?.id !== undefined) {
    try {
      await connection.setMode(sessionId, legacy.id)
    } catch (error) {
      log.debug('acp: set_mode failed', { error: String(error) })
    }
  }
}

const MODE_PATTERNS: Record<PermissionMode, RegExp[]> = {
  ask: [/\bask\b/i, /\bdefault\b/i, /\bnormal\b/i, /\bstandard\b/i, /\bplan\b/i],
  'allow-edits': [/accept.?edits?/i, /\bedit(s|ing)?\b/i, /\bworkspace\b/i],
  full: [/bypass/i, /yolo/i, /\bfull\b/i, /\bauto\b/i, /danger/i, /^code$/i],
}

function matchesAny(value: string | boolean | undefined, patterns: RegExp[]): boolean {
  return typeof value === 'string' && patterns.some((p) => p.test(value))
}

function findOption(
  configOptions: AcpConfigOption[],
  category: 'model' | 'mode',
): AcpConfigOption | null {
  return configOptions.find((o) => o.category === category && o.type === 'select') ?? null
}

/**
 * Driver that prefers the ACP transport and transparently falls back to the
 * legacy one-shot CLI driver whenever ACP is disabled, unresolvable, or its
 * connect/session handshake fails. Registration-time wiring lives in
 * {@link resolveAcpLaunch}; the fallback keeps every provider usable even
 * while adapters drift.
 */
export class AcpDriver implements Driver {
  readonly kind: DriverKind

  constructor(
    kind: DriverKind,
    private readonly launch: AcpLaunch | null,
    private readonly fallback: Driver | null,
  ) {
    this.kind = kind
  }

  async create(session: AdapterSession): Promise<ProviderAdapter> {
    if (this.launch !== null) {
      try {
        const adapter = await createAcpAdapter(this.launch, session)
        log.info('turn started over ACP', { kind: this.kind, launch: this.launch.label })
        return adapter
      } catch (error) {
        log.warn('ACP transport failed; using legacy CLI driver', {
          kind: this.kind,
          error: String(error instanceof Error ? error.message : error),
        })
      }
    }
    if (this.fallback === null) {
      throw new Error(`no transport available for ${this.kind}`)
    }
    return this.fallback.create(session)
  }
}
