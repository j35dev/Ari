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

export const sessionCreatorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('human') }),
  z.object({ kind: z.literal('session'), sessionId: z.string().min(1) }),
])

export const sessionWorkspaceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('project') }),
  z.object({
    kind: z.literal('managed-worktree'),
    path: z.string().min(1),
    branch: z.string().min(1),
    baseRef: z.string().min(1),
    baseCommit: z.string().regex(/^[a-f0-9]{40,64}$/),
  }),
])
export type SessionWorkspace = z.infer<typeof sessionWorkspaceSchema>

export const sessionSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  title: z.string(),
  driverKind: driverKindSchema,
  modelId: z.string().nullable(),
  permissionMode: permissionModeSchema,
  /**
   * Thought/reasoning level id from the harness (ACP thought_level / effort).
   * Absent on pre-M34 journals; null means "leave the agent's default".
   */
  effort: z.string().min(1).nullable().optional(),
  status: sessionStatusSchema,
  /**
   * Sidebar flags (M18.2). Optional on the wire for pre-M18.2 journals;
   * the projection normalizes both to concrete booleans (default false)
   * when folding `session.created`, so read models always carry them.
   */
  archived: z.boolean().optional(),
  pinned: z.boolean().optional(),
  parentSessionId: z.string().min(1).nullish(),
  rootSessionId: z.string().min(1).nullish(),
  createdBy: sessionCreatorSchema.nullish(),
  workspace: sessionWorkspaceSchema.nullish(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
})
export type Session = z.infer<typeof sessionSchema>

export const sessionHierarchySummarySchema = sessionSchema.pick({
  parentSessionId: true,
  rootSessionId: true,
  driverKind: true,
  modelId: true,
  status: true,
}).partial().extend({
  workspaceKind: z.enum(['project', 'managed-worktree']).optional(),
  branch: z.string().nullable().optional(),
})
export type SessionHierarchySummary = z.infer<typeof sessionHierarchySummarySchema>
