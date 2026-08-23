import { z } from 'zod'
import {
  driverKindSchema,
  permissionModeSchema,
  sessionStatusSchema,
  timestampSchema,
} from './common'

export { sessionStatusSchema, type SessionStatus } from './common'

export const projectRefSchema = z.object({
  id: z.string(),
  name: z.string(),
  path: z.string(),
})
export type ProjectRef = z.infer<typeof projectRefSchema>

export const sessionSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  title: z.string(),
  driverKind: driverKindSchema,
  modelId: z.string().nullable(),
  permissionMode: permissionModeSchema,
  status: sessionStatusSchema,
  /**
   * Sidebar flags (M18.2). Optional on the wire for pre-M18.2 journals;
   * the projection normalizes both to concrete booleans (default false)
   * when folding `session.created`, so read models always carry them.
   */
  archived: z.boolean().optional(),
  pinned: z.boolean().optional(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
})
export type Session = z.infer<typeof sessionSchema>
