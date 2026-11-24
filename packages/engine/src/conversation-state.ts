import { z } from 'zod'
import { sessionSchema } from '@ari/contracts/session'
import { messageSchema } from '@ari/contracts/message'
import { queuedMessageSchema } from '@ari/contracts/attachments'
import { approvalOptionSchema, sessionStatusSchema } from '@ari/contracts/common'
import { coordinationMessageSchema } from '@ari/contracts/coordination'
import {
  contextPackageSchema,
  operationReceiptSchema,
  orchestrationTaskRecordSchema,
} from '@ari/contracts/orchestration'
import {
  backgroundTaskKindSchema,
  backgroundTaskStatusSchema,
  subagentFields,
} from '@ari/contracts/background-task'
import { journalEventSchema } from '@ari/contracts/events'
import type { SessionReadModel } from './projection'

const time = z.number().finite()
const id = z.string()
const childEvent = journalEventSchema.refine((event) => event.type.startsWith('child.session.'))

/** Validate saved current state as strictly as the events it replaces on cold reads. */
export const conversationStateSchema = z.object({
  session: sessionSchema.nullable(),
  messages: z.array(messageSchema),
  streamingMessageId: id.nullable(),
  activeTurnId: id.nullable(),
  status: z.union([sessionStatusSchema, z.literal('unknown')]),
  pendingApprovals: z.array(
    z.object({
      approvalId: id,
      providerThreadId: id.optional(),
      providerTurnId: id.optional(),
      providerItemId: id.optional(),
      taskId: id.optional(),
      toolName: id,
      summaryJson: id,
      options: z.array(approvalOptionSchema),
    }),
  ),
  pendingInputs: z.array(z.object({ inputId: id, prompt: id, choicesJson: id.nullable() })),
  queuedMessages: z.array(queuedMessageSchema),
  // Legacy values are read for migration only. New turns never create Git snapshots.
  checkpoints: z.array(
    z.object({ turnId: id, gitRef: id, endRef: id.optional(), endError: id.optional() }),
  ),
  sessionBaselineRef: id.optional(),
  providerSessionId: id.nullable(),
  providerContextSeq: z.number().int().nonnegative().optional(),
  providerHandoffPending: z.boolean().optional(),
  usage: z.object({ inputTokens: time, outputTokens: time, costUsd: time.nullable() }),
  usageObserved: z.boolean().optional(),
  lastSeq: z.number().int().min(-1),
  lastObservedAt: time.optional(),
  lastTurn: z
    .object({
      turnId: id,
      stopReason: z.enum(['completed', 'interrupted', 'error']),
      settledAt: time,
      errorMessage: id.nullable().optional(),
    })
    .optional(),
  inbox: z.record(id, coordinationMessageSchema).optional(),
  orchestration: z
    .object({
      tasks: z.record(id, orchestrationTaskRecordSchema),
      contexts: z.record(id, contextPackageSchema),
      operations: z.record(id, operationReceiptSchema),
    })
    .optional(),
  childEvents: z.array(childEvent).optional(),
  childCompletions: z
    .record(
      id,
      z.object({
        turnId: id,
        acknowledged: z.boolean(),
        stopReason: z.enum(['completed', 'interrupted', 'error']).optional(),
        settledAt: time.optional(),
        earlyAck: id.optional(),
      }),
    )
    .optional(),
  backgroundTasks: z
    .array(
      z.object({
        id,
        kind: backgroundTaskKindSchema,
        label: id,
        status: backgroundTaskStatusSchema,
        detail: id.nullable(),
        startedAt: time,
        updatedAt: time,
        endedAt: time.nullable(),
        providerThreadId: id.optional(),
        providerTurnId: id.optional(),
        providerItemId: id.optional(),
        ...subagentFields,
      }),
    )
    .optional(),
})

export function parseConversationState(value: unknown): SessionReadModel {
  return conversationStateSchema.parse(value) as SessionReadModel
}
