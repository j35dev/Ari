import { z } from 'zod'
import { driverKindSchema } from './common'

/** Character colour sets; `palette` indexes them. */
export const BOT_CHARACTER_PALETTES = 10

/**
 * A bot's drawn character, assembled from named parts. Each part list is
 * append-only: removing or renaming a value would fail to parse a saved bot.
 */
export const botCharacterSchema = z.object({
  body: z.enum(['round', 'square', 'tall', 'blob', 'bean']),
  eyes: z.enum(['dot', 'round', 'sleepy', 'visor', 'wide', 'spark']),
  mouth: z.enum(['smile', 'flat', 'grin', 'o', 'smirk']),
  top: z.enum(['none', 'antenna', 'tuft', 'horns', 'halo', 'cap', 'leaf']),
  accessory: z.enum(['none', 'glasses', 'headset', 'scarf', 'bowtie', 'monocle']),
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
