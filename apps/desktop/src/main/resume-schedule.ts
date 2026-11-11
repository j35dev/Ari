import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { ControlFailure, ROUTINE_MIN_EVERY_MS } from '@ari/contracts/agent-control'
import type { Command } from '@ari/contracts/commands'
import type { ControlHost } from '@ari/engine/agent-control'
import type { SessionStore } from '@ari/engine/session-store'
import { CONTINUATION_PROMPT } from '@ari/engine/delegation-state'
import { createLogger } from '@ari/shared/logger'

const log = createLogger('desktop:resume')

/** What a resumed session is told; it still holds the whole conversation. */
export const RESUME_PROMPT = CONTINUATION_PROMPT

/** A usage window resets within days, so anything later is a bad clock or a bad caller. */
const MAX_DELAY_MS = 8 * 24 * 60 * 60 * 1000
const SWEEP_INTERVAL_MS = 20_000

/** A repeating prompt firing more often than this is a mistake, not a routine. */
export const MIN_EVERY_MS = ROUTINE_MIN_EVERY_MS

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
  /** Optional feature gate; a disabled destination keeps its scheduled prompts. */
  enabled?(sessionId: string): Promise<boolean>
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
  #transactions: Promise<void> = Promise.resolve()
  #sweeping = false

  constructor(options: ResumeScheduleOptions) {
    this.#options = options
  }

  #now(): number {
    return this.#options.now?.() ?? Date.now()
  }

  /** Owns all state reads/mutations that await, including the shared temporary file. */
  #transaction<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#transactions.then(operation)
    // A rejected mutation reaches its caller without poisoning later transactions.
    this.#transactions = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  /** Missing/damaged JSON is empty; other disk errors reject without replacing state. */
  load(): Promise<void> {
    return this.#transaction(async () => {
      let contents: string
      try {
        contents = await readFile(this.#options.path, 'utf8')
      } catch (error) {
        if (
          error === null ||
          typeof error !== 'object' ||
          !('code' in error) ||
          error.code !== 'ENOENT'
        )
          throw error
        this.#entries = []
        return
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(contents)
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error
        log.warn('damaged resume schedule', { error: String(error) })
        this.#entries = []
        return
      }
      this.#entries = Array.isArray(parsed)
        ? parsed.map(parseEntry).filter((entry): entry is RoutineEntry => entry !== null)
        : []
    })
  }

  /** Called only inside a transaction; publish state only after the rename succeeds. */
  async #save(entries: RoutineEntry[]): Promise<void> {
    await mkdir(dirname(this.#options.path), { recursive: true })
    const temporary = `${this.#options.path}.tmp`
    await writeFile(temporary, JSON.stringify(entries), 'utf8')
    await rename(temporary, this.#options.path)
    this.#entries = entries
  }

  /**
   * When this session is due to resume, or null. An entry whose failed turn is
   * no longer where the session stands will never fire, so it is dropped here
   * rather than reported: the banner must not promise a resume that the sweep
   * is going to skip.
   */
  get(sessionId: string): Promise<number | null> {
    return this.#transaction(async () => {
      const entry = this.#entries.find(
        (other) => other.sessionId === sessionId && other.turnId !== undefined,
      )
      if (entry === undefined) return null
      const model = await this.#options.store.load(sessionId)
      if (model.activeTurnId === null && model.lastTurn?.turnId === entry.turnId) return entry.at
      await this.#save(
        this.#entries.filter(
          (other) => other.sessionId !== sessionId || other.turnId === undefined,
        ),
      )
      return null
    })
  }

  /** Schedules the session's current failure to be resumed at `at`; replaces any earlier resume. */
  schedule(sessionId: string, at: number): Promise<ResumeEntry> {
    return this.#transaction(async () => {
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
      await this.#save([
        ...this.#entries.filter(
          (other) => !(other.sessionId === sessionId && other.turnId !== undefined),
        ),
        entry,
      ])
      return { ...entry }
    })
  }

  /** Adds a scheduled prompt. `every` must be at least {@link MIN_EVERY_MS}. */
  add(input: RoutineAddInput): Promise<RoutineEntry> {
    return this.#transaction(async () => {
      const prompt = input.prompt.trim()
      if (prompt.length === 0) throw new Error('prompt is empty')
      if (!Number.isFinite(input.at)) throw new Error('schedule time is invalid')
      if (input.every !== undefined) {
        if (!Number.isFinite(input.every) || input.every < MIN_EVERY_MS)
          throw new Error(
            `repeat interval must be at least ${String(MIN_EVERY_MS / 60_000)} minutes`,
          )
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
      await this.#save([...this.#entries, entry])
      return { ...entry }
    })
  }

  /** Scheduled prompts, soonest first. Resume entries are reported by `get`, not here. */
  list(): RoutineEntry[] {
    return this.#entries
      .filter((entry) => entry.turnId === undefined)
      .map((entry) => ({ ...entry }))
      .sort((a, b) => a.at - b.at)
  }

  /** Removes a scheduled prompt by id. Resumes are addressed by session instead. */
  remove(id: string): Promise<boolean> {
    return this.#transaction(async () => {
      const remaining = this.#entries.filter(
        (entry) => entry.id !== id || entry.turnId !== undefined,
      )
      if (remaining.length === this.#entries.length) return false
      await this.#save(remaining)
      return true
    })
  }

  cancel(sessionId: string): Promise<boolean> {
    return this.#transaction(async () => {
      const remaining = this.#entries.filter(
        (entry) => entry.sessionId !== sessionId || entry.turnId === undefined,
      )
      if (remaining.length === this.#entries.length) return false
      await this.#save(remaining)
      return true
    })
  }

  start(): void {
    this.#timer ??= setInterval(() => void this.sweep(), SWEEP_INTERVAL_MS)
    this.#timer.unref?.()
  }

  close(): void {
    if (this.#timer !== null) clearInterval(this.#timer)
    this.#timer = null
  }

  /** Fires due entries; calls during an active sweep are no-ops, and never reject. */
  sweep(): Promise<void> {
    // Coalesce timer ticks instead of building a backlog during slow dispatch.
    // A dispatch may itself await sweep(), so it cannot wait for the active sweep.
    if (this.#sweeping) return Promise.resolve()
    this.#sweeping = true
    return this.#sweep()
      .catch((error: unknown) => {
        log.warn('resume sweep failed', { error: String(error) })
      })
      .finally(() => {
        this.#sweeping = false
      })
  }

  async #sweep(): Promise<void> {
    const due = await this.#transaction(async () => {
      const now = this.#now()
      const due: RoutineEntry[] = []
      for (const entry of this.#entries)
        if (entry.at <= now && (await this.#options.enabled?.(entry.sessionId)) !== false)
          due.push(entry)
      if (due.length === 0) return due
      // Persist consumption before dispatch: a crash may lose this occurrence,
      // but must not replay it. A failed save retains it and dispatches nothing.
      const dueIds = new Set(due.map((entry) => entry.id))
      const remaining = this.#entries.filter((entry) => !dueIds.has(entry.id))
      for (const entry of due) {
        if (entry.every === undefined) continue
        const next = entry.at + entry.every * (Math.floor((now - entry.at) / entry.every) + 1)
        remaining.push({ ...entry, at: next })
      }
      await this.#save(remaining)
      return due
    })

    // The state transaction is released before store/dispatch work: dispatch can
    // reenter scheduler APIs without deadlocking on the transaction that claimed it.
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

/**
 * The agent-control view of one schedule. A refusal from the store (an empty
 * prompt, a bad time, an archived session) is the caller's mistake, so it
 * reaches the CLI as `invalid_request` with the store's own wording.
 */
export function routineHost(
  schedule: Pick<ResumeSchedule, 'add' | 'list' | 'remove'>,
): NonNullable<ControlHost['routines']> {
  return {
    add: async (input) => {
      try {
        const entry = await schedule.add({
          sessionId: input.sessionId,
          prompt: input.prompt,
          at: input.at,
          ...(input.everyMs === undefined ? {} : { every: input.everyMs }),
        })
        return {
          id: entry.id,
          sessionId: entry.sessionId,
          prompt: entry.prompt,
          at: entry.at,
          everyMs: entry.every ?? null,
        }
      } catch (error) {
        throw new ControlFailure(
          'invalid_request',
          error instanceof Error ? error.message : 'Invalid schedule.',
        )
      }
    },
    list: () =>
      schedule.list().map((entry) => ({
        id: entry.id,
        sessionId: entry.sessionId,
        prompt: entry.prompt,
        at: entry.at,
        everyMs: entry.every ?? null,
      })),
    remove: (id) => schedule.remove(id),
  }
}
