import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  BOT_ROUTINE_COMMIT_DEBOUNCE_MS,
  BOT_ROUTINE_MAX_ENABLED,
  BOT_ROUTINE_MAX_FAILURES,
  BOT_ROUTINE_MIN_EVERY_MS,
  botRoutineSchema,
  type BotRoutine,
  type BotRoutineAdd,
} from '@ari/contracts/routine'
import type { BotStore } from '@ari/engine/bots'
import { watchBranchHead } from '@ari/engine/git'
import {
  latestRoutineTurnId,
  nextFireAt,
  routineIsPending,
  routineMessage,
} from '@ari/engine/bot-routines'
import type { SessionStore } from '@ari/engine/session-store'
import type { Command } from '@ari/contracts/commands'
import type { MessageOrigin } from '@ari/contracts/message'
import type { Session } from '@ari/contracts/session'
import { createLogger } from '@ari/shared/logger'

const log = createLogger('desktop:bot-routines')

const SWEEP_INTERVAL_MS = 20_000

/** A routine run always starts in the same place: its bot's main session. */
export interface BotRoutineDeps {
  /** JSON file the routines survive a restart in. */
  path: string
  bots: Pick<BotStore, 'get'>
  store: Pick<SessionStore, 'load'>
  /** The repo a commit routine watches: its bot session's workspace. */
  workspace(session: Session): Promise<string | null>
  dispatch(
    command: Command,
    origin?: MessageOrigin,
  ): Promise<{ accepted: boolean; reason?: string }>
  now?: () => number
}

/**
 * Per-bot timed or commit-triggered prompts that feed the Hive bot's own session.
 *
 * A routine fires as a held, routine-priority message, so a person's turn and
 * a room turn always go first. A fire is skipped while the same routine still
 * has work pending, and missed windows are skipped rather than replayed in a
 * burst. A commit routine fires once per new commit on its branch, after its
 * debounce. Ten failed runs switch it off instead of retrying forever.
 */
export class BotRoutineSchedule {
  readonly #deps: BotRoutineDeps
  #entries: BotRoutine[] = []
  #timer: ReturnType<typeof setInterval> | null = null
  #sweeping: Promise<void> = Promise.resolve()
  readonly #watchers = new Map<string, () => Promise<void>>()
  readonly #debounces = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(deps: BotRoutineDeps) {
    this.#deps = deps
  }

  #now(): number {
    return this.#deps.now?.() ?? Date.now()
  }

  async load(): Promise<void> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.#deps.path, 'utf8'))
      this.#entries = Array.isArray(parsed)
        ? parsed.flatMap((value) => {
            const result = botRoutineSchema.safeParse(value)
            return result.success ? [result.data] : []
          })
        : []
    } catch {
      this.#entries = []
    }
  }

  async #save(): Promise<void> {
    await mkdir(dirname(this.#deps.path), { recursive: true })
    const temporary = `${this.#deps.path}.${randomUUID()}.tmp`
    await writeFile(temporary, JSON.stringify(this.#entries), 'utf8')
    await rename(temporary, this.#deps.path)
  }

  list(): BotRoutine[] {
    const at = (routine: BotRoutine): number =>
      routine.kind === 'schedule' ? routine.at : Number.POSITIVE_INFINITY
    return this.#entries.slice().sort((a, b) => at(a) - at(b) || a.id.localeCompare(b.id))
  }

  async add(input: BotRoutineAdd): Promise<BotRoutine> {
    const prompt = input.prompt.trim()
    if (prompt.length === 0) throw new Error('routine prompt is empty')
    if (input.kind === 'schedule') {
      if (!Number.isFinite(input.at)) throw new Error('routine time is invalid')
      if (!Number.isInteger(input.everyMs) || input.everyMs < BOT_ROUTINE_MIN_EVERY_MS)
        throw new Error(
          `repeat interval must be at least ${String(BOT_ROUTINE_MIN_EVERY_MS / 60_000)} minutes`,
        )
    }
    const bot = await this.#deps.bots.get(input.botId)
    if (bot === null) throw new Error('unknown bot')
    if (bot.mainSessionId === undefined) throw new Error('bot has no main session')
    const model = await this.#deps.store.load(bot.mainSessionId)
    if (!model.session) throw new Error('bot session is missing')
    if (input.kind === 'commit' && (await this.#deps.workspace(model.session)) === null)
      throw new Error('bot workspace is unavailable')
    if (this.#enabledCount() >= BOT_ROUTINE_MAX_ENABLED)
      throw new Error(`at most ${String(BOT_ROUTINE_MAX_ENABLED)} routines can be enabled`)

    const routine = botRoutineSchema.parse({
      ...input,
      id: `routine_${randomUUID()}`,
      botId: bot.id,
      prompt,
      enabled: true,
      consecutiveFailures: 0,
      lastOutcomeTurnId: null,
      disabledReason: null,
    })
    this.#entries = [...this.#entries, routine]
    await this.#save()
    void this.#serial(() => this.#syncWatchers())
    return routine
  }

  async setEnabled(id: string, enabled: boolean): Promise<BotRoutine> {
    const routine = this.#entries.find((entry) => entry.id === id)
    if (routine === undefined) throw new Error('unknown routine')
    if (enabled && !routine.enabled) {
      if (this.#enabledCount() >= BOT_ROUTINE_MAX_ENABLED)
        throw new Error(`at most ${String(BOT_ROUTINE_MAX_ENABLED)} routines can be enabled`)
      routine.consecutiveFailures = 0
      routine.disabledReason = null
    }
    routine.enabled = enabled
    await this.#save()
    void this.#serial(() => this.#syncWatchers())
    return routine
  }

  async remove(id: string): Promise<boolean> {
    const remaining = this.#entries.filter((entry) => entry.id !== id)
    if (remaining.length === this.#entries.length) return false
    this.#entries = remaining
    await this.#save()
    void this.#serial(() => this.#syncWatchers())
    return true
  }

  start(): void {
    this.#timer ??= setInterval(() => void this.sweep(), SWEEP_INTERVAL_MS)
    this.#timer.unref?.()
    void this.#serial(() => this.#syncWatchers())
  }

  async close(): Promise<void> {
    if (this.#timer !== null) clearInterval(this.#timer)
    this.#timer = null
    await this.#serial(() => this.#syncWatchers())
  }

  /** Fires every due timed routine. Serialized, and never rejects. */
  sweep(): Promise<void> {
    return this.#serial(() => this.#sweep())
  }

  #serial(task: () => Promise<void>): Promise<void> {
    this.#sweeping = this.#sweeping.then(task).catch((error: unknown) => {
      log.warn('bot routine work failed', { error: String(error) })
    })
    return this.#sweeping
  }

  #enabledCount(): number {
    return this.#entries.filter((entry) => entry.enabled).length
  }

  async #sweep(): Promise<void> {
    const now = this.#now()
    let changed = false
    for (const routine of this.#entries) {
      const fired = await this.#check(routine, () => {
        if (routine.kind !== 'schedule' || routine.at > now) return false
        // Re-arm before dispatch: a crash mid-send must not send it twice, and
        // however long Ari was closed, only the next slot fires.
        routine.at = nextFireAt(routine.at, routine.everyMs, now)
        return true
      })
      changed = fired || changed
    }
    if (changed) await this.#save()
    await this.#syncWatchers()
  }

  async #fireCommit(id: string): Promise<void> {
    const routine = this.#entries.find((entry) => entry.id === id)
    if (routine === undefined || routine.kind !== 'commit') return
    if (await this.#check(routine, () => true)) await this.#save()
    await this.#syncWatchers()
  }

  /**
   * Counts the routine's last settled run, then fires it when `due` says so
   * and its previous run is no longer pending. True when its record may have changed.
   */
  async #check(routine: BotRoutine, due: () => boolean): Promise<boolean> {
    if (!routine.enabled) return false
    const bot = await this.#deps.bots.get(routine.botId)
    if (bot === null || bot.mainSessionId === undefined)
      return this.#disable(routine, 'The bot has no main session.')
    const model = await this.#deps.store.load(bot.mainSessionId)
    if (!model.session || model.session.archived === true)
      return this.#disable(routine, 'The bot session is missing or archived.')

    const counted = this.#recordOutcome(routine, model)
    if (!routine.enabled || !due()) return counted
    if (routineIsPending(model, routine.id)) {
      log.info('bot routine skipped: its previous run is still pending', {
        botId: routine.botId,
        routineId: routine.id,
      })
      return true
    }

    const outcome = await this.#deps.dispatch(
      {
        type: 'message.enqueue',
        sessionId: bot.mainSessionId,
        text: routineMessage(routine.prompt),
        attachments: [],
        hold: true,
        priority: 'routine',
      },
      { kind: 'routine', routineId: routine.id },
    )
    if (outcome.accepted) return true
    routine.consecutiveFailures += 1
    if (routine.consecutiveFailures >= BOT_ROUTINE_MAX_FAILURES)
      this.#disable(
        routine,
        `Disabled after ${String(BOT_ROUTINE_MAX_FAILURES)} consecutive failed runs (last: ${
          outcome.reason ?? 'refused'
        }).`,
      )
    return true
  }

  /** Runs one branch watcher per enabled commit routine while the schedule is started. */
  async #syncWatchers(): Promise<void> {
    const wanted = new Map(
      this.#timer === null
        ? []
        : this.#entries.flatMap((routine) =>
            routine.enabled && routine.kind === 'commit' ? [[routine.id, routine] as const] : [],
          ),
    )
    for (const [id, stop] of this.#watchers) {
      if (wanted.has(id)) continue
      this.#watchers.delete(id)
      clearTimeout(this.#debounces.get(id))
      this.#debounces.delete(id)
      await stop()
    }
    let changed = false
    for (const [id, routine] of wanted) {
      if (this.#watchers.has(id)) continue
      const stop = await this.#watch(routine)
      if (typeof stop === 'string') changed = this.#disable(routine, stop) || changed
      else this.#watchers.set(id, stop)
    }
    if (changed) await this.#save()
  }

  /** Starts the routine's branch watcher, or says why it cannot run. */
  async #watch(
    routine: Extract<BotRoutine, { kind: 'commit' }>,
  ): Promise<(() => Promise<void>) | string> {
    const bot = await this.#deps.bots.get(routine.botId)
    if (bot === null || bot.mainSessionId === undefined) return 'The bot has no main session.'
    const { session } = await this.#deps.store.load(bot.mainSessionId)
    const cwd = session ? await this.#deps.workspace(session) : null
    if (cwd === null) return 'The bot workspace is unavailable.'
    const watched = await watchBranchHead(cwd, routine.branch, () => {
      clearTimeout(this.#debounces.get(routine.id))
      this.#debounces.set(
        routine.id,
        setTimeout(() => {
          this.#debounces.delete(routine.id)
          void this.#serial(() => this.#fireCommit(routine.id))
        }, routine.debounceMs ?? BOT_ROUTINE_COMMIT_DEBOUNCE_MS),
      )
    })
    return watched.ok ? watched.value : `Cannot watch ${routine.branch}: ${watched.error.message}`
  }

  /** Counts a settled routine turn once, and resets the streak on a success. */
  #recordOutcome(
    routine: BotRoutine,
    model: Awaited<ReturnType<SessionStore['load']>>,
  ): boolean {
    const latest = latestRoutineTurnId(model, routine.id)
    if (latest === null || routine.lastOutcomeTurnId === latest) return false
    if (model.lastTurn?.turnId !== latest) return false
    routine.lastOutcomeTurnId = latest
    if (model.lastTurn.stopReason === 'error') {
      routine.consecutiveFailures += 1
      if (routine.consecutiveFailures >= BOT_ROUTINE_MAX_FAILURES)
        this.#disable(
          routine,
          `Disabled after ${String(BOT_ROUTINE_MAX_FAILURES)} consecutive failed runs.`,
        )
    } else {
      routine.consecutiveFailures = 0
    }
    return true
  }

  #disable(routine: BotRoutine, reason: string): boolean {
    if (!routine.enabled && routine.disabledReason === reason) return false
    routine.enabled = false
    routine.disabledReason = reason
    log.warn('bot routine disabled', { routineId: routine.id, reason })
    return true
  }
}
