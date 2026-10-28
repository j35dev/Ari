import { z } from 'zod'

/** A bot routine fires at most this often; anything shorter is a typo, not a plan. */
export const BOT_ROUTINE_MIN_EVERY_MS = 15 * 60_000

/** Enabled routines the whole team may hold. */
export const BOT_ROUTINE_MAX_ENABLED = 20

/** A routine that fails this many runs in a row is switched off. */
export const BOT_ROUTINE_MAX_FAILURES = 10

/**
 * A Hive bot's repeating prompt. It fires into the bot's main session and is
 * skipped, never piled up, while the same routine's previous fire is still
 * working or still waiting for the bot's turn.
 */
export const botRoutineSchema = z.object({
  id: z.string().min(1),
  botId: z.string().min(1),
  prompt: z.string().min(1),
  /** Epoch ms of the next fire. */
  at: z.number().int(),
  everyMs: z.number().int().min(BOT_ROUTINE_MIN_EVERY_MS),
  enabled: z.boolean(),
  /** Failed runs since the last completed one. */
  consecutiveFailures: z.number().int().nonnegative(),
  /** The settled routine turn whose outcome was already counted. */
  lastOutcomeTurnId: z.string().nullable(),
  /** Why Ari switched it off; null for a routine the user paused. */
  disabledReason: z.string().nullable(),
})
export type BotRoutine = z.infer<typeof botRoutineSchema>

export const botRoutineAddSchema = z.object({
  botId: z.string().min(1),
  prompt: z.string().trim().min(1).max(64_000),
  /** Epoch ms of the first fire. */
  at: z.number().int(),
  everyMs: z.number().int().min(BOT_ROUTINE_MIN_EVERY_MS),
})
export type BotRoutineAdd = z.infer<typeof botRoutineAddSchema>
