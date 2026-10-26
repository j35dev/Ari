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
})
export type Bot = z.infer<typeof botSchema>
