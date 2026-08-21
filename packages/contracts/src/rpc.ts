import { z } from 'zod'
import { commandSchema } from './commands'
import { driverKindSchema, permissionModeSchema } from './common'

/**
 * The RPC surface between renderer and engine. Method names are an allowlist;
 * every payload is validated in the main process before a handler runs.
 */

export const sessionSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  updatedAt: z.number(),
})
export type SessionSummary = z.infer<typeof sessionSummarySchema>

export const sessionCreateParamsSchema = z.object({
  projectId: z.string(),
  title: z.string(),
  driverKind: driverKindSchema,
  modelId: z.string().nullable(),
  permissionMode: permissionModeSchema,
})
export type SessionCreateParams = z.infer<typeof sessionCreateParamsSchema>

/** Stream names the renderer may subscribe to. */
export const streamNames = ['session.events'] as const
export type StreamName = (typeof streamNames)[number]

/**
 * Invoke-method parameter schemas. The result side is typed via
 * {@link RpcResults}; zod validates results only at development boundaries.
 */
export const rpcParams = {
  ping: z.undefined(),
  'session.list': z.undefined(),
  'session.create': sessionCreateParamsSchema,
  'session.load': z.object({ sessionId: z.string().min(1) }),
  'session.destroy': z.object({ sessionId: z.string().min(1) }),
  'command.dispatch': z.object({ command: commandSchema }),
  'stream.subscribe': z.object({
    id: z.string().min(1),
    name: z.enum(streamNames),
    params: z.record(z.string(), z.unknown()),
  }),
  'stream.unsubscribe': z.object({ id: z.string().min(1) }),
} satisfies Record<string, z.ZodType>

export type RpcMethod = keyof typeof rpcParams

export interface RpcResults {
  ping: { pong: boolean; at: number }
  'session.list': SessionSummary[]
  'session.create': { sessionId: string }
  'session.load': unknown
  'session.destroy': { destroyed: boolean }
  'command.dispatch': { accepted: boolean }
  'stream.subscribe': { subscribed: boolean }
  'stream.unsubscribe': { unsubscribed: boolean }
}

/** Payload shape for events delivered on a subscribed stream. */
export interface StreamFrame<P = unknown> {
  id: string
  name: StreamName
  payload: P
}
