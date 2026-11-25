import { join } from 'node:path'
import { stat } from 'node:fs/promises'
import { journalEventSchema, type JournalEvent } from '@ari/contracts/events'
import { isHelmSession } from '@ari/contracts/helm'
import { createLogger } from '@ari/shared/logger'
import type { ParsedLine } from '@ari/shared/jsonl'
import { Journal } from './journal'
import {
  LegacySessionStore,
  entryFrom,
  parseSessionIndex,
  type SessionStoreOptions as LegacyOptions,
  type SessionIndex,
  type SessionListEntry,
  type UsageSummary,
} from './legacy-session-store'
import {
  ConversationDatabase,
  isControlEvent,
  savedEvents,
  savedMessages,
  type ConversationSnapshot,
  type EventNote,
  type TranscriptAnchor,
} from './conversation-database'
import { TranscriptPosition } from './conversation-controls'
import { parseConversationState } from './conversation-state'
import { replayEntries, diagnosticsOf, type ReplayDiagnostics } from './journal-replay'
import {
  applyEvent,
  initialReadModel,
  type SessionReadModel,
  type UnstampedEvent,
} from './projection'

export type { SessionListEntry, UsageRow, UsageSummary } from './legacy-session-store'
export interface SessionStoreOptions extends LegacyOptions {
  /** Legacy fixture backend. Production always uses SQLite; old files are imported lazily. */
  storage?: 'sqlite' | 'jsonl'
}
const log = createLogger('engine:conversations')
const SAVE_INTERVAL_MS = 250
const MAX_RETRY_MS = 30_000

/**
 * Conversations and their current state are materialized in SQLite, like T3 Code.
 * Compressed, batched event history retains exact replay cursors and operational receipts.
 * Live text never waits for a database write; control transitions commit before publication.
 */
export class SessionStore extends LegacySessionStore {
  readonly #database: ConversationDatabase | null
  readonly #root: string
  readonly #models = new Map<string, SessionReadModel>()
  readonly #listeners = new Set<(event: JournalEvent) => void>()
  readonly #operations = new Map<string, Promise<unknown>>()
  readonly #pending = new Map<string, JournalEvent[]>()
  readonly #writes = new Map<string, Promise<void>>()
  readonly #changed = new Map<string, Set<string>>()
  readonly #timers = new Map<string, ReturnType<typeof setTimeout>>()
  /** Sessions whose last save failed; cleared by the next successful save. */
  readonly #failures = new Map<string, { error: Error; attempts: number }>()
  readonly #diagnostics = new Map<string, ReplayDiagnostics>()
  readonly #history = new Map<string, ConversationHistory>()
  /** Per session, what each pending event's row needs beyond the event itself. */
  readonly #notes = new Map<string, Map<number, EventNote>>()
  /** Per session, the transcript part written last: where a delegation card goes. */
  readonly #lastPart = new Map<string, TranscriptAnchor>()
  #closing = false

  constructor(options: SessionStoreOptions) {
    super(options)
    this.#root = options.rootDir
    this.#database =
      options.storage === 'jsonl'
        ? null
        : new ConversationDatabase(join(options.rootDir, 'conversations.sqlite'))
  }

  #validate(id: string): void {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)) throw new Error('invalid session id')
  }
  #serial<T>(id: string, work: () => Promise<T>): Promise<T> {
    this.#validate(id)
    const result = (this.#operations.get(id) ?? Promise.resolve()).catch(() => undefined).then(work)
    this.#operations.set(id, result)
    void result
      .finally(() => {
        if (this.#operations.get(id) === result) this.#operations.delete(id)
      })
      .catch(() => undefined)
    return result
  }

  override subscribe(listener: (event: JournalEvent) => void): () => void {
    if (!this.#database) return super.subscribe(listener)
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  async #model(id: string): Promise<SessionReadModel> {
    const cached = this.#models.get(id)
    if (cached) return cached
    const database = this.#database!
    const row = await database.get(id)
    if (row) {
      const model = parseConversationState({
        ...(JSON.parse(row.state_json) as Record<string, unknown>),
        messages: row.messages.map((message): unknown => JSON.parse(message)),
      })
      if (
        model.session?.id !== id ||
        model.lastSeq !== row.last_seq ||
        model.messages.some((message) => message.sessionId !== id)
      )
        throw new Error('Conversation identity or sequence is invalid')
      this.#diagnostics.set(id, JSON.parse(row.diagnostics_json) as ReplayDiagnostics)
      this.#models.set(id, model)
      return model
    }
    if (await super.exists(id)) {
      // Import only when a conversation is opened. The original JSONL stays untouched.
      // Read without opening an append handle or repairing the original tail.
      const legacy = new Journal<JournalEvent>({ dir: join(this.#root, id), name: 'journal' })
      const entries: ParsedLine<JournalEvent>[] = []
      for await (const chunk of legacy.readByChunk(256 * 1024, true)) {
        for (const entry of chunk) {
          if (entry.kind === 'value' && entry.value.sessionId !== id)
            entries.push({
              kind: 'error',
              line: entry.line,
              raw: entry.raw,
              message: 'Conversation identity mismatch',
            })
          else entries.push(entry)
        }
      }
      const { model, rejected } = replayEntries(entries)
      if (model.session?.id !== id) throw new Error('Legacy conversation identity is invalid')
      const events = entries.flatMap((entry) => {
        if (entry.kind !== 'value') return []
        const parsed = journalEventSchema.safeParse(entry.value)
        return parsed.success && parsed.data.sessionId === id ? [parsed.data] : []
      })
      const diagnostics = diagnosticsOf(rejected)
      const created = events.find((event) => event.type === 'session.created')
      const position = new TranscriptPosition()
      const notes = new Map(events.map((event) => [event.seq, position.next(event)]))
      await database.save({
        sessionId: id,
        created: JSON.stringify(
          created?.type === 'session.created' ? created.session : model.session,
        ),
        state: JSON.stringify({ ...model, messages: [] }),
        index: JSON.stringify(entryFrom(model, 0)),
        diagnostics: JSON.stringify(diagnostics),
        lastSeq: model.lastSeq,
        events: savedEvents(events, notes),
        messages: savedMessages(model.messages),
        import: true,
      })
      await legacy.close()
      this.#diagnostics.set(id, diagnostics)
      this.#models.set(id, model)
      return model
    }
    return initialReadModel()
  }

  override async exists(id: string): Promise<boolean> {
    if (!this.#database) return super.exists(id)
    this.#validate(id)
    return (
      !!this.#models.get(id)?.session ||
      !!(await this.#database.head(id)) ||
      (await super.exists(id))
    )
  }
  override async loadExisting(id: string): Promise<SessionReadModel | null> {
    if (!this.#database) return super.loadExisting(id)
    return this.#serial(id, async () => {
      const model = await this.#model(id)
      return model.session ? model : null
    })
  }
  override async load(id: string): Promise<SessionReadModel> {
    return this.#database ? this.#serial(id, () => this.#model(id)) : super.load(id)
  }
  override async nextSeq(id: string): Promise<number> {
    return (await this.load(id)).lastSeq + 1
  }

  override async append(
    id: string,
    event: UnstampedEvent & { seq?: number; at?: number },
  ): Promise<JournalEvent> {
    if (!this.#database) return super.append(id, event)
    if (this.#closing) throw new Error('Conversation store is closing')
    return this.#serial(id, async () => {
      const model = await this.#model(id)
      const stamped = journalEventSchema.parse({
        ...event,
        sessionId: id,
        seq: event.seq ?? model.lastSeq + 1,
        at: event.at ?? Date.now(),
      })
      if (stamped.seq !== model.lastSeq + 1) throw new Error('Conversation sequence conflict')
      if (!model.session && stamped.type !== 'session.created')
        throw new Error('Conversation does not exist')
      if (stamped.type === 'session.created' && (stamped.session.id !== id || model.session))
        throw new Error('Conversation already exists or has an invalid identity')
      const note = this.#note(id, model, stamped)
      const post = applyEvent(model, stamped)
      const pending = this.#pending.get(id) ?? []
      pending.push(stamped)
      this.#pending.set(id, pending)
      const notes = this.#notes.get(id) ?? new Map<number, EventNote>()
      if (note) notes.set(stamped.seq, note)
      this.#notes.set(id, notes)
      if (stamped.type === 'user.message.added')
        this.#lastPart.set(id, {
          messageId: stamped.message.id,
          parts: stamped.message.parts.length,
        })
      if (stamped.type === 'assistant.parts.appended') {
        const message = post.messages.find((entry) => entry.id === stamped.messageId)
        if (message) this.#lastPart.set(id, { messageId: message.id, parts: message.parts.length })
      }
      const changed = this.#changed.get(id) ?? new Set<string>()
      if (stamped.type === 'assistant.parts.appended') changed.add(stamped.messageId)
      if (stamped.type === 'user.message.added') changed.add(stamped.message.id)
      this.#changed.set(id, changed)
      this.#models.set(id, post)
      if (stamped.type === 'assistant.parts.appended') this.#schedule(id)
      else {
        // Control transitions commit before they are published. A failed save
        // is tried once more at once (a crashed database worker restarts);
        // after that the batch stays queued and retries with backoff, since
        // refusing the event would strand the session: a turn could never
        // settle while the disk or the database is failing.
        try {
          await this.#flush(id).catch(() => this.#flush(id))
        } catch (error) {
          log.error('control event kept in memory until it can be saved', {
            sessionId: id,
            type: stamped.type,
            error: String(error),
          })
        }
      }
      for (const listener of this.#listeners) {
        try {
          listener(stamped)
        } catch {
          log.error('conversation event observer failed')
        }
      }
      return stamped
    })
  }

  /** What the stored row of `event` records beyond the event, judged before it applies. */
  #note(id: string, model: SessionReadModel, event: JournalEvent): EventNote | null {
    if (event.type === 'child.session.acknowledged') {
      const current = model.childCompletions?.[event.childSessionId]
      const known =
        (current?.turnId === event.turnId && current.acknowledged) ||
        current?.earlyAck === event.turnId
      return known ? { repeat: true } : null
    }
    if (event.type !== 'child.session.spawned') return null
    const last = model.messages.at(-1)
    const anchor =
      this.#lastPart.get(id) ?? (last ? { messageId: last.id, parts: last.parts.length } : null)
    return anchor ? { anchor } : null
  }

  /**
   * Saved messages and every non-message event, as of the last seq, in one
   * read. Opening a transcript from this costs its messages, not every
   * streamed delta. Null for conversations this store cannot snapshot.
   */
  async readConversationSnapshot(id: string): Promise<ConversationSnapshot | null> {
    const database = this.#database
    if (!database) return null
    for (let attempt = 0; attempt < 2; attempt++) {
      const snapshot = await this.#serial(id, async () => {
        // A legacy conversation is imported on first open, as a replay would.
        if (!this.#models.has(id) && !(await database.head(id))) await this.#model(id)
        await this.#flush(id)
        return database.snapshot(id)
      })
      if (!snapshot || !('stale' in snapshot)) return snapshot
      await this.#rebuildControls(id)
    }
    return null
  }

  /** Writes the event rows of a conversation saved before they existed, once. */
  async #rebuildControls(id: string): Promise<void> {
    const database = this.#database!
    const position = new TranscriptPosition()
    const events: JournalEvent[] = []
    const notes = new Map<number, EventNote>()
    let throughSeq = -1
    for (let afterId = 0; ;) {
      const batches = await database.history(id, afterId, true)
      if (!batches.length) break
      for (const batch of batches) {
        for (const value of JSON.parse(batch.json) as unknown[]) {
          const parsed = journalEventSchema.safeParse(value)
          if (!parsed.success || parsed.data.sessionId !== id) continue
          const event = parsed.data
          throughSeq = Math.max(throughSeq, event.seq)
          const note = position.next(event)
          if (!isControlEvent(event) || note.repeat) continue
          events.push(event)
          notes.set(event.seq, note)
        }
        afterId = batch.id
      }
    }
    await database.rebuildControls(id, throughSeq, savedEvents(events, notes))
  }

  #schedule(id: string, delay = SAVE_INTERVAL_MS): void {
    if (this.#timers.has(id)) return
    const timer = setTimeout(() => {
      this.#timers.delete(id)
      // close() saves what is left itself; a late retry must not restart the worker.
      if (this.#closing) return
      // Freeze one batch under the state lock, then release it while SQLite writes.
      void this.#serial(id, () => {
        if (!this.#writes.has(id)) void this.#startSave(id)
        return Promise.resolve()
      }).catch((error: unknown) =>
        log.error('conversation save could not start', { error: String(error) }),
      )
    }, delay)
    timer.unref()
    this.#timers.set(id, timer)
  }
  #startSave(id: string): Promise<void> | undefined {
    const timer = this.#timers.get(id)
    if (timer) clearTimeout(timer)
    this.#timers.delete(id)
    const events = this.#pending.get(id)
    if (!events?.length) return
    const model = this.#models.get(id)!
    const commit = {
      sessionId: id,
      created: JSON.stringify(model.session),
      state: JSON.stringify({ ...model, messages: [] }),
      index: JSON.stringify(entryFrom(model, 0)),
      diagnostics: JSON.stringify(this.replayDiagnostics(id)),
      lastSeq: model.lastSeq,
      events: savedEvents(events, this.#notes.get(id)),
      messages: savedMessages(model.messages, this.#changed.get(id)),
    }
    const notes = this.#notes.get(id)
    const changed = this.#changed.get(id)
    this.#pending.delete(id)
    this.#notes.delete(id)
    this.#changed.delete(id)
    const saving = this.#database!.save(commit).then(() => undefined)
    this.#writes.set(id, saving)
    void saving
      .then(
        () => {
          this.#failures.delete(id)
        },
        (error: unknown) => {
          // Put the batch back ahead of anything appended since, so the next
          // attempt writes the same contiguous run of events.
          this.#pending.set(id, [...events, ...(this.#pending.get(id) ?? [])])
          if (notes) this.#notes.set(id, new Map([...notes, ...(this.#notes.get(id) ?? [])]))
          if (changed)
            this.#changed.set(id, new Set([...changed, ...(this.#changed.get(id) ?? [])]))
          const failures = (this.#failures.get(id)?.attempts ?? 0) + 1
          const failure = error instanceof Error ? error : new Error(String(error))
          this.#failures.set(id, { error: failure, attempts: failures })
          log.error('conversation save failed; retrying', {
            sessionId: id,
            attempt: failures,
            error: failure.message,
          })
        },
      )
      .finally(() => {
        if (this.#writes.get(id) === saving) this.#writes.delete(id)
        // At most one write per session is retained; subsequent deltas keep coalescing.
        if (!this.#closing && this.#pending.get(id)?.length)
          this.#schedule(id, this.#retryDelay(id))
      })
    return saving
  }
  /** Backoff after failed saves: 250 ms doubling to 30 s. */
  #retryDelay(id: string): number {
    const attempts = this.#failures.get(id)?.attempts ?? 0
    return attempts === 0
      ? SAVE_INTERVAL_MS
      : Math.min(SAVE_INTERVAL_MS * 2 ** (attempts - 1), MAX_RETRY_MS)
  }
  async #flush(id: string): Promise<void> {
    for (;;) {
      const saving = this.#writes.get(id) ?? this.#startSave(id)
      if (!saving) return
      try {
        await saving
      } finally {
        if (this.#writes.get(id) === saving) this.#writes.delete(id)
      }
    }
  }
  async flush(id: string): Promise<void> {
    if (this.#database) await this.#serial(id, () => this.#flush(id))
    else await (await super.openJournal(id)).flush()
  }

  override async openJournal(id: string): Promise<Journal<JournalEvent>> {
    if (!this.#database) return super.openJournal(id)
    this.#validate(id)
    let history = this.#history.get(id)
    if (!history) {
      history = new ConversationHistory(this, id, this.#database, join(this.#root, id))
      this.#history.set(id, history)
    }
    return history
  }
  /** Full local hydration coalesces prose; remote resume keeps the exact raw sequence. */
  async *readConversationChunks(id: string): AsyncGenerator<JournalEvent[]> {
    const history = await this.openJournal(id)
    let pending: Extract<JournalEvent, { type: 'assistant.parts.appended' }> | null = null
    let characters = 0
    let output: JournalEvent[] = []
    const finish = (): void => {
      if (pending) output.push(pending)
      pending = null
      characters = 0
    }
    const chunks =
      history instanceof ConversationHistory
        ? history.read(256 * 1024, true)
        : history.readByChunk()
    for await (const chunk of chunks) {
      for (const entry of chunk) {
        if (entry.kind !== 'value') continue
        const event = entry.value
        if (
          this.#database &&
          event.type === 'assistant.parts.appended' &&
          event.parts.every((part) => part.type === 'text' || part.type === 'thinking')
        ) {
          const size = event.parts.reduce(
            (length, part) => length + ('text' in part ? part.text.length : 0),
            0,
          )
          if (pending && (pending.messageId !== event.messageId || characters + size > 64 * 1024))
            finish()
          pending ??= { ...event, replayFromSeq: event.seq, parts: [] }
          pending.seq = event.seq
          for (const part of event.parts) {
            const last = pending.parts.at(-1)
            if ((part.type === 'text' || part.type === 'thinking') && last?.type === part.type)
              last.text += part.text
            else pending.parts.push({ ...part })
          }
          characters += size
        } else {
          finish()
          output.push(event)
        }
      }
      // Publish each certified source chunk even if a later read fails.
      finish()
      if (output.length) {
        yield output
        output = []
      }
    }
    finish()
    if (output.length) yield output
  }
  override async closeJournal(id: string): Promise<void> {
    if (!this.#database) return super.closeJournal(id)
    await this.flush(id)
    this.#models.delete(id)
    this.#history.delete(id)
  }
  override replayDiagnostics(id: string): ReplayDiagnostics {
    return this.#database
      ? (this.#diagnostics.get(id) ?? { rejectedCount: 0, firstReason: null })
      : super.replayDiagnostics(id)
  }

  override async readReplayState(id: string, runtime: () => string | null) {
    if (!this.#database) return super.readReplayState(id, runtime)
    return this.#serial(id, async () => {
      let model = this.#models.get(id)
      if (!model) {
        const row = await this.#database!.head(id)
        if (row) {
          model = parseConversationState(JSON.parse(row.state_json))
          if (model.session?.id !== id || model.lastSeq !== row.last_seq)
            throw new Error('Conversation identity or sequence is invalid')
          this.#diagnostics.set(id, JSON.parse(row.diagnostics_json) as ReplayDiagnostics)
        } else model = await this.#model(id)
      }
      return {
        session: model.session,
        seq: model.lastSeq,
        liveTurnId: runtime(),
        incomplete: this.replayDiagnostics(id).rejectedCount > 0,
      }
    })
  }

  /** Every stored index row that parses; one unreadable row must not hide the rest. */
  async #indexes(): Promise<Map<string, SessionIndex>> {
    const entries = new Map<string, SessionIndex>()
    for (const row of await this.#database!.list()) {
      let index: SessionIndex | null
      try {
        index = parseSessionIndex(row.index_json)
      } catch {
        index = null
      }
      if (index) entries.set(row.id, index)
      else log.error('skipping a conversation whose index is invalid', { sessionId: row.id })
    }
    return entries
  }

  override async listSessions(): Promise<SessionListEntry[]> {
    if (!this.#database) return super.listSessions()
    const entries = await this.#indexes()
    // Include an unsaved streaming tail without writing it merely to list the sidebar.
    for (const [id, model] of this.#models) if (model.session) entries.set(id, entryFrom(model, 0))
    const list = [...entries].map(([id, entry]) => ({
      id,
      ...entry.hierarchy,
      projectId: entry.projectId,
      title: entry.title,
      updatedAt: entry.updatedAt,
      messageCount: entry.messageCount,
      lastMessagePreview: entry.lastMessagePreview,
      archived: entry.archived,
      pinned: entry.pinned,
    }))
    for (const entry of await super.listSessions(new Set(entries.keys()))) list.push(entry)
    return list.sort((a, b) => b.updatedAt - a.updatedAt)
  }
  override async currentHelmSession(): Promise<string | null> {
    if (!this.#database) return super.currentHelmSession()
    return (
      (await this.listSessions()).find((session) => isHelmSession(session) && !session.archived)
        ?.id ?? null
    )
  }
  override async usageSummary(): Promise<UsageSummary> {
    if (!this.#database) return super.usageSummary()
    const indexes = await this.#indexes()
    for (const [id, model] of this.#models) if (model.session) indexes.set(id, entryFrom(model, 0))
    const legacy = await super.usageSummary(new Set(indexes.keys()))
    const rows = legacy.rows.filter((row) => !indexes.has(row.sessionId))
    for (const [sessionId, entry] of indexes)
      if (entry.inputTokens || entry.outputTokens)
        rows.push({
          sessionId,
          title: entry.title,
          driverKind: entry.driverKind,
          updatedAt: entry.updatedAt,
          inputTokens: entry.inputTokens,
          outputTokens: entry.outputTokens,
          costUsd: entry.costUsd,
        })
    return {
      rows: rows.sort((a, b) => b.updatedAt - a.updatedAt),
      totals: rows.reduce(
        (total, row) => ({
          inputTokens: total.inputTokens + row.inputTokens,
          outputTokens: total.outputTokens + row.outputTokens,
          costUsd: row.costUsd === null ? total.costUsd : (total.costUsd ?? 0) + row.costUsd,
        }),
        { inputTokens: 0, outputTokens: 0, costUsd: null as number | null },
      ),
    }
  }

  override async destroy(id: string): Promise<void> {
    if (!this.#database) return super.destroy(id)
    await this.#serial(id, async () => {
      if (!(await this.exists(id))) {
        const error = new Error('Session not found.') as NodeJS.ErrnoException
        error.code = 'session_not_found'
        throw error
      }
      await this.#flush(id)
      await this.#database!.delete(id)
      const directory = join(this.#root, id)
      if (
        await stat(directory).catch((error) => {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
          throw error
        })
      )
        await super.destroy(id)
      this.#models.delete(id)
      this.#history.delete(id)
      this.#diagnostics.delete(id)
      this.#failures.delete(id)
      this.#notes.delete(id)
      this.#lastPart.delete(id)
    })
  }
  async close(): Promise<void> {
    if (this.#closing) return
    this.#closing = true
    try {
      await Promise.all([...this.#operations.values()].map((work) => work.catch(() => undefined)))
      await Promise.allSettled(this.#writes.values())
      for (const id of [...this.#pending.keys()])
        await this.flush(id).catch((error: unknown) =>
          log.error('conversation could not be saved before closing', {
            sessionId: id,
            error: String(error),
          }),
        )
    } finally {
      for (const timer of this.#timers.values()) clearTimeout(timer)
      this.#timers.clear()
      await this.#database?.close()
    }
  }
}

/** Compatibility reader for existing replay consumers; it writes no JSONL files. */
class ConversationHistory extends Journal<JournalEvent> {
  constructor(
    private readonly store: SessionStore,
    private readonly id: string,
    private readonly database: ConversationDatabase,
    dir: string,
  ) {
    super({ dir, name: 'journal', fsync: 'batch' })
  }
  override async open(): Promise<void> {}
  override async close(): Promise<void> {
    await this.store.flush(this.id)
  }
  override async flush(): Promise<void> {
    await this.store.flush(this.id)
  }
  override ensureTrailingNewline(): Promise<number> {
    return Promise.resolve(0)
  }
  override async append(event: JournalEvent): Promise<void> {
    await this.store.append(this.id, event)
  }
  override readByChunk(maxChunkChars = 256 * 1024): AsyncGenerator<ParsedLine<JournalEvent>[]> {
    return this.read(maxChunkChars, false)
  }
  /**
   * Chunks follow size, not stored rows: control events are saved one row
   * each, and a frame per row repainted a long transcript line by line.
   */
  async *read(
    maxChunkChars: number,
    transcript: boolean,
  ): AsyncGenerator<ParsedLine<JournalEvent>[]> {
    await this.store.load(this.id)
    await this.store.flush(this.id)
    let afterId = 0
    let line = 0
    let chunk: ParsedLine<JournalEvent>[] = []
    let bytes = 0
    for (;;) {
      const batches = await this.database.history(this.id, afterId, transcript)
      if (!batches.length) break
      for (const batch of batches) {
        for (const value of JSON.parse(batch.json) as unknown[]) {
          const raw = JSON.stringify(value)
          const parsed = journalEventSchema.safeParse(value)
          chunk.push(
            parsed.success
              ? { kind: 'value', value: parsed.data, raw, line: ++line }
              : { kind: 'error', message: 'Invalid conversation event', raw, line: ++line },
          )
          bytes += raw.length
        }
        afterId = batch.id
        if (bytes >= maxChunkChars) {
          yield chunk
          chunk = []
          bytes = 0
        }
      }
    }
    if (chunk.length) yield chunk
  }
  override async *readStrictByChunk(
    signal?: AbortSignal,
  ): AsyncGenerator<ParsedLine<JournalEvent>[]> {
    for await (const chunk of this.readByChunk()) {
      signal?.throwIfAborted()
      yield chunk
    }
  }
  override async readAll(): Promise<ParsedLine<JournalEvent>[]> {
    const events: ParsedLine<JournalEvent>[] = []
    for await (const chunk of this.readByChunk()) events.push(...chunk)
    return events
  }
}
