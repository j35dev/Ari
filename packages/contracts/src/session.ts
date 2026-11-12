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

/** What a parent delegated a child to do; shapes the child's brief, not its permissions. */
export const delegationRoleSchema = z.enum([
  'implementation',
  'research',
  'review',
  'design',
  'test',
  'general',
])
export type DelegationRole = z.infer<typeof delegationRoleSchema>

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
  /** Set on delegated children only; absent on journals written before roles. */
  role: delegationRoleSchema.nullish(),
  workspace: sessionWorkspaceSchema.nullish(),
  /** A lead coordinates children; it is guidance, not a permission change. */
  lead: z.literal(true).optional(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
})
export type Session = z.infer<typeof sessionSchema>

/** A native thread or journalled conversation binds an ordinary session to its provider. */
export function hasProviderContext(context: {
  hasMessages: boolean
  hasTurns: boolean
  providerSessionId: string | null
}): boolean {
  return context.hasMessages || context.hasTurns || context.providerSessionId !== null
}

export const sessionHierarchySummarySchema = sessionSchema
  .pick({
    parentSessionId: true,
    rootSessionId: true,
    createdBy: true,
    createdAt: true,
    permissionMode: true,
    effort: true,
    driverKind: true,
    modelId: true,
    status: true,
    role: true,
  })
  .partial()
  .extend({
    lead: z.boolean().optional(),
    workspaceKind: z.enum(['project', 'managed-worktree']).optional(),
    workspacePath: z.string().nullable().optional(),
    branch: z.string().nullable().optional(),
  })
export type SessionHierarchySummary = z.infer<typeof sessionHierarchySummarySchema>

/** Shared by local RPC summaries and complete remote session results. */
export const sessionSummarySchema = sessionHierarchySummarySchema.extend({
  createdBy: sessionCreatorSchema.nullish(),
  id: z.string(),
  projectId: z.string(),
  title: z.string(),
  updatedAt: z.number(),
  messageCount: z.number().int().nonnegative(),
  lastMessagePreview: z.string().nullable().optional(),
  archived: z.boolean().optional(),
  pinned: z.boolean().optional(),
})
export type SessionSummary = z.infer<typeof sessionSummarySchema>
