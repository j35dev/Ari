import { join } from 'node:path'
import type { JournalEvent } from '@ari/contracts/events'
import { newTypedId } from '@ari/shared/ids'
import { Journal } from './journal'
import { applyEvent, initialReadModel, type SessionReadModel, type UnstampedEvent } from './projection'

export interface SessionStoreOptions {
  /** Root directory, e.g. `<userData>/sessions`. */
  rootDir: string
}

/**
 * Sidebar listing fields mirrored into `<sessionId>/index.json` so
 * `listSessions()` never has to full-replay every journal. `journalBytes` is
 * the on-disk size the entry was computed at: any mismatch (crash between
 * journal append and index write, external mutation) falls back to one
 * authoritative replay that repairs the index. The M18.5 token/cost fields
 * feed `usageSummary()` from the same sidecar.
 */
interface SessionIndex {
  version: 2
  lastSeq: number
  hasSession: boolean
  projectId: string
  title: string
  updatedAt: number
  messageCount: number
  driverKind: string
  inputTokens: number
  outputTokens: number
  costUsd: number | null
  journalBytes: number
}

export interface SessionListEntry {
  id: string
  projectId: string
  title: string
  updatedAt: number
  messageCount: number
}

/** One per-session row of the usage dashboard. */
export interface UsageRow {
  sessionId: string
  title: string
  /** Driver that ran the session, mirrored from the session record. */
  driverKind: string
  updatedAt: number
  inputTokens: number
  outputTokens: number
  costUsd: number | null
}

export interface UsageSummary {
  rows: UsageRow[]
  totals: { inputTokens: number; outputTokens: number; costUsd: number | null }
}

const INDEX_VERSION = 2

function entryFrom(model: SessionReadModel, journalBytes: number): SessionIndex {
  return {
    version: INDEX_VERSION,
    lastSeq: model.lastSeq,
    hasSession: model.session !== null,
    projectId: model.session?.projectId ?? '',
    title: model.session?.title ?? '',
    updatedAt: model.session?.updatedAt ?? 0,
    messageCount: model.messages.length,
    driverKind: model.session?.driverKind ?? '',
    inputTokens: model.usage.inputTokens,
    outputTokens: model.usage.outputTokens,
    costUsd: model.usage.costUsd,
    journalBytes,
  }
}

function parseSessionIndex(raw: string): SessionIndex | null {
  let value: Record<string, unknown>
  try {
    value = JSON.parse(raw) as Record<string, unknown>
  } catch {
    return null
  }
  const cost = value['costUsd']
  if (
    value['version'] !== INDEX_VERSION ||
    typeof value['lastSeq'] !== 'number' ||
    typeof value['hasSession'] !== 'boolean' ||
    typeof value['projectId'] !== 'string' ||
    typeof value['title'] !== 'string' ||
    typeof value['updatedAt'] !== 'number' ||
    typeof value['messageCount'] !== 'number' ||
    typeof value['driverKind'] !== 'string' ||
    typeof value['inputTokens'] !== 'number' ||
    typeof value['outputTokens'] !== 'number' ||
    !(cost === null || typeof cost === 'number') ||
    typeof value['journalBytes'] !== 'number'
  ) {
    return null
  }
  return {
    version: 2,
    lastSeq: value['lastSeq'],
    hasSession: value['hasSession'],
    projectId: value['projectId'],
    title: value['title'],
    updatedAt: value['updatedAt'],
    messageCount: value['messageCount'],
    driverKind: value['driverKind'],
    inputTokens: value['inputTokens'],
    outputTokens: value['outputTokens'],
    costUsd: cost,
    journalBytes: value['journalBytes'],
  }
}

/**
 * Owns per-session journals on disk: `<rootDir>/<sessionId>/journal.jsonl`.
 * All writes go through the append-only journal; reads fold events into the
 * read model via {@link applyEvent}.
 */
export class SessionStore {
  readonly #rootDir: string
  readonly #journals = new Map<string, Journal<JournalEvent>>()
  /** In-memory mirror of the sidecar index; disk copy stays authoritative. */
  readonly #indexCache = new Map<string, SessionIndex>()

  constructor(options: SessionStoreOptions) {
    this.#rootDir = options.rootDir
  }

  #dirFor(sessionId: string): string {
    return join(this.#rootDir, sessionId)
  }

  async openJournal(sessionId: string): Promise<Journal<JournalEvent>> {
    const existing = this.#journals.get(sessionId)
    if (existing) return existing
    const journal = new Journal<JournalEvent>({ dir: this.#dirFor(sessionId), name: 'journal' })
    await journal.open()
    this.#journals.set(sessionId, journal)
    return journal
  }

  async closeJournal(sessionId: string): Promise<void> {
    const journal = this.#journals.get(sessionId)
    if (!journal) return
    await journal.close()
    this.#journals.delete(sessionId)
  }

  /** Next sequence number for a session (max known seq + 1). */
  async nextSeq(sessionId: string): Promise<number> {
    const model = await this.load(sessionId)
    return model.lastSeq + 1
  }

  /**
   * Appends one event, stamping `seq` and `at` if the caller omitted them.
   * Returns the event as written. The sidecar index is refreshed *before*
   * the journal line lands so nothing observes a journaled event whose index
   * entry is still pending; a crash in between leaves the index ahead of the
   * journal, which the byte-mismatch replay path repairs.
   */
  async append(
    sessionId: string,
    event: UnstampedEvent & { seq?: number; at?: number },
  ): Promise<JournalEvent> {
    const journal = await this.openJournal(sessionId)
    const model = await this.load(sessionId)
    const stamped = {
      ...event,
      seq: event.seq ?? model.lastSeq + 1,
      at: event.at ?? Date.now(),
      sessionId,
    }
    const cachedBytes = this.#indexCache.get(sessionId)?.journalBytes
    const prevBytes = cachedBytes ?? (await this.#measureJournalBytes(sessionId))
    const post = applyEvent(model, stamped)
    const lineBytes = Buffer.byteLength(JSON.stringify(stamped), 'utf8') + 1
    const entry = entryFrom(post, prevBytes + lineBytes)
    await this.#writeIndex(sessionId, entry)
    await journal.append(stamped)
    this.#indexCache.set(sessionId, entry)
    return stamped
  }

  /** Replays the full journal into a read model. */
  async load(sessionId: string): Promise<SessionReadModel> {
    const journal = await this.openJournal(sessionId)
    const entries = await journal.readAll()
    let state = initialReadModel()
    for (const entry of entries) {
      if (entry.kind === 'value') state = applyEvent(state, entry.value)
    }
    return state
  }

  /**
   * Lightweight index for the sidebar: served from `<sessionId>/index.json`
   * (kept fresh by {@link append}) and only falling back to a full journal
   * replay when the index is missing, corrupt, or stale relative to the
   * journal bytes on disk. The fallback also repairs the sidecar.
   */
  async listSessions(): Promise<SessionListEntry[]> {
    const { readdir } = await import('node:fs/promises')
    let dirs: string[]
    try {
      dirs = await readdir(this.#rootDir)
    } catch {
      return []
    }
    const out: SessionListEntry[] = []
    for (const id of dirs) {
      try {
        const entry = await this.#listingFor(id)
        if (entry) out.push({ id, ...entry })
      } catch {
        // unreadable dir — skip rather than break listing
      }
    }
    out.sort((a, b) => b.updatedAt - a.updatedAt)
    return out
  }

  /** Sidebar fields for one session; null when no session ever existed. */
  async #listingFor(id: string): Promise<Omit<SessionListEntry, 'id'> | null> {
    const entry = await this.#indexFor(id)
    return entry ? this.#fields(entry) : null
  }

  /**
   * Fresh sidecar index for one session directory: served from the in-memory
   * cache or disk when the journal size matches, else one authoritative
   * replay that also repairs the sidecar. Null when no session ever existed.
   */
  async #indexFor(id: string): Promise<SessionIndex | null> {
    const bytes = await this.#measureJournalBytes(id)
    const cached = this.#indexCache.get(id)
    if (cached && cached.journalBytes === bytes) return cached
    const { readFile } = await import('node:fs/promises')
    let disk: SessionIndex | null
    try {
      disk = parseSessionIndex(await readFile(this.#indexPath(id), 'utf8'))
    } catch {
      disk = null
    }
    if (disk && disk.journalBytes === bytes) {
      this.#indexCache.set(id, disk)
      return disk.hasSession ? disk : null
    }
    // Stale, missing, corrupt, or old-version index: one replay, then repair.
    const model = await this.load(id)
    const entry = entryFrom(model, bytes)
    this.#indexCache.set(id, entry)
    await this.#writeIndex(id, entry)
    return model.session ? entry : null
  }

  /**
   * Token totals for the usage dashboard, served from the same sidecar
   * indexes as {@link listSessions} — no journal replay on the warm path.
   * Rows cover only sessions that actually recorded tokens, newest first.
   */
  async usageSummary(): Promise<UsageSummary> {
    const emptyTotals: UsageSummary['totals'] = {
      inputTokens: 0,
      outputTokens: 0,
      costUsd: null,
    }
    const { readdir } = await import('node:fs/promises')
    let dirs: string[]
    try {
      dirs = await readdir(this.#rootDir)
    } catch {
      return { rows: [], totals: emptyTotals }
    }
    const rows: UsageRow[] = []
    const totals = { ...emptyTotals }
    for (const id of dirs) {
      try {
        const entry = await this.#indexFor(id)
        if (!entry || (entry.inputTokens === 0 && entry.outputTokens === 0)) continue
        rows.push({
          sessionId: id,
          title: entry.title,
          driverKind: entry.driverKind,
          updatedAt: entry.updatedAt,
          inputTokens: entry.inputTokens,
          outputTokens: entry.outputTokens,
          costUsd: entry.costUsd,
        })
        totals.inputTokens += entry.inputTokens
        totals.outputTokens += entry.outputTokens
        if (entry.costUsd !== null) totals.costUsd = (totals.costUsd ?? 0) + entry.costUsd
      } catch {
        // unreadable dir — skip rather than break the summary
      }
    }
    rows.sort((a, b) => b.updatedAt - a.updatedAt)
    return { rows, totals }
  }

  #fields(entry: SessionIndex): Omit<SessionListEntry, 'id'> {
    return {
      projectId: entry.projectId,
      title: entry.title,
      updatedAt: entry.updatedAt,
      messageCount: entry.messageCount,
    }
  }

  #indexPath(sessionId: string): string {
    return join(this.#dirFor(sessionId), 'index.json')
  }

  /** Total on-disk size of every journal segment for a session. */
  async #measureJournalBytes(sessionId: string): Promise<number> {
    const { readdir, stat } = await import('node:fs/promises')
    const dir = this.#dirFor(sessionId)
    const pattern = /^journal\.\d{4}\.jsonl$/
    let names: string[]
    try {
      names = await readdir(dir)
    } catch {
      return 0
    }
    let total = 0
    for (const name of names) {
      if (!pattern.test(name)) continue
      total += (await stat(join(dir, name))).size
    }
    return total
  }

  /** Atomic sidecar write (temp file + rename) so readers never see a torn JSON. */
  async #writeIndex(sessionId: string, entry: SessionIndex): Promise<void> {
    const { rename, writeFile } = await import('node:fs/promises')
    const target = this.#indexPath(sessionId)
    const tmp = `${target}.tmp`
    try {
      await writeFile(tmp, JSON.stringify(entry), 'utf8')
      await rename(tmp, target)
    } catch {
      // Index maintenance is best-effort; staleness falls back to replay.
    }
  }

  mintTurnId(): string {
    return newTypedId('turn')
  }

  mintMessageId(): string {
    return newTypedId('msg')
  }

  async destroy(sessionId: string): Promise<void> {
    await this.closeJournal(sessionId)
    this.#indexCache.delete(sessionId)
    const { rm } = await import('node:fs/promises')
    await rm(this.#dirFor(sessionId), { recursive: true, force: true })
  }
}
