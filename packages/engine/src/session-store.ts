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
 * Owns per-session journals on disk: `<rootDir>/<sessionId>/journal.jsonl`.
 * All writes go through the append-only journal; reads fold events into the
 * read model via {@link applyEvent}.
 */
export class SessionStore {
  readonly #rootDir: string
  readonly #journals = new Map<string, Journal<JournalEvent>>()

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
   * Returns the event as written.
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
    await journal.append(stamped)
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

  /** Lightweight index for the sidebar: first event of every session dir. */
  async listSessions(): Promise<
    { id: string; projectId: string; title: string; updatedAt: number }[]
  > {
    const { readdir } = await import('node:fs/promises')
    let dirs: string[]
    try {
      dirs = await readdir(this.#rootDir)
    } catch {
      return []
    }
    const out: { id: string; projectId: string; title: string; updatedAt: number }[] = []
    for (const id of dirs) {
      try {
        const model = await this.load(id)
        if (model.session) {
          out.push({
            id,
            projectId: model.session.projectId,
            title: model.session.title,
            updatedAt: model.session.updatedAt,
          })
        }
      } catch {
        // unreadable dir — skip rather than break listing
      }
    }
    out.sort((a, b) => b.updatedAt - a.updatedAt)
    return out
  }

  mintTurnId(): string {
    return newTypedId('turn')
  }

  mintMessageId(): string {
    return newTypedId('msg')
  }

  async destroy(sessionId: string): Promise<void> {
    await this.closeJournal(sessionId)
    const { rm } = await import('node:fs/promises')
    await rm(this.#dirFor(sessionId), { recursive: true, force: true })
  }
}
