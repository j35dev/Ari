import { z } from 'zod'
import { approvalOptionSchema, driverKindSchema, permissionModeSchema } from './common'
import { delegationRoleSchema } from './session'
import type { ChildTask, ScheduledRoutine } from './agent-control'
import type { CoordinationMessage } from './coordination'
export type { ScheduledRoutine } from './agent-control'

const id = z.string().min(1).max(128)
const text = z.string().trim().min(1).max(64_000)
const oid = z.string().regex(/^[a-f0-9]{40,64}$/)
const path = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (p) => !/^(?:[a-z]:|[\\/])|(?:^|[\\/])\.\.(?:[\\/]|$)/i.test(p),
    'Use a workspace-relative path',
  )

export const taskAssignmentSchema = z
  .object({
    goal: text,
    role: delegationRoleSchema.default('general'),
    ownedPaths: z.array(path).max(100).default([]),
    acceptanceCriteria: z.array(text).max(50).default([]),
    dependsOn: z.array(id).max(100).default([]),
  })
  .strict()
export type TaskAssignment = z.infer<typeof taskAssignmentSchema>

export const orchestrationActivitySchema = z.object({
  phase: z.enum(['queued', 'starting', 'working', 'waiting', 'stopping', 'ended', 'unknown']),
  waitReason: z
    .enum([
      'dependencies',
      'capacity',
      'lead_decision',
      'human_decision',
      'children',
      'disconnected',
    ])
    .nullable(),
  decisionOwner: z.enum(['lead', 'human']).nullable(),
  terminalStatus: z.enum(['completed', 'failed', 'interrupted']).nullable(),
  detail: z.string().nullable(),
  observedAt: z.number().nullable(),
  freshness: z.enum(['live', 'journal', 'unavailable']),
})
export type OrchestrationActivity = z.infer<typeof orchestrationActivitySchema>

export const orchestrationCapabilitiesSchema = z.object({
  inspect: z.boolean(),
  message: z.boolean(),
  stop: z.boolean(),
  steer: z.boolean(),
  answer: z.boolean(),
  nativeFork: z.boolean(),
  respondAfterReconnect: z.boolean(),
  unavailableReason: z.string().nullable(),
})
export type OrchestrationCapabilities = z.infer<typeof orchestrationCapabilitiesSchema>
export const orchestrationRequestSchema = z.object({
  requestId: id,
  childSessionId: id,
  turnId: id.nullable(),
  title: z.string(),
  kind: z.enum(['approval', 'question']),
  owner: z.enum(['human', 'lead']),
  prompt: z.string(),
  toolName: z.string().nullable(),
  summaryJson: z.string().nullable(),
  choicesJson: z.string().nullable(),
  options: z.array(approvalOptionSchema),
  actionable: z.boolean(),
  unavailableReason: z.string().nullable(),
})
export type OrchestrationRequest = z.infer<typeof orchestrationRequestSchema>

export const resultCheckSchema = z.object({
  command: text,
  cwd: z.string(),
  exitCode: z.number().int().nullable(),
  snapshotCommit: oid.nullable(),
  detail: z.string().nullable(),
})
export const resultPackageSchema = z.object({
  resultId: id,
  taskId: id,
  attemptId: id,
  version: z.number().int().positive(),
  turnId: id.nullable(),
  createdAt: z.number(),
  summary: z.string(),
  files: z.array(z.string()),
  snapshotCommit: oid.nullable(),
  snapshotUnavailable: z.boolean().optional(),
  workerReportedChecks: z.array(resultCheckSchema),
  verifiedChecks: z.array(resultCheckSchema),
  unresolvedIssues: z.array(z.string()),
  nextAction: z.string().nullable(),
  terminalStatus: z.enum(['completed', 'failed', 'interrupted']),
  reviewState: z.enum(['available', 'reviewing', 'changes_requested', 'accepted', 'integrated']),
  reviewHistory: z.array(
    z.object({
      at: z.number(),
      state: z.enum(['available', 'reviewing', 'changes_requested', 'accepted', 'integrated']),
      feedback: z.string().nullable(),
    }),
  ),
})
export type ResultPackage = z.infer<typeof resultPackageSchema>

export const contextPackageSchema = z.object({
  contextId: id,
  sourceSessionId: id,
  createdAt: z.number(),
  purpose: z.enum(['assignment', 'fork', 'handoff']),
  items: z.array(
    z.object({
      kind: z.enum(['message', 'file', 'result']),
      sourceId: z.string(),
      content: z.string(),
      truncated: z.boolean(),
    }),
  ),
  maxChars: z.number().int().positive(),
  chars: z.number().int().nonnegative(),
})
export type ContextPackage = z.infer<typeof contextPackageSchema>
export const taskAttemptSchema = z.object({
  attemptId: id,
  sessionId: id.nullable(),
  createdAt: z.number(),
  contextId: id.nullable(),
  consumedContextAt: z.number().nullable(),
  submission: z.enum(['pending', 'submitted', 'uncertain', 'cancelled']),
  baselineTurnId: id.nullable(),
  prerequisites: z
    .array(
      z.object({
        taskId: id,
        attemptId: id,
        resultId: id,
        version: z.number().int().positive(),
        snapshotCommit: oid.nullable(),
      }),
    )
    .optional(),
})
export type TaskAttempt = z.infer<typeof taskAttemptSchema>
export const orchestrationTaskRecordSchema = z.object({
  taskId: id,
  title: z.string(),
  assignment: taskAssignmentSchema.nullable(),
  driverKind: driverKindSchema,
  modelId: z.string().nullable(),
  effort: z.string().nullable(),
  workspaceMode: z.enum(['isolated', 'shared']),
  permissionMode: permissionModeSchema.optional(),
  attempts: z.array(taskAttemptSchema),
  currentAttemptId: id,
  results: z.array(resultPackageSchema),
  currentResultId: id.nullable(),
  stopRequestedAt: z.number().nullable(),
  baseSnapshotCommit: oid.optional(),
})
export type OrchestrationTaskRecord = z.infer<typeof orchestrationTaskRecordSchema>
export const operationReceiptSchema = z.object({
  operationId: id,
  method: z.string(),
  fingerprint: z.string(),
  status: z.enum(['started', 'completed', 'uncertain']),
  startedAt: z.number(),
  completedAt: z.number().nullable(),
  result: z.unknown().optional(),
  detail: z.string().nullable(),
})
export type OperationReceipt = z.infer<typeof operationReceiptSchema>

export interface OrchestrationTask extends Omit<OrchestrationTaskRecord, 'assignment'> {
  native?: { taskId: string; sessionId: string; kind: 'subagent' | 'shell' }
  assignment: TaskAssignment | null
  child: ChildTask | null
  requests: OrchestrationRequest[]
  currentActivity: OrchestrationActivity
  capabilities: OrchestrationCapabilities
}
export interface OrchestrationView {
  sessionId: string
  revision: number
  observedAt: number
  tasks: OrchestrationTask[]
  budgets: {
    scope: 'tree'
    inputTokens: number | null
    outputTokens: number | null
    costUsd: number | null
    maxTokens: number | null
    maxCostUsd: number | null
  }
  operations: OperationReceipt[]
}

export interface OrchestrationInboxRow extends CoordinationMessage {
  senderTitle: string
  recipientTitle: string
  textTruncated: boolean
}

/** A coalesced invalidation for one session family, not a progress estimate. */
export interface OrchestrationChangedFrame {
  sessionId: string
  changedSessionIds: string[]
  at: number
}

export { presentChildTask } from './orchestration-presentation'
export type {
  WorkState as ChildTaskPresentationState,
  WorkPresentation as ChildTaskPresentation,
} from './orchestration-presentation'

const scope = { sessionId: id }
const mutation = { ...scope, idempotencyKey: id }
const launch = {
  ...mutation,
  title: z.string().trim().min(1).max(120),
  assignment: taskAssignmentSchema,
  driverKind: driverKindSchema,
  modelId: z.string().nullable().default(null),
  effort: z.string().nullable().default(null),
  permissionMode: permissionModeSchema.optional(),
  workspaceMode: z.enum(['isolated', 'shared']).default('isolated'),
  contextId: id.optional(),
}
export const orchestrationParams = {
  'orchestration.view': z.object(scope).strict(),
  'orchestration.inbox': z
    .object({
      ...scope,
      taskId: id.optional(),
      includeConsumed: z.boolean().default(false),
      limit: z.number().int().min(1).max(100).default(40),
    })
    .strict(),
  'orchestration.launch': z.object(launch).strict(),
  'orchestration.retry': z
    .object({
      ...mutation,
      taskId: id,
      feedback: text.optional(),
      contextId: id.optional(),
      newSession: z.boolean().default(false),
      driverKind: driverKindSchema.optional(),
      modelId: z.string().nullable().optional(),
    })
    .strict(),
  'orchestration.update': z
    .object({
      ...mutation,
      taskId: id,
      assignment: taskAssignmentSchema.optional(),
      title: z.string().min(1).max(120).optional(),
      redirect: text.optional(),
    })
    .strict(),
  'orchestration.review': z
    .object({
      ...mutation,
      taskId: id,
      resultId: id,
      state: z.enum(['reviewing', 'changes_requested', 'accepted']),
      feedback: text.optional(),
      snapshotCommit: oid.nullable(),
    })
    .strict(),
  'orchestration.result': z
    .object({
      ...mutation,
      taskId: id,
      attemptId: id,
      summary: text,
      files: z.array(path).max(100).default([]),
      workerReportedChecks: z.array(resultCheckSchema).max(50).default([]),
      unresolvedIssues: z.array(text).max(50).default([]),
      nextAction: text.optional(),
    })
    .strict(),
  'orchestration.context': z
    .object({
      ...mutation,
      messageIds: z.array(id).max(100).default([]),
      files: z.array(path).max(100).default([]),
      resultIds: z.array(id).max(100).default([]),
      maxChars: z.number().int().min(1).max(64_000).default(24_000),
      purpose: z.enum(['assignment', 'fork', 'handoff']).default('assignment'),
    })
    .strict(),
  'orchestration.context.get': z.object({ ...scope, contextId: id }).strict(),
  'orchestration.diff': z
    .object({ ...scope, taskId: id, resultId: id.optional(), patch: z.boolean().default(false) })
    .strict(),
  'orchestration.integrate': z
    .object({ ...mutation, taskId: id, resultId: id, snapshotCommit: oid })
    .strict(),
  'orchestration.verify': z
    .object({ ...mutation, taskId: id, resultId: id, snapshotCommit: oid })
    .strict(),
  'orchestration.answer': z
    .object({
      ...mutation,
      childSessionId: id,
      requestId: id,
      kind: z.enum(['approval', 'question']),
      // Empty input dismisses a question where the live adapter supports it.
      // Approval choices are still checked against exact offered IDs.
      value: z.string().max(64_000),
    })
    .strict(),
  'orchestration.stop': z
    .object({ ...mutation, taskId: id.optional(), tree: z.boolean().default(false) })
    .strict(),
  'orchestration.compare': z
    .object({
      ...launch,
      models: z
        .array(z.object({ driverKind: driverKindSchema, modelId: z.string().nullable() }))
        .min(2)
        .max(8),
    })
    .strict(),
  'orchestration.routine.list': z
    .object({ ...scope, recursive: z.boolean().default(false) })
    .strict(),
  'orchestration.routine.add': z
    .object({
      ...mutation,
      prompt: text,
      at: z.number().int().min(0),
      everyMs: z.number().int().min(300_000).nullish(),
    })
    .strict(),
  'orchestration.routine.remove': z.object({ ...mutation, routineId: id }).strict(),
} as const
export type OrchestrationMethod = keyof typeof orchestrationParams
export type OrchestrationParams<M extends OrchestrationMethod> = z.output<
  (typeof orchestrationParams)[M]
>
export interface OrchestrationDiff {
  sessionId: string
  baseCommit: string
  currentSnapshotCommit: string
  files: { path: string; status: string; additions: number; deletions: number; binary: boolean }[]
  totals: { files: number; additions: number; deletions: number }
  patch?: string
}
export interface OrchestrationResults {
  'orchestration.view': OrchestrationView
  'orchestration.inbox': { messages: OrchestrationInboxRow[]; total: number }
  'orchestration.launch': OrchestrationTaskRecord
  'orchestration.retry': OrchestrationTaskRecord
  'orchestration.update': OrchestrationTaskRecord
  'orchestration.review': ResultPackage
  'orchestration.result': ResultPackage
  'orchestration.context': ContextPackage
  'orchestration.context.get': ContextPackage
  'orchestration.diff': OrchestrationDiff
  'orchestration.integrate': {
    status: 'integrated' | 'conflict' | 'already_integrated'
    snapshotCommit?: string
    files?: string[]
  }
  'orchestration.verify': ResultPackage
  'orchestration.answer': { answered: boolean; requestId: string }
  'orchestration.stop': { requested: boolean; sessionIds: string[] }
  'orchestration.compare': OrchestrationTaskRecord[]
  'orchestration.routine.list': { routines: ScheduledRoutine[] }
  'orchestration.routine.add': ScheduledRoutine
  'orchestration.routine.remove': { removed: boolean }
}
