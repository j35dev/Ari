import { z } from 'zod'
import { driverKindSchema, permissionModeSchema } from './common'

export const AGENT_CONTROL_VERSION = 1
export const CONTROL_MAX_FRAME_BYTES = 1024 * 1024
const target = z.string().min(1).max(128)
const key = z.string().min(1).max(128)
const text = z.string().trim().min(1).max(64_000)
const timeout = z.number().int().min(1).max(3_600_000).default(60_000)

export const delegationSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  maxConcurrentChildren: z.number().int().min(1).max(32).default(4),
  maxChildrenPerSession: z.number().int().min(1).max(100).default(8),
  maxDepth: z.number().int().min(1).max(8).default(1),
  defaultWorkspaceMode: z.enum(['isolated', 'shared']).default('isolated'),
  allowSharedWorkspace: z.boolean().default(false),
  recursiveDelegation: z.boolean().default(false),
  approvalMode: z.enum(['first-per-root', 'always', 'never']).default('first-per-root'),
})
export type DelegationSettings = z.infer<typeof delegationSettingsSchema>

export const controlParams = {
  'runtime.info': z.object({}).strict(),
  'providers.list': z.object({}).strict(),
  'session.get': z.object({ targetSessionId: target.default('self') }).strict(),
  'session.children': z
    .object({ targetSessionId: target.default('self'), recursive: z.boolean().default(false) })
    .strict(),
  'session.spawn': z
    .object({
      title: z.string().trim().min(1).max(120),
      driverKind: driverKindSchema,
      modelId: z.string().min(1).nullish(),
      effort: z.string().min(1).nullish(),
      permissionMode: permissionModeSchema.optional(),
      workspaceMode: z.enum(['isolated', 'shared']).optional(),
      prompt: text.optional(),
      idempotencyKey: key,
    })
    .strict(),
  'session.prompt': z.object({ targetSessionId: target, text, idempotencyKey: key }).strict(),
  'session.message': z.object({ targetSessionId: target, text, idempotencyKey: key }).strict(),
  'session.read': z
    .object({
      targetSessionId: target,
      tailMessages: z.number().int().min(1).max(200).default(6),
      tailTurns: z.number().int().min(1).max(50).optional(),
      includeToolSummaries: z.boolean().default(false),
      maxChars: z.number().int().min(1).max(100_000).default(16_000),
    })
    .strict(),
  'session.wait': z
    .object({ targetSessionIds: z.array(target).min(1).max(100), timeoutMs: timeout })
    .strict(),
  'session.stop': z.object({ targetSessionId: target, idempotencyKey: key }).strict(),
  'session.diff': z.object({ targetSessionId: target, patch: z.boolean().default(false) }).strict(),
  'session.integrate': z
    .object({
      targetSessionId: target,
      snapshotCommit: z.string().regex(/^[a-f0-9]{40,64}$/),
      idempotencyKey: key,
    })
    .strict(),
} as const
export type ControlMethod = keyof typeof controlParams
export type ControlParams<M extends ControlMethod> = z.output<(typeof controlParams)[M]>

export const controlHelloSchema = z
  .object({
    type: z.literal('hello'),
    version: z.number().int(),
    token: z.string().min(1).max(256),
  })
  .strict()
export const controlRequestSchema = z
  .object({
    type: z.literal('request'),
    id: key,
    method: z.enum(Object.keys(controlParams) as [ControlMethod, ...ControlMethod[]]),
    params: z.unknown(),
  })
  .strict()
export interface ControlError {
  code: string
  message: string
  details?: unknown
}
export type ControlResult<T = unknown> =
  { ok: true; result: T } | { ok: false; error: ControlError }

/** Stable failures for control clients; transport never exposes arbitrary exception text. */
export class ControlFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message)
  }
}
