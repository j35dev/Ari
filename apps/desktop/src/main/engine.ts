import { existsSync } from 'node:fs'
import type { AttachmentRef } from '@ari/contracts/attachments'
import type { Command } from '@ari/contracts/commands'
import type { JournalEvent } from '@ari/contracts/events'
import type { Session } from '@ari/contracts/session'
import type { MessageOrigin } from '@ari/contracts/message'
import { decideCommand } from '@ari/engine/dispatcher'
import type { DispatchIds } from '@ari/engine/dispatcher'
import type { UnstampedEvent } from '@ari/engine/projection'
import type { SessionStore } from '@ari/engine/session-store'
import { resolveSessionWorkspace } from '@ari/engine/workspace'
import { deterministicTitleStrategy, isAutoTitle } from '@ari/engine/title'
import type { TitleStrategy } from '@ari/engine/title'
import { newTypedId } from '@ari/shared/ids'
import { createLogger } from '@ari/shared/logger'
import type { DriverRegistry } from '@ari/providers/registry'
import type { AdapterApprovalDecision } from '@ari/providers/driver'

const log = createLogger('desktop:engine')

function attributedInput(text: string, origin?: MessageOrigin): string {
  return origin?.kind === 'session'
    ? `[Ari message from session ${origin.sessionId}]\n\n${text}`
    : text
}

function inputKey(text: string, origin?: MessageOrigin): string {
  return JSON.stringify([text, origin ?? null])
}

export interface CheckpointCapturer {
  captureCheckpoint(
    cwd: string,
    sessionId: string,
    turnId: string,
  ): Promise<{ ok: true; value: string | null } | { ok: false; error: { message: string } }>
  /**
   * Best-effort GC of hidden checkpoint refs, keeping the newest
   * `maxPerSession` per session. Returns the deleted refs. Optional so
   * test doubles can omit it.
   */
  pruneCheckpoints?(
    cwd: string,
    sessionId: string,
    maxPerSession: number,
  ): Promise<{ ok: true; value: string[] } | { ok: false; error: { message: string } }>
}

/** Upper bound on stored checkpoints per session before oldest are pruned. */
const MAX_CHECKPOINTS_PER_SESSION = 50

export interface EngineDeps {
  store: SessionStore
  registry: DriverRegistry
  /** Delivers a journal event to live subscribers of that session. */
  publish: (sessionId: string, event: JournalEvent) => void
  /** Checkpoint source; defaults to the real GitService. */
  git?: CheckpointCapturer
  /**
   * Maps a session's projectId to a workspace folder. Absent for tests: the
   * legacy fallback treats 'adhoc' as process.cwd() and any other id as a
   * literal path.
   */
  resolveWorkspace?: (projectId: string) => Promise<string | null>
  runtimeEnvironment?: (session: Session) => Promise<Record<string, string | undefined>>
  respondControlApproval?: (id: string, decision: AdapterApprovalDecision) => boolean
  authorizeTurn?: (session: Session) => Promise<string | null>
  /**
   * Resolves a staged attachment id to its disk path for adapters. Absent
   * for tests: attachments resolve as unavailable and are named in text.
   */
  resolveAttachmentPath?: (id: string) => Promise<string | null>
  /**
   * Upgrades the auto-slice title after the first settled turn (M18.2).
   * Defaults to the deterministic strategy; an LLM-backed one can be
   * injected without touching the turn flow. Failures never surface.
   */
  titleStrategy?: TitleStrategy
}

interface ActiveTurn {
  sessionId: string
  turnId: string
  interrupt: () => void
  /** Forwards approval decisions into the live adapter (M16.8). */
  respondApproval: (approvalId: string, decision: AdapterApprovalDecision) => void
  /** Forwards an answered agent question into the live adapter. */
  respondInput: (inputId: string, value: string) => void
  /**
   * Forwards mid-turn steering text into the live adapter (M17.1). Returns
   * true when the adapter consumed the text as steering (providers with a
   * writable control channel) — those messages must not re-run as a follow-up
   * turn; false when the transport cannot steer and the text stays queued.
   */
  steer: (text: string) => boolean
}

/**
 * The session engine: validates commands through the pure decider, persists
 * the decided events to journals, executes provider side effects, and
 * streams every appended event to subscribers.
 */
export class Engine {
  readonly #commands = new Map<string, Promise<unknown>>()
  readonly #deps: EngineDeps
  readonly #activeTurns = new Map<string, ActiveTurn>()
  readonly #turnTasks = new Map<string, Promise<void>>()
  readonly #capacityBlockedQueues = new Map<string, Set<string>>()

  /** Waits for provider disposal, including interrupted startup, before reading worker files. */
  async quiesce(sessionId: string): Promise<void> {
    await this.#turnTasks.get(sessionId)
  }

  /** Includes providers still disposing after a durable settle. */
  hasLiveTurn(sessionId: string): boolean {
    return this.#turnTasks.has(sessionId)
  }
  /**
   * Texts consumed as mid-turn steering, per session. The queue-drain runs
   * serialized with command dispatch (same per-root chain), so a steered
   * message's dequeue is always ordered with the drain's queue snapshot —
   * the drain skips these keys and can never re-run an already-steered
   * message as a follow-up turn.
   */
  readonly #steeredTexts = new Map<string, Set<string>>()
  /** Sessions whose first non-error settle already ran title generation. */
  readonly #titleSettled = new Set<string>()

  constructor(deps: EngineDeps) {
    this.#deps = deps
  }

  async dispatch(
    command: Command,
    origin?: MessageOrigin,
  ): Promise<{ accepted: boolean; reason?: string }> {
    const target =
      'sessionId' in command ? (await this.#deps.store.load(command.sessionId)).session : null
    const id = target?.rootSessionId ?? ('sessionId' in command ? command.sessionId : '-')
    return this.#chain(id, () => this.#dispatch(command, origin))
  }

  /** Serializes work per root session tree: commands and queue drains share one chain. */
  #chain<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const result = (this.#commands.get(id) ?? Promise.resolve())
      .catch(() => undefined)
      .then(fn)
    this.#commands.set(id, result)
    void result
      .finally(() => {
        if (this.#commands.get(id) === result) this.#commands.delete(id)
      })
      .catch(() => undefined)
    return result
  }

  /** Creates a normal session through the same journal and publication path as turns. */
  async createSession(session: Session): Promise<void> {
    await this.#append(session.id, { type: 'session.created', session })
  }

  /** Durable lifecycle write for the scoped control service. */
  record(sessionId: string, event: UnstampedEvent): Promise<JournalEvent> {
    return this.#append(sessionId, event)
  }

  async #dispatch(
    command: Command,
    origin?: MessageOrigin,
  ): Promise<{ accepted: boolean; reason?: string }> {
    if (!('sessionId' in command)) {
      return { accepted: false, reason: 'session.create is handled by the store' }
    }
    const model = await this.#deps.store.load(command.sessionId)
    if (command.type === 'turn.start' && model.session && this.#deps.authorizeTurn) {
      const reason = await this.#deps.authorizeTurn(model.session)
      if (reason) return { accepted: false, reason }
    }
    const ids: DispatchIds = {
      turnId: newTypedId('turn'),
      messageId: newTypedId('msg'),
    }
    const decision = decideCommand(model, command, ids, origin)
    if (!decision.accepted) {
      return { accepted: false, reason: decision.reason }
    }
    let releaseTurn: ((persisted: boolean) => void) | undefined
    if (command.type === 'turn.start') {
      const previous = this.#turnTasks.get(command.sessionId) ?? Promise.resolve()
      const gate = new Promise<boolean>((resolve) => {
        releaseTurn = resolve
      })
      const task = previous
        .then(() => gate)
        .then((persisted) =>
          persisted
            ? this.#runTurn(
                model.session as Session,
                attributedInput(command.text, origin),
                command.attachments ?? [],
                ids.turnId,
                model.providerSessionId?.startsWith('imported:') ? null : model.providerSessionId,
              )
            : undefined,
        )
        .catch((e) => {
          log.error('turn execution crashed', { error: String(e) })
        })
      this.#turnTasks.set(command.sessionId, task)
      void task.then(() => {
        if (this.#turnTasks.get(command.sessionId) === task) {
          this.#turnTasks.delete(command.sessionId)
          this.#retryCapacityBlockedQueues(model.session?.rootSessionId ?? command.sessionId)
        }
      })
    }

    try {
      for (const event of decision.events) {
        await this.#append(command.sessionId, event)
      }
    } catch (error) {
      releaseTurn?.(false)
      throw error
    }
    releaseTurn?.(true)

    if (command.type === 'turn.interrupt') {
      this.#activeTurns.get(command.sessionId)?.interrupt()
      this.#onFirstSettle(command.sessionId)
    }

    if (command.type === 'approval.respond') {
      if (this.#deps.respondControlApproval?.(command.approvalId, command.decision))
        return { accepted: true }
      // Route the decision to the live adapter so in-band approval protocols
      // (claude stdin control, ACP request_permission) actually proceed —
      // previously the decision was only journaled and the provider hung.
      this.#activeTurns
        .get(command.sessionId)
        ?.respondApproval(command.approvalId, command.decision)
    }

    if (command.type === 'input.respond') {
      this.#activeTurns.get(command.sessionId)?.respondInput(command.inputId, command.value)
    }

    if (command.type === 'message.enqueue') {
      // A user message arriving behind a running turn steers that turn in
      // providers with a writable control channel (claude stdin, ACP) — the
      // text is consumed mid-turn, so it is dequeued immediately and must
      // never re-run as a follow-up turn. Transports without steering keep
      // the message queued; settle dispatches it as the next turn. Messages
      // carrying images never steer: steering is text-only, so they stay
      // queued and run as the follow-up turn with their images intact.
      const attachments = command.attachments ?? []
      const steered =
        attachments.length === 0
          ? (this.#activeTurns
              .get(command.sessionId)
              ?.steer(attributedInput(command.text, origin)) ?? false)
          : false
      if (steered) {
        let consumed = this.#steeredTexts.get(command.sessionId)
        if (consumed === undefined) {
          consumed = new Set()
          this.#steeredTexts.set(command.sessionId, consumed)
        }
        consumed.add(inputKey(command.text, origin))
        await this.#append(command.sessionId, {
          type: 'message.dequeued',
          text: command.text,
          attachments,
          ...(origin ? { origin } : {}),
        })
        // Dequeue used to make the follow-up vanish: it left the queue and
        // never became a transcript row. Journal it as a user message so the
        // session shows what the adapter just consumed.
        await this.#append(command.sessionId, {
          type: 'user.message.added',
          message: {
            id: ids.messageId,
            sessionId: command.sessionId,
            turnId: model.activeTurnId,
            role: 'user',
            ...(origin ? { origin } : {}),
            parts: command.text.length > 0 ? [{ type: 'text', text: command.text }] : [],
            createdAt: Date.now(),
          },
        })
      } else {
        // The turn may have settled concurrently after this dispatch's
        // snapshot saw it active: the message is journaled as queued but no
        // settle-drain will cover it. Schedule a serialized drain so a
        // post-settle enqueue self-heals instead of stranding.
        this.#scheduleQueueDrain(command.sessionId, model.session?.rootSessionId ?? null)
      }
    }

    if (command.type === 'checkpoint.revert') {
      const ref = model.checkpoints.find((c) => c.turnId === command.turnId)?.gitRef
      const session = model.session
      const ws = session === null ? null : await this.workspace(session)
      if (ref !== undefined && ws !== null) {
        const { GitService } = await import('@ari/engine/git')
        const result = await new GitService().revertToRef(ws, ref)
        if (!result.ok) {
          log.error('checkpoint revert failed', { error: result.error.message })
        }
      }
    }

    return { accepted: true }
  }

  async #append(sessionId: string, event: UnstampedEvent): Promise<JournalEvent> {
    const stamped = await this.#deps.store.append(sessionId, event)
    this.#deps.publish(sessionId, stamped)
    if (event.type === 'turn.settled') {
      const parentId = (await this.#deps.store.load(sessionId)).session?.parentSessionId
      if (parentId)
        await this.#append(parentId, {
          type: 'child.session.settled',
          childSessionId: sessionId,
          turnId: event.turnId,
          stopReason: event.stopReason,
        })
    }
    return stamped
  }

  /** Resolves the workspace folder for a session; null when unresolvable. */
  async #workspaceFor(projectId: string): Promise<string | null> {
    if (!this.#deps.resolveWorkspace) {
      // Legacy/test fallback: the id doubles as a literal path, unchecked.
      return projectId === 'adhoc' ? process.cwd() : projectId
    }
    const resolved = await this.#deps.resolveWorkspace(projectId)
    if (resolved !== null && !existsSync(resolved)) return null
    return resolved
  }

  /** Authoritative cwd for providers, checkpoints, control operations and the UI. */
  workspace(session: Session): Promise<string | null> {
    return resolveSessionWorkspace(
      session,
      (id) => this.#workspaceFor(id),
      async (id) => (await this.#deps.store.load(id)).session,
    )
  }

  /**
   * Runs one provider turn: spawns the adapter, maps normalized agent events
   * into journal parts (coalescing text), and settles the turn. `resumeOf`
   * carries the provider-native session/thread id observed on a previous
   * turn, so follow-up prompts continue the same provider thread.
   */
  async #runTurn(
    session: Session,
    prompt: string,
    attachments: AttachmentRef[],
    turnId: string,
    resumeOf: string | null,
  ): Promise<void> {
    const driver = this.#deps.registry.get(session.driverKind)
    if (!driver) {
      await this.#settle(
        session.id,
        turnId,
        'error',
        `no driver registered for ${session.driverKind}`,
      )
      return
    }

    const workspacePath = await this.workspace(session)
    if (workspacePath === null) {
      await this.#settle(
        session.id,
        turnId,
        'error',
        `workspace folder not found for project ${session.projectId} — add the folder in Projects and try again`,
      )
      return
    }
    // Bracket the turn with a checkpoint when the workspace is a git repo
    // (PLAN §3). captureCheckpoint returns null outside repos; failures are
    // non-fatal — checkpoints are best-effort.
    const git = this.#deps.git ?? (await import('@ari/engine/git')).newDefaultCapturer()
    const captured = await git.captureCheckpoint(workspacePath, session.id, turnId)
    if (captured.ok && captured.value !== null) {
      await this.#append(session.id, {
        type: 'checkpoint.captured',
        turnId,
        gitRef: captured.value,
      })
      // M8.10: cap stored checkpoints per session. Pruning is event-sourced
      // (checkpoint.pruned folds the projection) and best-effort.
      const prune = git.pruneCheckpoints?.bind(git)
      if (prune) {
        const pruned = await prune(workspacePath, session.id, MAX_CHECKPOINTS_PER_SESSION)
        if (pruned.ok) {
          for (const ref of pruned.value) {
            const turnId = ref.slice(ref.lastIndexOf('/') + 1)
            if (turnId.length > 0) {
              await this.#append(session.id, { type: 'checkpoint.pruned', turnId, gitRef: ref })
            }
          }
        }
      }
    }

    let adapter
    try {
      if ((await this.#deps.store.load(session.id)).activeTurnId !== turnId) return
      const runtimeEnv = await this.#deps.runtimeEnvironment?.(session)
      adapter = await driver.create({
        ...(runtimeEnv ? { runtimeEnv } : {}),
        sessionId: session.id,
        workspacePath,
        prompt:
          runtimeEnv?.ARI_ENV === '1'
            ? `[Ari control surface: this session can operate Ari. Commands: ari env, ari agents, ari session spawn|prompt|wait|read|diff|integrate|stop|destroy. Full protocol: ari --skill. Never disclose ARI_CONTROL_TOKEN.]\n\n${prompt}`
            : prompt,
        modelId: session.modelId,
        permissionMode: session.permissionMode,
        effort: session.effort ?? null,
        resumeOf,
        ...(attachments.length > 0
          ? { attachments: await this.#resolveAttachments(attachments) }
          : {}),
      })
    } catch (e) {
      await this.#settle(session.id, turnId, 'error', String(e))
      return
    }

    if ((await this.#deps.store.load(session.id)).activeTurnId !== turnId) {
      adapter.interrupt()
      await adapter.dispose()
      return
    }

    let interrupted = false
    this.#activeTurns.set(session.id, {
      sessionId: session.id,
      turnId,
      interrupt: () => {
        interrupted = true
        adapter.interrupt()
      },
      respondApproval: (approvalId, decision) => {
        adapter.respondApproval?.(approvalId, decision)
      },
      respondInput: (inputId, value) => {
        adapter.respondInput?.(inputId, value)
      },
      steer: (text) => {
        if (adapter.steer === undefined) return false
        adapter.steer(text)
        return true
      },
    })

    // Coalesced part buffer: text/thinking flush at ~120ms or on non-text.
    let buffer: { type: 'text' | 'thinking'; text: string }[] = []
    let lastFlush = Date.now()
    const messageId = newTypedId('msg')

    // Post-interrupt guard: the decider already settled an interrupted turn;
    // late adapter events must never overwrite that state.
    const append = async (event: UnstampedEvent): Promise<void> => {
      if (interrupted) return
      await this.#append(session.id, event)
    }

    const flush = async (): Promise<void> => {
      if (buffer.length === 0 || interrupted) {
        buffer = []
        return
      }
      const parts = buffer.map((b) => ({ type: b.type, text: b.text }) as const)
      buffer = []
      lastFlush = Date.now()
      await this.#append(session.id, {
        type: 'assistant.parts.appended',
        messageId,
        parts,
      })
    }

    try {
      let firstErrorMessage: string | null = null
      for await (const event of adapter.start()) {
        switch (event.type) {
          case 'text-delta':
          case 'thinking-delta': {
            buffer.push({
              type: event.type === 'text-delta' ? 'text' : 'thinking',
              text: event.text,
            })
            if (Date.now() - lastFlush >= 120) await flush()
            break
          }
          case 'tool-started': {
            await flush()
            // Tool calls attach to the same streaming assistant message.
            await append({
              type: 'assistant.parts.appended',
              messageId,
              parts: [
                {
                  type: 'tool-call',
                  callId: event.callId,
                  name: event.name,
                  argsJson: event.argsJson,
                },
              ],
            })
            break
          }
          case 'tool-completed': {
            await flush()
            await append({
              type: 'assistant.parts.appended',
              messageId,
              parts: [
                {
                  type: 'tool-result',
                  callId: event.callId,
                  resultJson: event.resultJson,
                  isError: event.isError,
                },
              ],
            })
            break
          }
          case 'usage': {
            await append({
              type: 'usage.recorded',
              inputTokens: event.inputTokens,
              outputTokens: event.outputTokens,
              costUsd: event.costUsd,
            })
            break
          }
          case 'status':
            await append({
              type: 'session.status.changed',
              from: session.status,
              to: event.status,
              reason: null,
            })
            break
          case 'approval-requested':
            await append({
              type: 'approval.requested',
              approvalId: event.approvalId,
              toolName: event.toolName,
              summaryJson: event.summaryJson,
            })
            break
          case 'input-requested':
            // Journal the question so the QuestionPanel can answer it via
            // `input.respond` and answers survive replay.
            await append({
              type: 'input.requested',
              inputId: event.inputId,
              prompt: event.prompt,
              choicesJson: event.choicesJson,
            })
            break
          case 'session-ref':
            // Persist the provider-native thread id so the next turn resumes
            // it instead of re-prompting cold.
            await append({ type: 'session.ref.observed', ref: event.ref })
            break
          case 'error':
            if (firstErrorMessage === null) firstErrorMessage = event.message
            await append({
              type: 'assistant.parts.appended',
              messageId,
              parts: [{ type: 'text', text: `\n\n⚠ ${event.message}` }],
            })
            break
          case 'done':
            break
        }
      }
      await flush()
      // Provider-emitted errors (auth failures, CLI crashes with exit 0, HTTP
      // errors) must settle the turn as `error`, never as a completed chat —
      // otherwise the failure is invisible and the UI looks broken.
      if (!interrupted) {
        await this.#settle(
          session.id,
          turnId,
          firstErrorMessage === null ? 'completed' : 'error',
          firstErrorMessage,
        )
      }
    } catch (e) {
      await flush().catch(() => undefined)
      if (!interrupted) await this.#settle(session.id, turnId, 'error', String(e))
    } finally {
      this.#activeTurns.delete(session.id)
      await adapter.dispose()
    }
  }

  async #settle(
    sessionId: string,
    turnId: string,
    stopReason: 'completed' | 'interrupted' | 'error',
    errorMessage: string | null,
  ): Promise<void> {
    const model = await this.#deps.store.load(sessionId)
    if (model.activeTurnId !== turnId) return
    const nextStatus = stopReason === 'error' ? 'error' : 'idle'
    // Fold status before publishing turn.settled so subscribers that load
    // the read model on settle already see idle/error, not a stale `running`.
    if (model.status !== nextStatus) {
      await this.#append(sessionId, {
        type: 'session.status.changed',
        from: model.status === 'unknown' ? 'idle' : model.status,
        to: nextStatus,
        reason: errorMessage,
      })
    }
    await this.#append(sessionId, {
      type: 'turn.settled',
      turnId,
      stopReason,
      errorMessage,
    })
    if (stopReason !== 'error') this.#onFirstSettle(sessionId)

    // Durable queue continuation: never decide from the pre-settle snapshot
    // above — a message.enqueued may land between that load and this append
    // and would strand. Schedule a drain on the per-root chain instead, so
    // the fresh queue snapshot is ordered with every concurrent enqueue.
    // Error/interrupted settles hold the queue (M15.10); the drain re-checks
    // the stop reason and no-ops for those.
    this.#scheduleQueueDrain(sessionId, model.session?.rootSessionId ?? null)
  }

  /** Queues a serialized queue-drain; fire-and-forget, never rejects. */
  #scheduleQueueDrain(sessionId: string, rootSessionId: string | null): void {
    const id = rootSessionId ?? sessionId
    void this.#chain(id, () => this.#drainQueue(sessionId)).catch((e) => {
      log.error('queued-turn drain failed', { error: String(e) })
    })
  }

  /** Retries queues that were held only by root-level concurrency capacity. */
  #retryCapacityBlockedQueues(rootId: string): void {
    const blocked = this.#capacityBlockedQueues.get(rootId)
    if (!blocked) return
    this.#capacityBlockedQueues.delete(rootId)
    for (const sessionId of blocked) this.#scheduleQueueDrain(sessionId, rootId)
  }

  /**
   * Runs inside the per-root chain: reloads a fresh snapshot, and after a
   * clean settle starts the oldest non-steered queued message as the next
   * turn — dequeue plus turn.started appends atomically in this slot, so no
   * concurrent enqueue can slip between the snapshot and the decision.
   */
  async #drainQueue(sessionId: string): Promise<void> {
    const fresh = await this.#deps.store.load(sessionId)
    const session = fresh.session
    if (!session || fresh.activeTurnId !== null) return
    if (fresh.lastTurn && fresh.lastTurn.stopReason !== 'completed') return
    const steered = this.#steeredTexts.get(sessionId)
    const next = fresh.queuedMessages.find(
      (queued) => steered === undefined || !steered.has(inputKey(queued.text, queued.origin)),
    )
    if (next === undefined) {
      if (fresh.queuedMessages.length === 0) this.#steeredTexts.delete(sessionId)
      return
    }
    if (this.#deps.authorizeTurn) {
      const reason = await this.#deps.authorizeTurn(session)
      if (reason) {
        const rootId = session.rootSessionId ?? session.id
        const blocked = this.#capacityBlockedQueues.get(rootId) ?? new Set<string>()
        blocked.add(sessionId)
        this.#capacityBlockedQueues.set(rootId, blocked)
        return
      }
    }
    this.#capacityBlockedQueues.get(session.rootSessionId ?? session.id)?.delete(sessionId)
    const ids: DispatchIds = { turnId: newTypedId('turn'), messageId: newTypedId('msg') }
    const decision = decideCommand(
      fresh,
      { type: 'turn.start', sessionId, text: next.text, attachments: next.attachments },
      ids,
      next.origin,
    )
    if (!decision.accepted) return

    const previous = this.#turnTasks.get(sessionId) ?? Promise.resolve()
    let releaseGate!: (persisted: boolean) => void
    const gate = new Promise<boolean>((resolve) => {
      releaseGate = resolve
    })
    const task = previous
      .then(() => gate)
      .then((persisted) =>
        persisted
          ? this.#runTurn(
              session,
              attributedInput(next.text, next.origin),
              next.attachments,
              ids.turnId,
              fresh.providerSessionId?.startsWith('imported:') ? null : fresh.providerSessionId,
            )
          : undefined,
      )
      .catch((e) => {
        log.error('turn execution crashed', { error: String(e) })
      })
    this.#turnTasks.set(sessionId, task)
    void task.then(() => {
      if (this.#turnTasks.get(sessionId) === task) {
        this.#turnTasks.delete(sessionId)
        this.#retryCapacityBlockedQueues(session.rootSessionId ?? session.id)
      }
    })

    try {
      await this.#append(sessionId, {
        type: 'message.dequeued',
        text: next.text,
        attachments: next.attachments,
        ...(next.origin ? { origin: next.origin } : {}),
      })
      for (const event of decision.events) {
        await this.#append(sessionId, event)
      }
    } catch (error) {
      releaseGate(false)
      throw error
    }
    releaseGate(true)
    this.#steeredTexts.delete(sessionId)
  }

  /**
   * Resolves staged attachment refs to adapter inputs. Unknown ids resolve
   * with a null path so drivers name them in text instead of failing the turn.
   */
  async #resolveAttachments(
    attachments: AttachmentRef[],
  ): Promise<{ id: string; name: string; mimeType: string; path: string | null }[]> {
    const resolve = this.#deps.resolveAttachmentPath
    return Promise.all(
      attachments.map(async (attachment) => ({
        id: attachment.id,
        name: attachment.name,
        mimeType: attachment.mimeType,
        path: resolve ? await resolve(attachment.id) : null,
      })),
    )
  }

  /**
   * Title generation hook (M18.2): after the session's first settled turn
   * that did not end in error — and only while the title is still the
   * automatic slice of the first prompt — upgrades it through the configured
   * {@link TitleStrategy}. Fire-and-forget: never blocks or fails the turn.
   */
  #onFirstSettle(sessionId: string): void {
    if (this.#titleSettled.has(sessionId)) return
    this.#titleSettled.add(sessionId)
    void this.#generateTitle(sessionId).catch((e) => {
      log.debug('title generation skipped', { sessionId, error: String(e) })
    })
  }

  async #generateTitle(sessionId: string): Promise<void> {
    const model = await this.#deps.store.load(sessionId)
    const session = model.session
    const firstPrompt = model.messages.find((m) => m.role === 'user')
    if (!session || !firstPrompt) return
    const prompt = firstPrompt.parts.find((p) => p.type === 'text')?.text ?? ''
    if (!isAutoTitle(session.title, prompt)) return
    const strategy = this.#deps.titleStrategy ?? deterministicTitleStrategy
    const title = await strategy.generate({ prompt, currentTitle: session.title })
    if (title === null || title.length === 0 || title === session.title) return
    await this.#append(sessionId, { type: 'session.updated', title })
  }

  /** Live tail: replays the journal, then forwards appended events. */
  async replaySession(sessionId: string): Promise<JournalEvent[]> {
    const journal = await this.#deps.store.openJournal(sessionId)
    const entries = await journal.readAll()
    return entries.flatMap((e) => (e.kind === 'value' ? [e.value] : []))
  }
}
