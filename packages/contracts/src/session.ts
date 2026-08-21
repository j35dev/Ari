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
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
})
export type Session = z.infer<typeof sessionSchema>
