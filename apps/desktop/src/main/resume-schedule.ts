import { randomUUID } from 'node:crypto'
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

/** A repeating prompt firing more often than this is a mistake, not a routine. */
export const MIN_EVERY_MS = 5 * 60 * 1000

/**
 * One timed prompt. A resume is the special case with `turnId`: it may only
 * fire while that failed turn is still current. A routine has `prompt` and,
 * when it repeats, `every`.
 */
export interface RoutineEntry {
  id: string
  sessionId: string
  prompt: string
  at: number
  /** Re-arm interval in ms; absent for a one-shot prompt. */
  every?: number
  /** Resume only: the failed turn this entry belongs to. */
  turnId?: string
}

/** Backwards name for a resume entry; kept because the resume RPC speaks it. */
export type ResumeEntry = RoutineEntry

export interface RoutineAddInput {
  sessionId: string
  prompt: string
  /** Epoch ms of the first fire. */
  at: number
  /** Repeat interval in ms; at least {@link MIN_EVERY_MS}. */
  every?: number
}

export interface ResumeScheduleOptions {
  /** JSON file the pending entries survive a restart in. */
  path: string
  store: Pick<SessionStore, 'load'>
  dispatch(command: Command): Promise<{ accepted: boolean; reason?: string }>
  now?: () => number
}

/** A stored entry from before routines, or a damaged field inside a current one. */
function parseEntry(value: unknown): RoutineEntry | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const sessionId = record['sessionId']
  const at = record['at']
  if (typeof sessionId !== 'string' || typeof at !== 'number' || !Number.isFinite(at)) return null
  const turnId = typeof record['turnId'] === 'string' ? record['turnId'] : undefined
  const prompt =
    typeof record['prompt'] === 'string'
      ? record['prompt']
      : turnId !== undefined
        ? RESUME_PROMPT
        : null
  if (prompt === null || prompt.trim().length === 0) return null
  const every =
    typeof record['every'] === 'number' && Number.isFinite(record['every']) && record['every'] > 0
      ? record['every']
      : undefined
  return {
    id: typeof record['id'] === 'string' ? record['id'] : randomUUID(),
    sessionId,
    prompt,
    at,
    ...(every !== undefined ? { every } : {}),
    ...(turnId !== undefined ? { turnId } : {}),
  }
}

/**
 * Persists timed prompts in `path` and sends them once their time comes.
 *
 * A resume is tied to the turn that failed. When its time comes the session
 * must still be sitting on that same failure: if the user retried, sent
 * something else, or archived it in the meantime, the entry is dropped
 * instead of barging into a conversation that has moved on.
 *
 * A routine carries its own prompt. One-shot entries leave the list when they
 * fire; `every` entries re-arm to the next slot, skipping any slots missed
 * while Ari was closed, so a long sleep never produces a burst.
 */
export class ResumeSchedule {
  readonly #options: ResumeScheduleOptions
  #entries: RoutineEntry[] = []
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
        ? parsed.map(parseEntry).filter((entry): entry is RoutineEntry => entry !== null)
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

  /**
   * When this session is due to resume, or null. An entry whose failed turn is
   * no longer where the session stands will never fire, so it is dropped here
   * rather than reported: the banner must not promise a resume that the sweep
   * is going to skip.
   */
  async get(sessionId: string): Promise<number | null> {
    const entry = this.#entries.find(
      (other) => other.sessionId === sessionId && other.turnId !== undefined,
    )
    if (entry === undefined) return null
    const model = await this.#options.store.load(sessionId)
    if (model.activeTurnId === null && model.lastTurn?.turnId === entry.turnId) return entry.at
    await this.cancel(sessionId)
    return null
  }

  /** Schedules the session's current failure to be resumed at `at`; replaces any earlier resume. */
  async schedule(sessionId: string, at: number): Promise<ResumeEntry> {
    if (!Number.isFinite(at) || at - this.#now() > MAX_DELAY_MS)
      throw new Error('resume time is out of range')
    const model = await this.#options.store.load(sessionId)
    if (!model.session) throw new Error('unknown session')
    if (model.activeTurnId !== null || model.lastTurn?.stopReason !== 'error')
      throw new Error('only a session whose last turn failed can be resumed')
    const entry: RoutineEntry = {
      id: randomUUID(),
      sessionId,
      prompt: RESUME_PROMPT,
      at,
      turnId: model.lastTurn.turnId,
    }
    this.#entries = [
      ...this.#entries.filter(
        (other) => !(other.sessionId === sessionId && other.turnId !== undefined),
      ),
      entry,
    ]
    await this.#save()
    return entry
  }

  /** Adds a scheduled prompt. `every` must be at least {@link MIN_EVERY_MS}. */
  async add(input: RoutineAddInput): Promise<RoutineEntry> {
    const prompt = input.prompt.trim()
    if (prompt.length === 0) throw new Error('prompt is empty')
    if (!Number.isFinite(input.at)) throw new Error('schedule time is invalid')
    if (input.every !== undefined) {
      if (!Number.isFinite(input.every) || input.every < MIN_EVERY_MS)
        throw new Error(`repeat interval must be at least ${String(MIN_EVERY_MS / 60_000)} minutes`)
      if (!Number.isInteger(input.every)) throw new Error('repeat interval must be whole ms')
    }
    const model = await this.#options.store.load(input.sessionId)
    if (!model.session) throw new Error('unknown session')
    if (model.session.archived === true) throw new Error('session is archived')
    const entry: RoutineEntry = {
      id: randomUUID(),
      sessionId: input.sessionId,
      prompt,
      at: input.at,
      ...(input.every !== undefined ? { every: input.every } : {}),
    }
    this.#entries = [...this.#entries, entry]
    await this.#save()
    return entry
  }

  /** Scheduled prompts, soonest first. Resume entries are reported by `get`, not here. */
  list(): RoutineEntry[] {
    return this.#entries
      .filter((entry) => entry.turnId === undefined)
      .slice()
      .sort((a, b) => a.at - b.at)
  }

  /** Removes a scheduled prompt by id. Resumes are addressed by session instead. */
  async remove(id: string): Promise<boolean> {
    const remaining = this.#entries.filter((entry) => entry.id !== id || entry.turnId !== undefined)
    if (remaining.length === this.#entries.length) return false
    this.#entries = remaining
    await this.#save()
    return true
  }

  async cancel(sessionId: string): Promise<boolean> {
    const remaining = this.#entries.filter(
      (entry) => entry.sessionId !== sessionId || entry.turnId === undefined,
    )
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

  /** Fires every entry that is due. Serialized, and never rejects. */
  sweep(): Promise<void> {
    this.#sweeping = this.#sweeping
      .then(() => this.#sweep())
      .catch((error: unknown) => {
        log.warn('resume sweep failed', { error: String(error) })
      })
    return this.#sweeping
  }

  async #sweep(): Promise<void> {
    const now = this.#now()
    const due = this.#entries.filter((entry) => entry.at <= now)
    if (due.length === 0) return
    // Removed before dispatching: a crash mid-dispatch must not send it twice.
    // A repeating entry re-arms right away, to the first slot after now, so a
    // long gap does not queue every missed run at once.
    this.#entries = this.#entries.filter((entry) => entry.at > now)
    for (const entry of due) {
      if (entry.every === undefined) continue
      const next = entry.at + entry.every * (Math.floor((now - entry.at) / entry.every) + 1)
      this.#entries.push({ ...entry, at: next })
    }
    await this.#save()

    for (const entry of due) {
      // Each on its own: one session that cannot be read must not cost the
      // others their turn, since every due entry is already off the list.
      try {
        const model = await this.#options.store.load(entry.sessionId)
        if (!model.session || model.session.archived === true) {
          if (entry.turnId === undefined)
            log.warn('routine dropped: session is gone or archived', {
              sessionId: entry.sessionId,
              routineId: entry.id,
            })
          continue
        }
        if (entry.turnId !== undefined) {
          if (model.activeTurnId !== null || model.lastTurn?.turnId !== entry.turnId) continue
        }
        const outcome = await this.#options.dispatch({
          type: 'turn.start',
          sessionId: entry.sessionId,
          text: entry.prompt,
          attachments: [],
        })
        if (!outcome.accepted)
          log.warn('scheduled prompt was refused', {
            sessionId: entry.sessionId,
            routineId: entry.turnId === undefined ? entry.id : undefined,
            reason: outcome.reason,
          })
      } catch (error) {
        log.warn('scheduled prompt failed', { sessionId: entry.sessionId, error: String(error) })
      }
    }
  }
}
