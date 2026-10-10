import { createLogger } from '@ari/shared/logger'
import type { DelegationSettings } from '@ari/contracts/agent-control'
import type { Command } from '@ari/contracts/commands'
import type { JournalEvent } from '@ari/contracts/events'
import type { MessageOrigin } from '@ari/contracts/message'
import type { SessionListEntry, SessionStore } from './session-store'
import type { SessionReadModel, UnstampedEvent } from './projection'
import {
  completionNotice,
  finalAssistantText,
  pendingCompletions,
  type CompletionReport,
} from './delegation-state'

const log = createLogger('engine:delegation')

/** Long enough for siblings finishing together to share one wake-up. */
const SETTLE_DELAY_MS = 1_200
/**
 * How long a finished child's report is held back while siblings are still
 * running. Children handed out together tend to finish together; without this
 * the parent is woken once per child and spends a turn each time saying it is
 * still waiting for the rest.
 */
const BATCH_WINDOW_MS = 20_000
const RETRY_DELAY_MS = 15_000
const REPORT_CHARS = 4_000
/** The most children one notice names; the message origin schema allows no more. */
const MAX_BATCH = 32

export interface SupervisorHost {
  store: Pick<SessionStore, 'load' | 'listSessions'>
  policy(): DelegationSettings
  dispatch(
    command: Command,
    origin?: MessageOrigin,
  ): Promise<{ accepted: boolean; reason?: string }>
  record(id: string, event: UnstampedEvent): Promise<JournalEvent>
  subscribe(listener: (event: JournalEvent) => void): () => void
  /**
   * Whether the engine holds a turn task for the session. Only consulted at
   * start-up, to tell a turn that is running from one a previous run left
   * open in the journal.
   */
  isRunning?(id: string): boolean
  /** True while `parentId` is blocked in `session wait` on `childId`. */
  isWaiting?(parentId: string, childId: string): boolean
  settleDelayMs?: number
  retryDelayMs?: number
  batchWindowMs?: number
  now?(): number
}

/** Every session below `rootId`, parents before their children. */
function subtree(rows: readonly SessionListEntry[], rootId: string): SessionListEntry[] {
  const out: SessionListEntry[] = []
  const seen = new Set<string>([rootId])
  for (let frontier = [rootId]; frontier.length > 0; ) {
    const next: string[] = []
    for (const row of rows) {
      if (!row.parentSessionId || seen.has(row.id) || !frontier.includes(row.parentSessionId))
        continue
      seen.add(row.id)
      out.push(row)
      next.push(row.id)
    }
    frontier = next
  }
  return out
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
 *
 * Whether a session is working is read from its journal, never from whether
 * its provider process is still alive: a provider can take seconds to shut
 * down after its turn has settled, and treating that as work would strand the
 * result it just produced.
 */
export class DelegationSupervisor {
  readonly #timers = new Map<string, ReturnType<typeof setTimeout>>()
  readonly #chains = new Map<string, Promise<void>>()
  /** Parents whose wake-up was refused; any settle may have freed the capacity they need. */
  readonly #refused = new Set<string>()
  #unsubscribe: (() => void) | null = null
  constructor(readonly host: SupervisorHost) {}

  start(): void {
    if (this.#unsubscribe !== null) return
    this.#unsubscribe = this.host.subscribe((event) => this.#observe(event))
    void this.#recover().catch((error: unknown) => {
      log.warn('delegation recovery failed', { error: String(error) })
    })
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
    return this.#serial(parentId, async () => {
      await this.#deliver(parentId)
      await this.#bubble(parentId)
    })
  }

  #observe(event: JournalEvent): void {
    if (event.type === 'child.session.settled' || event.type === 'child.session.acknowledged')
      this.schedule(event.sessionId)
    else if (event.type === 'turn.settled') {
      for (const parentId of this.#refused) this.schedule(parentId)
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

  #acknowledge(
    parentId: string,
    childSessionId: string,
    turnId: string,
    via: 'delivered' | 'disposed',
  ): Promise<JournalEvent> {
    return this.host.record(parentId, {
      type: 'child.session.acknowledged',
      childSessionId,
      turnId,
      via,
    })
  }

  /**
   * No turn survives a restart, but its `turn.started` does. A child left that
   * way would read as working forever: its parent would wait on it, and be
   * told it is still running. Settling it as interrupted says what happened.
   */
  async #recover(): Promise<void> {
    const isRunning = this.host.isRunning?.bind(this.host)
    if (isRunning === undefined) return
    for (const row of await this.host.store.listSessions()) {
      if (!row.parentSessionId || isRunning(row.id)) continue
      if ((await this.host.store.load(row.id)).activeTurnId === null) continue
      await this.host.dispatch({ type: 'turn.interrupt', sessionId: row.id })
    }
  }

  /**
   * A stop is the user (or an ancestor) saying "enough". Everything below the
   * stopped session stops with it, at any depth: a child that already ended
   * its turn to wait for its own children has nothing to interrupt, but the
   * work it delegated does, and results waiting to wake any of them are
   * dropped so that nothing restarts afterwards.
   */
  async #stopped(sessionId: string): Promise<void> {
    const model = await this.host.store.load(sessionId)
    if (!model.session) return
    for (const pending of pendingCompletions(model))
      await this.#acknowledge(sessionId, pending.childSessionId, pending.turnId, 'disposed')
    if (!this.host.policy().cascadeStop) return
    for (const row of subtree(await this.host.store.listSessions(), sessionId)) {
      const descendant = await this.host.store.load(row.id)
      if (descendant.activeTurnId === null) {
        for (const pending of pendingCompletions(descendant))
          await this.#acknowledge(row.id, pending.childSessionId, pending.turnId, 'disposed')
        continue
      }
      // Acknowledged first: the settle this interrupt produces must not wake
      // the session above it.
      if (row.parentSessionId)
        await this.#acknowledge(row.parentSessionId, row.id, descendant.activeTurnId, 'disposed')
      await this.host.dispatch({ type: 'turn.interrupt', sessionId: row.id })
    }
  }

  /**
   * A session whose own outcome is being held by its parent (because work it
   * delegated was unfinished) has that parent look again once it goes quiet.
   */
  async #bubble(sessionId: string): Promise<void> {
    const model = await this.host.store.load(sessionId)
    const parentId = model.session?.parentSessionId
    if (!parentId || model.activeTurnId !== null) return
    const parent = await this.host.store.load(parentId)
    if (pendingCompletions(parent).some((entry) => entry.childSessionId === sessionId))
      this.schedule(parentId)
  }

  async #deliver(parentId: string): Promise<void> {
    const policy = this.host.policy()
    if (!policy.enabled || !policy.autoDeliverResults) return
    const parent = await this.host.store.load(parentId)
    if (!parent.session || parent.session.archived) {
      this.#refused.delete(parentId)
      return
    }
    const pending = pendingCompletions(parent)
    if (pending.length === 0) {
      this.#refused.delete(parentId)
      return
    }
    // Held, not dropped: the next clean settle re-checks.
    if (parent.activeTurnId !== null) return
    if (parent.lastTurn?.stopReason !== 'completed' || parent.queuedMessages.length > 0) return

    const rows = await this.host.store.listSessions()
    const models = new Map<string, SessionReadModel>()
    const load = async (id: string): Promise<SessionReadModel> => {
      const known = models.get(id) ?? (await this.host.store.load(id))
      models.set(id, known)
      return known
    }
    /** The sessions at or below `id` that are mid-turn. */
    const liveWithin = async (id: string): Promise<SessionReadModel[]> => {
      const live: SessionReadModel[] = []
      for (const member of [id, ...subtree(rows, id).map((row) => row.id)]) {
        const model = await load(member)
        if (model.activeTurnId !== null) live.push(model)
      }
      return live
    }

    const reports: CompletionReport[] = []
    const delivered: { childSessionId: string; turnId: string }[] = []
    let oldest = Number.POSITIVE_INFINITY
    for (const entry of pending) {
      if (delivered.length >= MAX_BATCH) break
      if (this.host.isWaiting?.(parentId, entry.childSessionId)) continue
      // A stop never starts work. Whoever stopped this child, waking its
      // parent to react would answer "enough" with a new turn; the parent
      // sees the stop the next time it asks for status.
      if (entry.stopReason === 'interrupted') {
        await this.#acknowledge(parentId, entry.childSessionId, entry.turnId, 'disposed')
        continue
      }
      const child = await load(entry.childSessionId)
      if (!child.session) {
        await this.#acknowledge(parentId, entry.childSessionId, entry.turnId, 'disposed')
        continue
      }
      // Its turn ended cleanly, but it is working again or waiting on work it
      // delegated itself: "I have handed this out" is not the result. It will
      // settle again, or go quiet and bubble back here.
      if (
        entry.stopReason === 'completed' &&
        ((await liveWithin(entry.childSessionId)).length > 0 ||
          pendingCompletions(child).some((own) => own.stopReason !== 'interrupted'))
      )
        continue
      if (child.activeTurnId !== null) continue
      reports.push({
        sessionId: entry.childSessionId,
        title: child.session.title,
        stopReason: entry.stopReason,
        errorMessage:
          child.lastTurn?.turnId === entry.turnId ? (child.lastTurn.errorMessage ?? null) : null,
        report: finalAssistantText(child, entry.turnId, REPORT_CHARS),
      })
      delivered.push({ childSessionId: entry.childSessionId, turnId: entry.turnId })
      oldest = Math.min(oldest, entry.settledAt)
    }
    if (reports.length === 0) return

    const working: { sessionId: string; title: string }[] = []
    let aboutToFinish = false
    for (const row of rows) {
      if (row.parentSessionId !== parentId || row.archived) continue
      if (delivered.some((entry) => entry.childSessionId === row.id)) continue
      const live = await liveWithin(row.id)
      if (live.length === 0) continue
      working.push({ sessionId: row.id, title: row.title })
      // One parked on an approval or a question is waiting on a person, not about to report.
      if (live.some((m) => m.pendingApprovals.length === 0 && m.pendingInputs.length === 0))
        aboutToFinish = true
    }
    const held = (this.host.now?.() ?? Date.now()) - oldest
    const window = this.host.batchWindowMs ?? BATCH_WINDOW_MS
    if (aboutToFinish && held < window) {
      // Each sibling that settles re-enters here; this timer is the ceiling.
      this.schedule(parentId, window - held)
      return
    }

    // Everything above took time. If the parent moved on in the meantime —
    // most of all if it was started and stopped — the wake-up no longer applies.
    const current = await this.host.store.load(parentId)
    if (
      current.activeTurnId !== null ||
      current.lastTurn?.turnId !== parent.lastTurn.turnId ||
      current.queuedMessages.length > 0
    )
      return
    // `turn.start` rather than an enqueue: refused outright if a turn began
    // after that check, instead of parking a notice behind it.
    const outcome = await this.host.dispatch(
      {
        type: 'turn.start',
        sessionId: parentId,
        text: completionNotice(reports, working),
        attachments: [],
      },
      { kind: 'completion', sessionIds: delivered.map((entry) => entry.childSessionId) },
    )
    if (!outcome.accepted) {
      // A nested parent is refused a turn while its root is at capacity. The
      // results stay pending; any settle may free a slot, and a slow timer
      // covers the case where nothing else moves.
      this.#refused.add(parentId)
      this.schedule(parentId, this.host.retryDelayMs ?? RETRY_DELAY_MS)
      return
    }
    this.#refused.delete(parentId)
    for (const entry of delivered)
      await this.#acknowledge(parentId, entry.childSessionId, entry.turnId, 'delivered')
  }
}
