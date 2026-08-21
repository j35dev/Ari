import { z } from 'zod'
import { sessionStatusSchema, timestampSchema } from './common'

/**
 * Normalized stream events emitted by every provider adapter. Native CLI
 * output is mapped onto this union in `@ari/providers`; the engine and UI
 * never see provider-specific shapes.
 */
export const agentEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text-delta'), text: z.string() }),
  z.object({ type: z.literal('thinking-delta'), text: z.string() }),
  z.object({
    type: z.literal('tool-started'),
    callId: z.string(),
    name: z.string(),
    argsJson: z.string(),
  }),
  z.object({
    type: z.literal('tool-completed'),
    callId: z.string(),
    resultJson: z.string(),
    isError: z.boolean(),
  }),
  z.object({
    type: z.literal('approval-requested'),
    approvalId: z.string(),
    toolName: z.string(),
    summaryJson: z.string(),
  }),
  z.object({
    type: z.literal('input-requested'),
    inputId: z.string(),
    prompt: z.string(),
    choicesJson: z.string().nullable(),
  }),
  z.object({
    type: z.literal('usage'),
    inputTokens: z.number().nonnegative(),
    outputTokens: z.number().nonnegative(),
    costUsd: z.number().nullable(),
  }),
  z.object({ type: z.literal('status'), status: sessionStatusSchema }),
  z.object({ type: z.literal('error'), message: z.string(), rawJson: z.string().nullable() }),
  z.object({ type: z.literal('done') }),
])
export type AgentEvent = z.infer<typeof agentEventSchema>

/** A timestamped agent event as delivered over IPC. */
export const timedAgentEventSchema = z.object({
  at: timestampSchema,
  event: agentEventSchema,
})
export type TimedAgentEvent = z.infer<typeof timedAgentEventSchema>
