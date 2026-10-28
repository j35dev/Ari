import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  BOT_ROUTINE_MAX_ENABLED,
  BOT_ROUTINE_MAX_FAILURES,
  BOT_ROUTINE_MIN_EVERY_MS,
  botRoutineSchema,
  type BotRoutine,
  type BotRoutineAdd,
} from '@ari/contracts/routine'
import type { BotStore } from '@ari/engine/bots'
import {
  latestRoutineTurnId,
  nextFireAt,
  routineIsPending,
  routineMessage,
} from '@ari/engine/bot-routines'
import type { SessionStore } from '@ari/engine/session-store'
import type { Command } from '@ari/contracts/commands'
import type { MessageOrigin } from '@ari/contracts/message'
import { createLogger } from '@ari/shared/logger'

const log = createLogger('desktop:bot-routines')

const SWEEP_INTERVAL_MS = 20_000

/** A routine run always starts in the same place: its bot's main session. */
export interface BotRoutineDeps {
  /** JSON file the routines survive a restart in. */
  path: string
  bots: Pick<BotStore, 'get'>
  store: Pick<SessionStore, 'load'>
  dispatch(
    command: Command,
    origin?: MessageOrigin,
  ): Promise<{ accepted: boolean; reason?: string }>
  now?: () => number
}

/**
 * Per-bot timed prompts that feed the Hive bot's own session.
 *
 * A routine fires as a held, routine-priority message, so a person's turn and
 * a room turn always go first. A fire is skipped while the same routine still
 * has work pending, and missed windows are skipped rather than replayed in a
 * burst. Ten failed runs switch it off instead of retrying forever.
 */
export class BotRoutineSchedule {
  readonly #deps: BotRoutineDeps
  #entries: BotRoutine[] = []
  #timer: ReturnType<typeof setInterval> | null = null
  #sweeping: Promise<void> = Promise.resolve()

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
    return this.#entries.slice().sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))
  }

  async add(input: BotRoutineAdd): Promise<BotRoutine> {
    const prompt = input.prompt.trim()
    if (prompt.length === 0) throw new Error('routine prompt is empty')
    if (!Number.isFinite(input.at)) throw new Error('routine time is invalid')
    if (!Number.isInteger(input.everyMs) || input.everyMs < BOT_ROUTINE_MIN_EVERY_MS)
      throw new Error(
        `repeat interval must be at least ${String(BOT_ROUTINE_MIN_EVERY_MS / 60_000)} minutes`,
      )
    const bot = await this.#deps.bots.get(input.botId)
    if (bot === null) throw new Error('unknown bot')
    if (bot.mainSessionId === undefined) throw new Error('bot has no main session')
    const model = await this.#deps.store.load(bot.mainSessionId)
    if (!model.session) throw new Error('bot session is missing')
    if (this.#enabledCount() >= BOT_ROUTINE_MAX_ENABLED)
      throw new Error(`at most ${String(BOT_ROUTINE_MAX_ENABLED)} routines can be enabled`)

    const routine = botRoutineSchema.parse({
      id: `routine_${randomUUID()}`,
      botId: bot.id,
      prompt,
      at: input.at,
      everyMs: input.everyMs,
      enabled: true,
      consecutiveFailures: 0,
      lastOutcomeTurnId: null,
      disabledReason: null,
    })
    this.#entries = [...this.#entries, routine]
    await this.#save()
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
    return routine
  }

  async remove(id: string): Promise<boolean> {
    const remaining = this.#entries.filter((entry) => entry.id !== id)
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

  /** Fires every due routine. Serialized, and never rejects. */
  sweep(): Promise<void> {
    this.#sweeping = this.#sweeping
      .then(() => this.#sweep())
      .catch((error: unknown) => {
        log.warn('bot routine sweep failed', { error: String(error) })
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
      if (!routine.enabled) continue
      const bot = await this.#deps.bots.get(routine.botId)
      if (bot === null || bot.mainSessionId === undefined) {
        changed = this.#disable(routine, 'The bot has no main session.') || changed
        continue
      }
      const model = await this.#deps.store.load(bot.mainSessionId)
      if (!model.session || model.session.archived === true) {
        changed = this.#disable(routine, 'The bot session is missing or archived.') || changed
        continue
      }

      changed = this.#recordOutcome(routine, model) || changed
      if (!routine.enabled || routine.at > now) continue

      // Re-arm before dispatch: a crash mid-send must not send it twice, and
      // however long Ari was closed, only the next slot fires.
      routine.at = nextFireAt(routine.at, routine.everyMs, now)
      changed = true
      if (routineIsPending(model, routine.id)) {
        log.info('bot routine skipped: its previous run is still pending', {
          botId: routine.botId,
          routineId: routine.id,
        })
        continue
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
      if (outcome.accepted) continue
      routine.consecutiveFailures += 1
      if (routine.consecutiveFailures >= BOT_ROUTINE_MAX_FAILURES)
        this.#disable(
          routine,
          `Disabled after ${String(BOT_ROUTINE_MAX_FAILURES)} consecutive failed runs (last: ${
            outcome.reason ?? 'refused'
          }).`,
        )
    }
    if (changed) await this.#save()
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
