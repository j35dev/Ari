import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Command } from '@ari/contracts/commands'
import type { SessionStore } from '@ari/engine/session-store'
import { createLogger } from '@ari/shared/logger'

const log = createLogger('desktop:resume')

/** What a resumed session is told; it still holds the whole conversation. */
export const RESUME_PROMPT = 'Continue where you left off.'

/** A usage window resets within days, so anything later is a bad clock or a bad caller. */
const MAX_DELAY_MS = 8 * 24 * 60 * 60 * 1000
const SWEEP_INTERVAL_MS = 20_000

export interface ResumeEntry {
  sessionId: string
  /** The failed turn this resumes; a newer turn means the user already moved on. */
  turnId: string
  at: number
}

export interface ResumeScheduleOptions {
  /** JSON file the pending resumes survive a restart in. */
  path: string
  store: Pick<SessionStore, 'load'>
  dispatch(command: Command): Promise<{ accepted: boolean; reason?: string }>
  now?: () => number
}

/**
 * Sends "continue" to a session once its provider's usage window reopens.
 *
 * Each entry is tied to the turn that failed. When its time comes the session
 * must still be sitting on that same failure: if the user retried, sent
 * something else, or archived it in the meantime, the entry is dropped
 * instead of barging into a conversation that has moved on. An entry fires at
 * most once, whatever the outcome.
 */
export class ResumeSchedule {
  readonly #options: ResumeScheduleOptions
  #entries: ResumeEntry[] = []
  #timer: ReturnType<typeof setInterval> | null = null
  #sweeping: Promise<void> = Promise.resolve()

  constructor(options: ResumeScheduleOptions) {
    this.#options = options
  }

  #now(): number {
    return this.#options.now?.() ?? Date.now()
  }

  /** Reads what a previous run left pending. A missing or damaged file is an empty schedule. */
  async load(): Promise<void> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.#options.path, 'utf8'))
      this.#entries = Array.isArray(parsed)
        ? parsed.filter(
            (entry): entry is ResumeEntry =>
              typeof entry === 'object' &&
              entry !== null &&
              typeof (entry as ResumeEntry).sessionId === 'string' &&
              typeof (entry as ResumeEntry).turnId === 'string' &&
              typeof (entry as ResumeEntry).at === 'number',
          )
        : []
    } catch {
      this.#entries = []
    }
  }

  async #save(): Promise<void> {
    await mkdir(dirname(this.#options.path), { recursive: true })
    const temporary = `${this.#options.path}.tmp`
    await writeFile(temporary, JSON.stringify(this.#entries), 'utf8')
    await rename(temporary, this.#options.path)
  }

  /** When this session is due to resume, or null. */
  get(sessionId: string): number | null {
    return this.#entries.find((entry) => entry.sessionId === sessionId)?.at ?? null
  }

  /** Schedules the session's current failure to be resumed at `at`; replaces any earlier entry. */
  async schedule(sessionId: string, at: number): Promise<ResumeEntry> {
    if (!Number.isFinite(at) || at - this.#now() > MAX_DELAY_MS)
      throw new Error('resume time is out of range')
    const model = await this.#options.store.load(sessionId)
    if (!model.session) throw new Error('unknown session')
    if (model.activeTurnId !== null || model.lastTurn?.stopReason !== 'error')
      throw new Error('only a session whose last turn failed can be resumed')
    const entry: ResumeEntry = { sessionId, turnId: model.lastTurn.turnId, at }
    this.#entries = [...this.#entries.filter((other) => other.sessionId !== sessionId), entry]
    await this.#save()
    return entry
  }

  async cancel(sessionId: string): Promise<boolean> {
    const remaining = this.#entries.filter((entry) => entry.sessionId !== sessionId)
    if (remaining.length === this.#entries.length) return false
    this.#entries = remaining
    await this.#save()
    return true
  }

  start(): void {
    this.#timer ??= setInterval(() => void this.sweep(), SWEEP_INTERVAL_MS)
    this.#timer.unref?.()
  }

  close(): void {
    if (this.#timer !== null) clearInterval(this.#timer)
    this.#timer = null
  }

  /** Resumes every entry that is due. Serialized, and never rejects. */
  sweep(): Promise<void> {
    this.#sweeping = this.#sweeping.then(() => this.#sweep()).catch((error: unknown) => {
      log.warn('resume sweep failed', { error: String(error) })
    })
    return this.#sweeping
  }

  async #sweep(): Promise<void> {
    const now = this.#now()
    const due = this.#entries.filter((entry) => entry.at <= now)
    if (due.length === 0) return
    // Removed before dispatching: a crash mid-resume must not send it twice.
    this.#entries = this.#entries.filter((entry) => entry.at > now)
    await this.#save()
    for (const entry of due) {
      const model = await this.#options.store.load(entry.sessionId)
      if (
        !model.session ||
        model.session.archived ||
        model.activeTurnId !== null ||
        model.lastTurn?.turnId !== entry.turnId
      )
        continue
      const outcome = await this.#options.dispatch({
        type: 'turn.start',
        sessionId: entry.sessionId,
        text: RESUME_PROMPT,
        attachments: [],
      })
      if (!outcome.accepted)
        log.warn('scheduled resume was refused', {
          sessionId: entry.sessionId,
          reason: outcome.reason,
        })
    }
  }
}
