import { z } from 'zod'

export const permissionModeSchema = z.enum(['ask', 'allow-edits', 'full'])
export type PermissionMode = z.infer<typeof permissionModeSchema>

export const driverKindSchema = z.enum([
  'claude',
  'codex',
  'opencode',
  'grok',
  'pi',
  'hermes',
  'ari-core',
])
export type DriverKind = z.infer<typeof driverKindSchema>

/** Epoch milliseconds, the one timestamp format used across all contracts. */
export const timestampSchema = z.number().int().nonnegative()

export const sessionStatusSchema = z.enum([
  'idle',
  'queued',
  'running',
  'waiting-approval',
  'waiting-input',
  'settled',
  'error',
])
export type SessionStatus = z.infer<typeof sessionStatusSchema>

/**
 * One choice an approval request offers. Several options may share a `kind` —
 * Codex advertises both a session-scoped and a prefix-scoped persistent grant
 * as `allow_always` — so the id, never the kind, identifies what the user
 * chose. `kind` is null for providers that advertise none.
 */
export const approvalOptionSchema = z.object({
  optionId: z.string().min(1),
  name: z.string().min(1),
  kind: z.string().min(1).nullable().default(null),
})
export type ApprovalOption = z.infer<typeof approvalOptionSchema>
