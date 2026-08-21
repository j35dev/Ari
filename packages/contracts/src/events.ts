import { z } from 'zod'
import { sessionStatusSchema, timestampSchema } from './common'
import { messageSchema, messagePartSchema } from './message'
import { sessionSchema } from './session'

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
  }),
  eventBase.extend({
    type: z.literal('approval.responded'),
    approvalId: z.string(),
    decision: z.enum(['allow', 'deny', 'always-allow']),
  }),
  eventBase.extend({
    type: z.literal('checkpoint.captured'),
    turnId: z.string(),
    gitRef: z.string(),
  }),
  eventBase.extend({
    type: z.literal('message.enqueued'),
    text: z.string().min(1),
  }),
  eventBase.extend({
    type: z.literal('message.dequeued'),
    text: z.string().min(1),
  }),
])
export type JournalEvent = z.infer<typeof journalEventSchema>
