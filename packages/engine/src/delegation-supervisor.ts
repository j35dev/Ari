import { createLogger } from '@ari/shared/logger'
import type { DelegationSettings } from '@ari/contracts/agent-control'
import type { Command } from '@ari/contracts/commands'
import type { JournalEvent } from '@ari/contracts/events'
import type { MessageOrigin } from '@ari/contracts/message'
import type { SessionStore } from './session-store'
import type { UnstampedEvent } from './projection'
import {
  completionNotice,
  finalAssistantText,
  pendingCompletions,
  type CompletionReport,
} from './delegation-state'

const log = createLogger('engine:delegation')

/** Long enough for siblings finishing together to share one wake-up. */
const SETTLE_DELAY_MS = 1_200
const RETRY_DELAY_MS = 5_000
const MAX_RETRIES = 12
const REPORT_CHARS = 4_000

export interface SupervisorHost {
  store: Pick<SessionStore, 'load' | 'listSessions'>
  policy(): DelegationSettings
  dispatch(
    command: Command,
    origin?: MessageOrigin,
  ): Promise<{ accepted: boolean; reason?: string }>
  record(id: string, event: UnstampedEvent): Promise<JournalEvent>
  subscribe(listener: (event: JournalEvent) => void): () => void
  isRunning?(id: string): boolean
  /** True while `parentId` is blocked in `session wait` on `childId`. */
  isWaiting?(parentId: string, childId: string): boolean
  settleDelayMs?: number
  retryDelayMs?: number
}

/**
 * Keeps a delegation tree moving without the parent polling it: finished
 * children wake an idle parent with their reports, and stopping a session
 * stops the work it delegated.
 *
 * A wake-up is only ever started on an idle parent whose last turn ended
 * cleanly and whose queue is empty. Nothing is parked in the parent's queue
 * ahead of time, so a result the parent reads for itself mid-turn simply
 * stops being pending — there is no queued notice to retract.
 */
export class DelegationSupervisor {
  readonly #timers = new Map<string, ReturnType<typeof setTimeout>>()
  readonly #chains = new Map<string, Promise<void>>()
  readonly #retries = new Map<string, number>()
  #unsubscribe: (() => void) | null = null
  constructor(readonly host: SupervisorHost) {}

  start(): void {
    this.#unsubscribe ??= this.host.subscribe((event) => this.#observe(event))
  }

  close(): void {
    this.#unsubscribe?.()
    this.#unsubscribe = null
    for (const timer of this.#timers.values()) clearTimeout(timer)
    this.#timers.clear()
  }

  /** Re-checks a parent after the batching delay; repeated calls coalesce. */
  schedule(parentId: string, delayMs = this.host.settleDelayMs ?? SETTLE_DELAY_MS): void {
    const existing = this.#timers.get(parentId)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      this.#timers.delete(parentId)
      void this.evaluate(parentId)
    }, delayMs)
    timer.unref?.()
    this.#timers.set(parentId, timer)
  }

  /** Delivers whatever is deliverable to `parentId` right now. Never rejects. */
  evaluate(parentId: string): Promise<void> {
    return this.#serial(parentId, () => this.#deliver(parentId))
  }

  #observe(event: JournalEvent): void {
    if (event.type === 'child.session.settled') this.schedule(event.sessionId)
    else if (event.type === 'turn.settled') {
      if (event.stopReason === 'completed') this.schedule(event.sessionId)
      else if (event.stopReason === 'interrupted')
        void this.#serial(event.sessionId, () => this.#stopped(event.sessionId))
    }
  }

  #serial(parentId: string, run: () => Promise<void>): Promise<void> {
    const next = (this.#chains.get(parentId) ?? Promise.resolve()).then(run).catch((error) => {
      log.error('delegation supervision failed', { parentId, error: String(error) })
    })
    this.#chains.set(parentId, next)
    void next.finally(() => {
      if (this.#chains.get(parentId) === next) this.#chains.delete(parentId)
    })
    return next
  }

  #acknowledge(parentId: string, childSessionId: string, turnId: string, via: 'delivered' | 'disposed') {
    return this.host.record(parentId, {
      type: 'child.session.acknowledged',
      childSessionId,
      turnId,
      via,
    })
  }

  /**
   * A stop is the user (or an ancestor) saying "enough": results that were
   * waiting to wake this session are dropped, and its live children stop too.
   * Each child's own interrupted settle re-enters here, so the walk reaches
   * every depth without holding the tree in memory.
   */
  async #stopped(sessionId: string): Promise<void> {
    const model = await this.host.store.load(sessionId)
    if (!model.session) return
    for (const pending of pendingCompletions(model))
      await this.#acknowledge(sessionId, pending.childSessionId, pending.turnId, 'disposed')
    if (!this.host.policy().cascadeStop) return
    for (const row of await this.host.store.listSessions()) {
      if (row.parentSessionId !== sessionId) continue
      const child = await this.host.store.load(row.id)
      if (child.activeTurnId === null) continue
      // Acknowledged first: the settle this interrupt produces must not wake
      // the session that was just told to stop.
      await this.#acknowledge(sessionId, row.id, child.activeTurnId, 'disposed')
      await this.host.dispatch({ type: 'turn.interrupt', sessionId: row.id })
    }
  }

  async #deliver(parentId: string): Promise<void> {
    const policy = this.host.policy()
    if (!policy.enabled || !policy.autoDeliverResults) return
    const parent = await this.host.store.load(parentId)
    if (!parent.session || parent.session.archived) return
    const pending = pendingCompletions(parent)
    if (pending.length === 0) return
    // Held, not dropped: the next clean settle re-checks.
    if (parent.activeTurnId !== null || this.host.isRunning?.(parentId)) return
    if (parent.lastTurn?.stopReason !== 'completed' || parent.queuedMessages.length > 0) return

    const reports: CompletionReport[] = []
    const delivered: { childSessionId: string; turnId: string }[] = []
    for (const entry of pending) {
      if (this.host.isWaiting?.(parentId, entry.childSessionId)) continue
      const child = await this.host.store.load(entry.childSessionId)
      if (!child.session) {
        await this.#acknowledge(parentId, entry.childSessionId, entry.turnId, 'disposed')
        continue
      }
      // Working again: this outcome is stale and a newer settle will follow.
      if (child.activeTurnId !== null || this.host.isRunning?.(entry.childSessionId)) continue
      reports.push({
        sessionId: entry.childSessionId,
        title: child.session.title,
        stopReason: entry.stopReason,
        errorMessage:
          child.lastTurn?.turnId === entry.turnId ? (child.lastTurn.errorMessage ?? null) : null,
        report: finalAssistantText(child, entry.turnId, REPORT_CHARS),
      })
      delivered.push({ childSessionId: entry.childSessionId, turnId: entry.turnId })
    }
    if (reports.length === 0) return

    const working: { sessionId: string; title: string }[] = []
    for (const row of await this.host.store.listSessions()) {
      if (row.parentSessionId !== parentId || row.archived) continue
      if ((await this.host.store.load(row.id)).activeTurnId !== null || this.host.isRunning?.(row.id))
        working.push({ sessionId: row.id, title: row.title })
    }
    const outcome = await this.host.dispatch(
      {
        type: 'message.enqueue',
        sessionId: parentId,
        text: completionNotice(reports, working),
        attachments: [],
      },
      { kind: 'completion', sessionIds: delivered.map((entry) => entry.childSessionId) },
    )
    if (!outcome.accepted) {
      // A nested parent can be refused a turn while its root is at capacity.
      const attempt = (this.#retries.get(parentId) ?? 0) + 1
      if (attempt > MAX_RETRIES) {
        this.#retries.delete(parentId)
        log.warn('delegation update could not be delivered', { parentId, reason: outcome.reason })
        return
      }
      this.#retries.set(parentId, attempt)
      this.schedule(parentId, this.host.retryDelayMs ?? RETRY_DELAY_MS)
      return
    }
    this.#retries.delete(parentId)
    for (const entry of delivered)
      await this.#acknowledge(parentId, entry.childSessionId, entry.turnId, 'delivered')
  }
}
