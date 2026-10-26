import { z } from 'zod'
import { driverKindSchema } from './common'

/** An Ari Hive bot: a named persona bound to a driver and model. */
export const botSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  emoji: z.string().min(1),
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
