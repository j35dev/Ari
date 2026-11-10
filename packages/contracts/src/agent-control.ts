import { z } from 'zod'
import { orchestrationParams } from './orchestration'
import { driverKindSchema, permissionModeSchema } from './common'
import { delegationRoleSchema, type DelegationRole } from './session'
import type { ProjectAgent, ResolvedProjectAgent } from './project'
import type { HelmProjectContext } from './helm'

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
   * Run Ari's own commands without a permission prompt each time. Installing
   * the Ari skill still asks because it writes the user's agent configuration.
   */
  autoApproveCli: z.boolean(),
  /** Soft cap on a whole delegation tree's cost; null leaves it off. */
  maxTreeCostUsd: z.number().positive().nullable(),
  /** Soft cap on a whole delegation tree's tokens; null leaves it off. */
  maxTreeTokens: z.number().int().positive().nullable(),
}

export const delegationSettingsSchema = z.object({
  enabled: delegationFields.enabled.default(true),
  maxConcurrentChildren: delegationFields.maxConcurrentChildren.default(4),
  maxChildrenPerSession: delegationFields.maxChildrenPerSession.default(8),
  maxDepth: delegationFields.maxDepth.default(1),
  defaultWorkspaceMode: delegationFields.defaultWorkspaceMode.default('isolated'),
  allowSharedWorkspace: delegationFields.allowSharedWorkspace.default(false),
  recursiveDelegation: delegationFields.recursiveDelegation.default(false),
  approvalMode: delegationFields.approvalMode.default('never'),
  autoDeliverResults: delegationFields.autoDeliverResults.default(true),
  cascadeStop: delegationFields.cascadeStop.default(true),
  autoApproveCli: delegationFields.autoApproveCli.default(true),
  maxTreeCostUsd: delegationFields.maxTreeCostUsd.default(null),
  maxTreeTokens: delegationFields.maxTreeTokens.default(null),
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
  /** A turn its lead started is waiting on a question the lead can answer. */
  | 'blocked_on_parent'
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
  /** The child's own spend; cost is null when its provider reported no price. */
  usage: { inputTokens: number; outputTokens: number; costUsd: number | null }
  workspaceKind: 'project' | 'managed-worktree'
  branch: string | null
}

/** A project as Aria sees it. */
export interface HelmProject extends HelmProjectContext {
  projectId: string
  name: string
  path: string
  available: boolean
  defaultAgent?: ProjectAgent | null
  agent?: ResolvedProjectAgent | null
  agentError?: string
}

export interface CreatedProject {
  projectId: string
  name: string
  path: string
  created: boolean
}

export const controlParams = {
  ...orchestrationParams,
  'runtime.info': z.object({}).strict(),
  'providers.list': z.object({}).strict(),
  /** Aria only: the projects it can start and steer work in. */
  'projects.list': z.object({}).strict(),
  /** Aria only: create a workspace or adopt a folder the user named. */
  'projects.create': z
    .object({
      name: z.string().trim().min(1).max(120),
      path: z.string().trim().min(1).max(4096).optional(),
      idempotencyKey: key,
    })
    .strict(),
  'projects.setDefault': z
    .object({
      projectId: target,
      driverKind: driverKindSchema,
      modelId: z.string().min(1),
      effort: z.string().min(1).nullish(),
      permissionMode: permissionModeSchema.optional(),
      idempotencyKey: key,
    })
    .strict(),
  'projects.ask': z
    .object({
      projectId: target,
      text,
      title: z.string().trim().min(1).max(120).optional(),
      driverKind: driverKindSchema.optional(),
      modelId: z.string().min(1).nullish(),
      effort: z.string().min(1).nullish(),
      permissionMode: permissionModeSchema.optional(),
      idempotencyKey: key,
    })
    .strict(),
  /** Aria only: change the most recently asked lead's agent, or delete its live project leads. */
  'projects.lead': z
    .object({
      projectId: target,
      driverKind: driverKindSchema.optional(),
      modelId: z.string().min(1).nullish(),
      effort: z.string().min(1).nullish(),
      reset: z.boolean().default(false),
      idempotencyKey: key,
    })
    .strict()
    .refine((p) =>
      p.reset
        ? p.driverKind === undefined && p.modelId === undefined && p.effort === undefined
        : p.driverKind !== undefined,
    )
    .refine((p) => p.reset || typeof p.modelId === 'string', {
      path: ['modelId'],
      message: 'Switching needs --model. Ask the user which model to use.',
    }),
  /** Aria only: sessions across every project, newest first. */
  'sessions.find': z
    .object({
      query: z.string().trim().max(200).optional(),
      projectId: target.optional(),
      /** `active` is working, queued or waiting on the user; `all` adds idle sessions. */
      scope: z.enum(['active', 'all']).default('all'),
      limit: z.number().int().min(1).max(100).default(20),
    })
    .strict(),
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
      /** Aria only: the project the new session works in. */
      projectId: target.optional(),
      role: delegationRoleSchema.optional(),
      /** Aria may use the project's saved agent; child sessions require an explicit provider. */
      driverKind: driverKindSchema.optional(),
      modelId: z.string().min(1).nullish(),
      effort: z.string().min(1).nullish(),
      permissionMode: permissionModeSchema.optional(),
      workspaceMode: z.enum(['isolated', 'shared']).optional(),
      baseSnapshotCommit: z
        .string()
        .regex(/^[a-f0-9]{40,64}$/)
        .optional(),
      prompt: text.optional(),
      idempotencyKey: key,
    })
    .strict(),
  'session.prompt': z
    .object({
      targetSessionId: target,
      text,
      effort: z.string().min(1).nullish(),
      idempotencyKey: key,
    })
    .strict(),
  /** Aria only: switch a top-level project session it launched. */
  'session.switch': z
    .object({
      targetSessionId: target,
      driverKind: driverKindSchema,
      modelId: z.string().min(1),
      effort: z.string().min(1).nullish(),
      idempotencyKey: key,
    })
    .strict(),
  'session.message': z.object({ targetSessionId: target, text, idempotencyKey: key }).strict(),
  'session.delivery': z.object({ targetSessionId: target, messageId: target }).strict(),
  'session.inbox': z.object({ includeConsumed: z.boolean().default(false) }).strict(),
  'session.ack': z
    .object({ messageIds: z.array(target).min(1).max(100), idempotencyKey: key })
    .strict(),
  /** A direct parent answers a provider question its child is blocked on. */
  'session.answer': z
    .object({
      targetSessionId: target,
      inputId: target,
      value: z.string().max(64_000),
      idempotencyKey: key,
    })
    .strict(),
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
