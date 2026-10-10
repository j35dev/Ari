import { z } from 'zod'
import {
  approvalOptionSchema,
  driverKindSchema,
  permissionModeSchema,
  sessionStatusSchema,
  timestampSchema,
} from './common'

const driverKindSchemaOptional = driverKindSchema.optional()
const permissionModeSchemaOptional = permissionModeSchema.optional()
import { messageSchema, messagePartSchema, messageOriginSchema } from './message'
import { attachmentRefSchema, MAX_ATTACHMENTS } from './attachments'
import { delegationRoleSchema, sessionSchema } from './session'

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
    costUsd: z.number().nullable(),
  }),
  eventBase.extend({
    type: z.literal('approval.requested'),
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
  }),
  eventBase.extend({
    type: z.literal('checkpoint.captured'),
    turnId: z.string(),
    gitRef: z.string(),
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
    type: z.literal('session.ref.observed'),
    /** Provider-native session/thread id reported by the adapter. */
    ref: z.string().min(1),
  }),
  eventBase.extend({
    type: z.literal('message.enqueued'),
    origin: messageOriginSchema.optional(),
    text: z.string(),
    attachments: z.array(attachmentRefSchema).max(MAX_ATTACHMENTS).default([]),
  }),
  eventBase.extend({
    type: z.literal('message.dequeued'),
    origin: messageOriginSchema.optional(),
    text: z.string(),
    attachments: z.array(attachmentRefSchema).max(MAX_ATTACHMENTS).default([]),
  }),
])
export type JournalEvent = z.infer<typeof journalEventSchema>
