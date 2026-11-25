import type { JournalEvent } from '@ari/contracts/events'
import { pushMessageParts, type Message, type MessagePart } from '@ari/contracts/message'
import { applyEvent, initialReadModel } from '@ari/engine/projection'
import type { MessageFold } from './message-fold'
import type { TranscriptStore } from './transcript-store'
import { parseSessionViewKey, registerSessionCacheInvalidator } from './session-scope'
import { compactEventImages, compactMessageImages, ImageBlobs } from './image-blobs'

const carriesText = (event: JournalEvent): boolean =>
  event.type === 'user.message.added' || event.type === 'assistant.parts.appended'

/** Cached with the transcript's bounded LRU, never inferred as live execution. */
const journals = new WeakMap<TranscriptStore, HistoryJournal>()
const active = new Set<WeakRef<HistoryJournal>>()
registerSessionCacheInvalidator((machineId) => {
  for (const reference of active) {
    const history = reference.deref()
    if (!history) {
      active.delete(reference)
      continue
    }
    const scope = parseSessionViewKey(history.viewKey)
    if (scope?.kind === 'remote' && scope.machineId === machineId) history.dispose()
  }
})

/**
 * Retains journal events by sequence so a retry can recover an older
 * gap after live output has already landed. Normal ordered streaming still
 * appends in place; only an insertion before the tail rebuilds the message fold.
 */
export class HistoryJournal {
  readonly #store: TranscriptStore
  readonly #events = new Map<number, JournalEvent>()
  /** Large tool-result images, held as Blobs instead of base64 text. */
  readonly #images = new ImageBlobs()
  readonly #observed = new Set<number>()
  #fold: MessageFold
  #tail = -1
  #rebuild = false
  #turnId: string | null = null
  #partCounts = new Map<string, number>()
  lastPart: { messageId: string; parts: number } | null = null
  #disposed = false
  /** Saved messages as of seq: the transcript before any event above it. */
  #seed: { seq: number; messages: Message[] } | null = null
  #seedObserved = false
  get viewKey(): string {
    return this.#store.sessionId
  }
  dispose(): void {
    this.#disposed = true
    this.#events.clear()
    this.#observed.clear()
    this.#partCounts.clear()
    this.#images.dispose()
    this.#store.dispose()
    journals.delete(this.#store)
  }

  constructor(store: TranscriptStore) {
    this.#store = store
    this.#fold = store.begin()
    for (const reference of active) if (!reference.deref()) active.delete(reference)
    active.add(new WeakRef(this))
  }

  /** A remount starts a fresh authoritative read, keeping the cache visible. */
  begin(): void {
    this.#observed.clear()
    this.#seedObserved = false
  }

  /**
   * Starts from saved messages as of `seq`. Events at or below it that carry
   * message text are already in them; every other event still arrives on its own.
   */
  seed(seq: number, messages: readonly Message[]): void {
    if (this.#disposed) return
    this.#seed = { seq, messages: messages.map((m) => compactMessageImages(m, this.#images)) }
    this.#seedObserved = true
    for (const [at, event] of this.#events)
      if (at <= seq && carriesText(event)) this.#events.delete(at)
    this.#tail = Math.max(this.#tail, seq)
    this.#rebuild = true
  }

  finish(complete: boolean, mode: 'full' | 'resume' = 'full'): void {
    if (this.#disposed || mode === 'resume') return
    if (!complete) return
    if (this.#seed && !this.#seedObserved) {
      this.#seed = null
      this.#rebuild = true
    }
    for (const seq of this.#events.keys()) {
      if (!this.#observed.has(seq)) {
        this.#events.delete(seq)
        this.#rebuild = true
      }
    }
  }

  /**
   * Stores an event and returns the stored form: large tool-result images are
   * moved into Blobs first, so callers keep that instead of the base64 text.
   */
  add(raw: JournalEvent): JournalEvent {
    if (this.#disposed) return raw
    const event = compactEventImages(raw, this.#images)
    this.#observed.add(event.seq)
    if (this.#seed && event.seq <= this.#seed.seq && carriesText(event)) {
      // A full replay of a seeded transcript: the events say it all again.
      this.#seed = null
      this.#rebuild = true
    }
    const stored = this.#events.get(event.seq)
    if (stored && JSON.stringify(stored) === JSON.stringify(event)) return stored
    if (event.type === 'assistant.parts.appended' && event.replayFromSeq !== undefined) {
      // A partial retry may compact previously cached live deltas. Replace the
      // represented range immediately, even when the rest of that retry fails.
      if (event.replayFromSeq > event.seq) throw new Error('Invalid compact conversation range')
      for (const [seq, previous] of this.#events) {
        if (
          seq >= event.replayFromSeq &&
          seq <= event.seq &&
          previous.type === 'assistant.parts.appended' &&
          previous.messageId === event.messageId
        ) {
          this.#events.delete(seq)
          this.#rebuild = true
        }
      }
    }
    if (stored) this.#rebuild = true
    this.#events.set(event.seq, event)
    if (event.seq < this.#tail) this.#rebuild = true
    this.#tail = Math.max(this.#tail, event.seq)
    if (!this.#rebuild) this.#append(event)
    return event
  }

  /** One native sub-agent's transcript, in journal order; never part of the session's messages. */
  subagentParts(taskId: string, launchCallId?: string): MessagePart[] {
    const events: Extract<JournalEvent, { type: 'background.task.parts.appended' }>[] = []
    for (const event of this.#events.values())
      if (
        event.type === 'background.task.parts.appended' &&
        (event.taskId === taskId || event.taskId === launchCallId)
      )
        events.push(event)
    const parts: MessagePart[] = []
    for (const event of events.sort((a, b) => a.seq - b.seq)) pushMessageParts(parts, event.parts)
    return parts
  }

  /** Rebuilds journal-derived controls, without replaying any live side effects. */
  controls() {
    let model = initialReadModel()
    const settledTurnIds = new Set<string>()
    const telemetry = {
      turnCount: 0,
      lastDurationMs: null as number | null,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      startedAt: null as number | null,
      context: null as { usedTokens: number; windowTokens: number | null } | null,
    }
    for (const event of [...this.#events.values()].sort((a, b) => a.seq - b.seq)) {
      // MessageFold owns messages; the immutable projection would copy a long
      // transcript once per delta, so it folds only the control events here.
      if (event.type === 'user.message.added' || event.type === 'assistant.parts.appended') continue
      model = applyEvent(model, event)
      switch (event.type) {
        case 'turn.started':
          telemetry.turnCount++
          telemetry.startedAt = event.at
          break
        case 'turn.settled':
          settledTurnIds.add(event.turnId)
          if (telemetry.startedAt !== null)
            telemetry.lastDurationMs = Math.max(0, event.at - telemetry.startedAt)
          telemetry.startedAt = null
          break
        case 'usage.recorded':
          telemetry.inputTokens += event.inputTokens ?? 0
          telemetry.cachedInputTokens += event.cachedInputTokens ?? 0
          telemetry.outputTokens += event.outputTokens ?? 0
          break
        case 'context.recorded':
          telemetry.context = {
            usedTokens: event.usedTokens,
            windowTokens: event.windowTokens ?? telemetry.context?.windowTokens ?? null,
          }
          break
      }
    }
    return { model, telemetry, settledTurnIds }
  }

  #append(event: JournalEvent): void {
    switch (event.type) {
      case 'turn.started':
        this.#turnId = event.turnId
        break
      case 'turn.settled':
        this.#turnId = null
        break
      case 'user.message.added':
        this.#fold.addUser(event.message)
        this.lastPart = { messageId: event.message.id, parts: event.message.parts.length }
        break
      case 'assistant.parts.appended': {
        const count = this.#fold.appendParts(event.messageId, event.parts, () => ({
          id: event.messageId,
          sessionId: event.sessionId,
          turnId: this.#turnId,
          role: 'assistant',
          createdAt: event.at,
        }))
        // Newer folds return their normalized part count (adjacent text may
        // coalesce); older folds returned void. Keep the patch usable on both.
        const parts =
          typeof count === 'number'
            ? count
            : (this.#partCounts.get(event.messageId) ?? 0) + event.parts.length
        this.#partCounts.set(event.messageId, parts)
        this.lastPart = { messageId: event.messageId, parts }
        break
      }
    }
  }

  publish(): void {
    if (this.#rebuild) {
      this.#fold = this.#store.begin()
      this.#turnId = null
      this.lastPart = null
      this.#partCounts.clear()
      for (const message of this.#seed?.messages ?? []) {
        // Saved messages are already folded; they land whole.
        this.#fold.addUser(message)
        this.#partCounts.set(message.id, message.parts.length)
        this.lastPart = { messageId: message.id, parts: message.parts.length }
      }
      for (const event of [...this.#events.values()].sort((a, b) => a.seq - b.seq))
        this.#append(event)
      this.#rebuild = false
    }
    // No events on a failed read must not clear the last cached snapshot.
    if (this.#observed.size > 0 || this.#events.size > 0 || this.#tail >= 0) this.#store.publish()
  }
}

export function historyJournal(store: TranscriptStore): HistoryJournal {
  let journal = journals.get(store)
  if (!journal) {
    journal = new HistoryJournal(store)
    journals.set(store, journal)
  }
  return journal
}
