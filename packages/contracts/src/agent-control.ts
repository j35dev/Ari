import { z } from 'zod'
import { driverKindSchema, permissionModeSchema } from './common'
import { delegationRoleSchema, type DelegationRole } from './session'

export const AGENT_CONTROL_VERSION = 1
export const CONTROL_MAX_FRAME_BYTES = 1024 * 1024
const target = z.string().min(1).max(128)
const key = z.string().min(1).max(128)
const text = z.string().trim().min(1).max(64_000)
const timeout = z.number().int().min(1).max(3_600_000).default(60_000)

/** A running Ari process is woken at most this often; shorter repeats are a typo, not a plan. */
export const ROUTINE_MIN_EVERY_MS = 5 * 60_000

/** One scheduled prompt, as the control surface reports it. */
export interface ScheduledRoutine {
  id: string
  sessionId: string
  prompt: string
  /** Epoch ms of the next fire. */
  at: number
  /** Repeat interval, or null for a one-shot. */
  everyMs: number | null
}

const delegationFields = {
  enabled: z.boolean(),
  maxConcurrentChildren: z.number().int().min(1).max(32),
  maxChildrenPerSession: z.number().int().min(1).max(100),
  maxDepth: z.number().int().min(1).max(8),
  defaultWorkspaceMode: z.enum(['isolated', 'shared']),
  allowSharedWorkspace: z.boolean(),
  recursiveDelegation: z.boolean(),
  approvalMode: z.enum(['first-per-root', 'always', 'never']),
  /** Wake an idle parent with its children's results instead of leaving it to poll. */
  autoDeliverResults: z.boolean(),
  /** Stopping a session also stops the children it delegated to. */
  cascadeStop: z.boolean(),
  /**
   * Run Ari's own read-only and delegation commands without a permission
   * prompt each time. Integrating and destroying still ask.
   */
  autoApproveCli: z.boolean(),
}

export const delegationSettingsSchema = z.object({
  enabled: delegationFields.enabled.default(true),
  maxConcurrentChildren: delegationFields.maxConcurrentChildren.default(4),
  maxChildrenPerSession: delegationFields.maxChildrenPerSession.default(8),
  maxDepth: delegationFields.maxDepth.default(1),
  defaultWorkspaceMode: delegationFields.defaultWorkspaceMode.default('isolated'),
  allowSharedWorkspace: delegationFields.allowSharedWorkspace.default(false),
  recursiveDelegation: delegationFields.recursiveDelegation.default(false),
  approvalMode: delegationFields.approvalMode.default('first-per-root'),
  autoDeliverResults: delegationFields.autoDeliverResults.default(true),
  cascadeStop: delegationFields.cascadeStop.default(true),
  autoApproveCli: delegationFields.autoApproveCli.default(true),
})
export type DelegationSettings = z.infer<typeof delegationSettingsSchema>

/**
 * A change to some delegation settings. Built from the fields without their
 * defaults: `delegationSettingsSchema.partial()` still fills every absent key
 * in, so a patch that flipped one switch reset all the others.
 */
export const delegationSettingsPatchSchema = z.object(delegationFields).partial()

/** Where a delegated child stands, from its parent's point of view. */
export type ChildWorkState =
  | 'not_started'
  | 'queued'
  | 'working'
  | 'blocked_on_user'
  | 'waiting_for_children'
  | 'result_available'

/** One delegated child as `session status` and the transcript's task cards report it. */
export interface ChildTask {
  sessionId: string
  parentSessionId: string | null
  title: string
  role: DelegationRole | null
  driverKind: string
  modelId: string | null
  workState: ChildWorkState
  blockedOn: 'approval' | 'input' | null
  queuedMessages: number
  latestTurn: {
    turnId: string
    stopReason: 'completed' | 'interrupted' | 'error'
    settledAt: number
    errorMessage?: string | null
  } | null
  /** The child's final message, once it has one to read. */
  report: string | null
  reportTruncated: boolean
  /** Whether the parent has seen the latest outcome; null below direct children. */
  delivered: boolean | null
  workspaceKind: 'project' | 'managed-worktree'
  branch: string | null
}

export const controlParams = {
  'runtime.info': z.object({}).strict(),
  'providers.list': z.object({}).strict(),
  'session.get': z.object({ targetSessionId: target.default('self') }).strict(),
  'session.children': z
    .object({ targetSessionId: target.default('self'), recursive: z.boolean().default(false) })
    .strict(),
  'session.status': z
    .object({ targetSessionId: target.default('self'), recursive: z.boolean().default(false) })
    .strict(),
  'session.spawn': z
    .object({
      title: z.string().trim().min(1).max(120),
      role: delegationRoleSchema.optional(),
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
    .object({
      targetSessionIds: z.array(target).min(1).max(100),
      timeoutMs: timeout,
      /** `any` returns as soon as one target settles; the rest report `timeout`. */
      mode: z.enum(['all', 'any']).default('all'),
    })
    .strict(),
  'session.stop': z.object({ targetSessionId: target, idempotencyKey: key }).strict(),
  'session.destroy': z.object({ targetSessionId: target, idempotencyKey: key }).strict(),
  'session.diff': z.object({ targetSessionId: target, patch: z.boolean().default(false) }).strict(),
  'session.integrate': z
    .object({
      targetSessionId: target,
      snapshotCommit: z.string().regex(/^[a-f0-9]{40,64}$/),
      allowStale: z.boolean().default(false),
      idempotencyKey: key,
    })
    .strict(),
  'routine.add': z
    .object({
      targetSessionId: target.default('self'),
      prompt: text,
      at: z.number().int().min(0),
      everyMs: z.number().int().min(ROUTINE_MIN_EVERY_MS).nullish(),
      idempotencyKey: key,
    })
    .strict(),
  'routine.list': z
    .object({ targetSessionId: target.default('self'), recursive: z.boolean().default(false) })
    .strict(),
  'routine.remove': z.object({ routineId: target, idempotencyKey: key }).strict(),
  'memory.read': z.object({}).strict(),
  'memory.add': z.object({ text, idempotencyKey: key }).strict(),
  'memory.patch': z.object({ find: text, text, idempotencyKey: key }).strict(),
  'memory.remove': z.object({ find: text, idempotencyKey: key }).strict(),
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
