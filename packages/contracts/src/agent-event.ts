import { z } from 'zod'
import { approvalOptionSchema, sessionStatusSchema, timestampSchema } from './common'

/**
 * Normalized stream events emitted by every provider adapter. Native CLI
 * output is mapped onto this union in `@ari/providers`; the engine and UI
 * never see provider-specific shapes.
 */
export const agentEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text-delta'), text: z.string() }),
  z.object({ type: z.literal('thinking-delta'), text: z.string() }),
  z.object({
    type: z.literal('image-output'),
    dataBase64: z.string().min(1),
    mimeType: z.string().regex(/^image\/[a-z0-9.+-]+$/),
    name: z.string().min(1),
  }),
  z.object({
    type: z.literal('image-output-path'),
    path: z.string().min(1),
    mimeType: z.string().regex(/^image\/[a-z0-9.+-]+$/),
    name: z.string().min(1),
  }),
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
    /**
     * The choices the provider offered, in its own order. A provider that
     * advertises only one flavor of each kind still lists them here, so every
     * approval is answered by naming an option rather than by a coarser
     * intent the adapter would have to guess at.
     */
    options: z.array(approvalOptionSchema).default([]),
  }),
  z.object({
    type: z.literal('input-requested'),
    inputId: z.string(),
    prompt: z.string(),
    choicesJson: z.string().nullable(),
  }),
  z.object({
    type: z.literal('session-ref'),
    /** Provider-native session/thread id to resume on later turns. */
    ref: z.string().min(1),
  }),
  z.object({
    type: z.literal('usage'),
    /** Every prompt token the model read, cache hits and cache writes included. */
    inputTokens: z.number().nonnegative(),
    outputTokens: z.number().nonnegative(),
    /** The share of `inputTokens` served from the provider's prompt cache. */
    cachedInputTokens: z.number().nonnegative().optional(),
    costUsd: z.number().nullable(),
  }),
  /**
   * How full the model's context window is after its latest call. A gauge,
   * not a delta: each reading replaces the one before it, where `usage` adds.
   */
  z.object({
    type: z.literal('context-usage'),
    usedTokens: z.number().nonnegative(),
    /** Window size when the provider reports it; null defers to the catalog. */
    windowTokens: z.number().positive().nullable(),
  }),
  z.object({ type: z.literal('status'), status: sessionStatusSchema }),
  /**
   * Something the user must know that did not fail the turn — a requested
   * model the harness does not offer, so the reply came from a different one.
   * Distinct from `error` on purpose: `error` settles the turn as failed, and
   * a turn that ran on the wrong model still ran.
   */
  z.object({ type: z.literal('notice'), message: z.string() }),
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
