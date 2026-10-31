import type { BotMemoryStore } from '@ari/engine/bot-memory'
import {
  MEMORY_CAPTURE_MIN_EVERY_MS,
  memoryCaptureDue,
  memoryCapturePrompt,
} from '@ari/engine/bot-memory-capture'
import type { SessionStore } from '@ari/engine/session-store'
import type { Command } from '@ari/contracts/commands'
import type { MessageOrigin } from '@ari/contracts/message'
import { createLogger } from '@ari/shared/logger'

const log = createLogger('desktop:bot-memory-capture')

/** A bot's session, the place a memory capture always happens. */
export interface BotMemoryCaptureDeps {
  store: Pick<SessionStore, 'load'>
  memory: Pick<BotMemoryStore, 'read'>
  dispatch(
    command: Command,
    origin?: MessageOrigin,
  ): Promise<{ accepted: boolean; reason?: string }>
  /** The opt-in `hive.selfMemory` setting, read live so toggles wait out nothing. */
  enabled: () => boolean
  now?: () => number
}

/**
 * After a settled turn in a bot's own session, fire one housekeeping prompt
 * that asks the bot to save durable facts with its memory tools — throttled,
 * opt-in via `hive.selfMemory`, and never while another turn runs. It reuses
 * the routine fire path: a held, routine-priority message, so nobody waits on
 * housekeeping.
 */
export class BotMemoryCapture {
  readonly #deps: BotMemoryCaptureDeps
  #lastCapturedAt = new Map<string, number>()
  #checking: Promise<void> = Promise.resolve()
  #unsubscribe: (() => void) | null = null

  constructor(deps: BotMemoryCaptureDeps) {
    this.#deps = deps
  }

  /** Listens for settled turns; idempotent, and `close` removes the listener. */
  start(store: Pick<SessionStore, 'subscribe'>): void {
    this.#unsubscribe ??= store.subscribe((event) => {
      if (event.type !== 'turn.settled' || !this.#deps.enabled()) return
      void this.consider(event.sessionId)
    })
  }

  close(): void {
    this.#unsubscribe?.()
    this.#unsubscribe = null
  }

  /** Serializes the check for one session; resolves when the check is done. */
  consider(sessionId: string): Promise<void> {
    this.#checking = this.#checking
      .then(() => this.#check(sessionId))
      .catch((error: unknown) => {
        log.warn('bot memory capture check failed', { sessionId, error: String(error) })
      })
    return this.#checking
  }

  async #check(sessionId: string): Promise<void> {
    if (!this.#deps.enabled()) return
    const model = await this.#deps.store.load(sessionId)
    const botId = model.session?.botId
    if (botId === undefined) return
    const now = this.#deps.now?.() ?? Date.now()
    if (
      !memoryCaptureDue(
        model,
        this.#lastCapturedAt.get(sessionId),
        now,
        MEMORY_CAPTURE_MIN_EVERY_MS,
      )
    )
      return
    const prompt = memoryCapturePrompt(await this.#deps.memory.read(botId))
    const outcome = await this.#deps.dispatch(
      {
        type: 'message.enqueue',
        sessionId,
        text: prompt,
        attachments: [],
        hold: true,
        priority: 'routine',
      },
      { kind: 'memory-capture' },
    )
    if (outcome.accepted) {
      this.#lastCapturedAt.set(sessionId, now)
      return
    }
    log.warn('bot memory capture refused', { sessionId, reason: outcome.reason })
  }
}
