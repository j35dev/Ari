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
