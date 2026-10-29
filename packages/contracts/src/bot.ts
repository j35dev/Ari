import { z } from 'zod'
import { driverKindSchema } from './common'

/** Colours a bot can wear; `palette` indexes them (slate, apricot, sage, lavender, sand, rose, coral, plum, sky, mint). */
export const BOT_CHARACTER_PALETTES = 10

/**
 * A bot's look: one soft shape in one colour. The face and its moods are drawn
 * by the shell. The shape list is append-only: removing or renaming a value
 * would fail to parse a saved bot.
 */
export const botCharacterSchema = z.object({
  shape: z.enum(['drop', 'cloud', 'pill', 'wisp', 'gumdrop', 'pebble']),
  palette: z
    .number()
    .int()
    .min(0)
    .max(BOT_CHARACTER_PALETTES - 1),
})
export type BotCharacter = z.infer<typeof botCharacterSchema>

/** An Ari Hive bot: a named persona bound to a driver and model. */
export const botSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  /** Fallback face where a character cannot be drawn, and for bots made before characters. */
  emoji: z.string().min(1),
  /** Absent on bots made before characters; the shell derives one from the bot id. */
  character: botCharacterSchema.optional(),
  /** The bot's role in a word or two, e.g. "Builder". */
  title: z.string().trim().max(40).optional(),
  /** One line in the bot's own voice, shown on its card. */
  tagline: z.string().trim().max(100).optional(),
  /** Markdown persona; stored in its own file under userData, never in the project. */
  personaMd: z.string(),
  driverKind: driverKindSchema,
  modelId: z.string().nullable(),
  projectId: z.string().min(1).optional(),
  /** Hidden from the Hive roster; the bot and its sessions are kept. */
  hidden: z.boolean().optional(),
  /** The session the Hive roster opens for this bot. */
  mainSessionId: z.string().min(1).optional(),
})
export type Bot = z.infer<typeof botSchema>

/** What `bots.create` takes: a new bot always gets a main session, so it needs a project. */
export const botCreateParamsSchema = botSchema
  .omit({ id: true, hidden: true, mainSessionId: true })
  .extend({ projectId: z.string().min(1) })
export type BotCreateParams = z.infer<typeof botCreateParamsSchema>

/** What `bots.update` may change. The driver, model and project stay as created. */
export const botUpdatePatchSchema = botSchema
  .pick({ name: true, emoji: true, character: true, title: true, tagline: true, personaMd: true })
  .partial()
export type BotUpdatePatch = z.infer<typeof botUpdatePatchSchema>
