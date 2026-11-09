import { coordinationMessageSchema } from './coordination'
import { z } from 'zod'
import {
  orchestrationTaskRecordSchema,
  contextPackageSchema,
  operationReceiptSchema,
} from './orchestration'
import {
  approvalOptionSchema,
  driverKindSchema,
  permissionModeSchema,
  sessionStatusSchema,
  timestampSchema,
} from './common'

const driverKindSchemaOptional = driverKindSchema.optional()
const permissionModeSchemaOptional = permissionModeSchema.optional()
import {
  messageSchema,
  messagePartSchema,
  messageOriginSchema,
  wakePrioritySchema,
} from './message'
import { attachmentRefSchema, MAX_ATTACHMENTS } from './attachments'
import { delegationRoleSchema, sessionSchema } from './session'
import { backgroundTaskKindSchema, backgroundTaskStatusSchema } from './background-task'

/**
 * Journal events. The engine appends these to per-session JSONL journals and
 * folds them into the read model; the UI observes only projected deltas.
 */
const eventBase = z.object({
  seq: z.number().int().nonnegative(),
  at: timestampSchema,
  sessionId: z.string(),
})

export const journalEventSchema = z.discriminatedUnion('type', [
  eventBase.extend({ type: z.literal('coordination.updated'), message: coordinationMessageSchema }),
  eventBase.extend({
    type: z.literal('orchestration.task.updated'),
    task: orchestrationTaskRecordSchema,
  }),
  eventBase.extend({
    type: z.literal('orchestration.context.created'),
    context: contextPackageSchema,
  }),
  eventBase.extend({
    type: z.literal('orchestration.operation.updated'),
    operation: operationReceiptSchema,
  }),
  eventBase.extend({
    type: z.literal('child.session.spawned'),
    childSessionId: z.string().min(1),
    title: z.string(),
    driverKind: driverKindSchema,
    modelId: z.string().nullable(),
    workspaceKind: z.enum(['managed-worktree', 'project']),
    branch: z.string().nullable(),
    role: delegationRoleSchema.optional(),
    idempotencyKey: z.string().min(1).max(128).optional(),
  }),
  eventBase.extend({
    type: z.literal('child.session.settled'),
    childSessionId: z.string().min(1),
    turnId: z.string().min(1),
    stopReason: z.enum(['completed', 'interrupted', 'error']),
  }),
  eventBase.extend({
    type: z.literal('child.session.integrated'),
    childSessionId: z.string().min(1),
    snapshotCommit: z.string().min(1),
    result: z.enum(['integrated', 'conflict', 'already_integrated']),
    conflictFiles: z.array(z.string()).optional(),
  }),
  eventBase.extend({
    type: z.literal('child.session.stopped'),
    childSessionId: z.string().min(1),
  }),
  eventBase.extend({
    type: z.literal('child.session.destroyed'),
    childSessionId: z.string().min(1),
  }),
  /**
   * The parent has seen a child turn's outcome, or never will: it read the
   * result itself (`wait`, `read`), Ari delivered it, or a stop discarded it.
   * May be journaled before the matching `child.session.settled`.
   */
  eventBase.extend({
    type: z.literal('child.session.acknowledged'),
    childSessionId: z.string().min(1),
    turnId: z.string().min(1),
    via: z.enum(['wait', 'read', 'delivered', 'disposed']),
  }),
  eventBase.extend({ type: z.literal('session.created'), session: sessionSchema }),
  eventBase.extend({
    type: z.literal('session.status.changed'),
    from: sessionStatusSchema,
    to: sessionStatusSchema,
    reason: z.string().nullable(),
  }),
  eventBase.extend({ type: z.literal('user.message.added'), message: messageSchema }),
  eventBase.extend({
    type: z.literal('assistant.parts.appended'),
    messageId: z.string(),
    parts: z.array(messagePartSchema),
  }),
  eventBase.extend({
    type: z.literal('turn.started'),
    turnId: z.string(),
  }),
  eventBase.extend({
    type: z.literal('turn.settled'),
    turnId: z.string(),
    stopReason: z.enum(['completed', 'interrupted', 'error']),
    errorMessage: z.string().nullable().default(null),
  }),
  eventBase.extend({
    type: z.literal('usage.recorded'),
    inputTokens: z.number().nonnegative(),
    outputTokens: z.number().nonnegative(),
    /** Absent on events journalled before cache traffic was counted. */
    cachedInputTokens: z.number().nonnegative().optional(),
    costUsd: z.number().nullable(),
  }),
  eventBase.extend({
    type: z.literal('context.recorded'),
    usedTokens: z.number().nonnegative(),
    windowTokens: z.number().positive().nullable(),
  }),
  eventBase.extend({
    type: z.literal('approval.requested'),
    providerThreadId: z.string().optional(),
    providerTurnId: z.string().optional(),
    providerItemId: z.string().optional(),
    approvalId: z.string(),
    toolName: z.string(),
    summaryJson: z.string(),
    /**
     * The choices the provider actually offered, in its own order. Empty for
     * events journalled before options were recorded.
     */
    options: z.array(approvalOptionSchema).default([]),
  }),
  eventBase.extend({
    type: z.literal('approval.responded'),
    approvalId: z.string(),
    /** The exact option the user chose. Absent on pre-option events. */
    optionId: z.string().min(1).optional(),
    /** Retained for events journalled before exact options were recorded. */
    decision: z.enum(['allow', 'deny', 'always-allow']).optional(),
  }),
  eventBase.extend({
    type: z.literal('input.requested'),
    inputId: z.string(),
    prompt: z.string(),
    choicesJson: z.string().nullable(),
  }),
  eventBase.extend({
    type: z.literal('input.responded'),
    inputId: z.string(),
    value: z.string(),
    /** Who answered; absent on human answers and pre-origin journals. */
    origin: messageOriginSchema.optional(),
  }),
  eventBase.extend({
    type: z.literal('checkpoint.captured'),
    turnId: z.string(),
    gitRef: z.string(),
    baselineRef: z.string().optional(),
  }),
  eventBase.extend({
    type: z.literal('checkpoint.completed'),
    turnId: z.string(),
    gitRef: z.string().nullable(),
    error: z.string().nullable(),
  }),
  eventBase.extend({
    type: z.literal('checkpoint.reverted'),
    turnId: z.string(),
    gitRef: z.string(),
  }),
  eventBase.extend({
    type: z.literal('checkpoint.pruned'),
    turnId: z.string(),
    gitRef: z.string(),
  }),
  eventBase.extend({
    type: z.literal('session.updated'),
    driverKind: driverKindSchemaOptional,
    modelId: z.string().nullable().optional(),
    permissionMode: permissionModeSchemaOptional,
    effort: z.string().min(1).nullable().optional(),
    title: z.string().min(1).optional(),
    archived: z.boolean().optional(),
    pinned: z.boolean().optional(),
  }),
  eventBase.extend({
    type: z.literal('session.provider.switched'),
    driverKind: driverKindSchema,
    modelId: z.string().nullable(),
    effort: z.string().min(1).nullable(),
    afterTurnId: z.string().nullable(),
    afterMessageId: z.string().nullable(),
  }),
  eventBase.extend({
    type: z.literal('session.provider.context.started'),
    contextSeq: z.number().int().nonnegative(),
  }),
  eventBase.extend({
    type: z.literal('session.ref.observed'),
    /** Provider-native session/thread id reported by the adapter. */
    ref: z.string().min(1),
    /** Switch generation of the turn that observed it; absent on older journals. */
    contextSeq: z.number().int().nonnegative().optional(),
  }),
  /**
   * A sub-agent or background shell of the agent's harness opened, changed or
   * ended. Journals written before these were tracked simply have none.
   */
  eventBase.extend({
    type: z.literal('background.task.updated'),
    providerThreadId: z.string().optional(),
    providerTurnId: z.string().optional(),
    providerItemId: z.string().optional(),
    taskId: z.string().min(1),
    kind: backgroundTaskKindSchema,
    label: z.string(),
    status: backgroundTaskStatusSchema,
    /** Absent keeps the task's last detail; null clears it. */
    detail: z.string().nullable().optional(),
  }),
  eventBase.extend({
    type: z.literal('message.enqueued'),
    origin: messageOriginSchema.optional(),
    text: z.string(),
    attachments: z.array(attachmentRefSchema).max(MAX_ATTACHMENTS).default([]),
    held: z.boolean().optional(),
    priority: wakePrioritySchema.optional(),
  }),
  eventBase.extend({
    type: z.literal('message.dequeued'),
    origin: messageOriginSchema.optional(),
    text: z.string(),
    attachments: z.array(attachmentRefSchema).max(MAX_ATTACHMENTS).default([]),
  }),
])
export type JournalEvent = z.infer<typeof journalEventSchema>
