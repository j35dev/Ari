import { z } from 'zod'

/** A bot routine fires at most this often; anything shorter is a typo, not a plan. */
export const BOT_ROUTINE_MIN_EVERY_MS = 15 * 60_000

/** Enabled routines the whole team may hold. */
export const BOT_ROUTINE_MAX_ENABLED = 20

/** A routine that fails this many runs in a row is switched off. */
export const BOT_ROUTINE_MAX_FAILURES = 10

/** How long a commit routine waits after its branch moves, so a burst of commits fires once. */
export const BOT_ROUTINE_COMMIT_DEBOUNCE_MS = 5_000

const scheduleTrigger = {
  /** Routines saved before commit triggers have no kind and are schedules. */
  kind: z.literal('schedule').default('schedule'),
  /** Epoch ms of the next fire. */
  at: z.number().int(),
  everyMs: z.number().int().min(BOT_ROUTINE_MIN_EVERY_MS),
}

const commitTrigger = {
  kind: z.literal('commit'),
  /** Fires when this branch's ref in the bot's workspace repo moves to a new commit. */
  branch: z.string().trim().min(1),
  debounceMs: z.number().int().nonnegative().optional(),
}

const botRoutineFields = z.object({
  id: z.string().min(1),
  botId: z.string().min(1),
  prompt: z.string().min(1),
  enabled: z.boolean(),
  /** Failed runs since the last completed one. */
  consecutiveFailures: z.number().int().nonnegative(),
  /** The settled routine turn whose outcome was already counted. */
  lastOutcomeTurnId: z.string().nullable(),
  /** Why Ari switched it off; null for a routine the user paused. */
  disabledReason: z.string().nullable(),
})

/**
 * A Hive bot's prompt that fires on a timer or on a new commit to a branch. It
 * fires into the bot's main session and is skipped, never piled up, while the
 * same routine's previous fire is still working or still waiting for the
 * bot's turn.
 */
export const botRoutineSchema = z.union([
  botRoutineFields.extend(commitTrigger),
  botRoutineFields.extend(scheduleTrigger),
])
export type BotRoutine = z.infer<typeof botRoutineSchema>

const botRoutineAddFields = z.object({
  botId: z.string().min(1),
  prompt: z.string().trim().min(1).max(64_000),
})

export const botRoutineAddSchema = z.union([
  botRoutineAddFields.extend(commitTrigger),
  botRoutineAddFields.extend(scheduleTrigger),
])
export type BotRoutineAdd = z.infer<typeof botRoutineAddSchema>
