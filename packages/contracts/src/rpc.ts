import { z } from 'zod'
import { commandSchema } from './commands'
import { driverKindSchema, permissionModeSchema } from './common'

/**
 * The RPC surface between renderer and engine. Method names are an allowlist;
 * every payload is validated in the main process before a handler runs.
 */

export const sessionSummarySchema = z.object({
  id: z.string(),
  projectId: z.string(),
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
export const streamNames = ['session.events', 'terminal.data'] as const
export type StreamName = (typeof streamNames)[number]

/** Payload delivered on the session.events stream. */
export interface SessionEventFrame {
  sessionId: string
  event: unknown
}

/** Payload delivered on the terminal.data stream. */
export interface TerminalDataFrame {
  id: string
  data: string
}

/**
 * Invoke-method parameter schemas. The result side is typed via
 * {@link RpcResults}; zod validates results only at development boundaries.
 */
export const rpcParams = {
  ping: z.undefined(),
  'session.list': z.undefined(),
  'session.create': sessionCreateParamsSchema,
  'session.load': z.object({ sessionId: z.string().min(1) }),
  'session.destroy': z.object({ sessionId: z.string().min(1) }),  'command.dispatch': z.object({ command: commandSchema }),
  'providers.detect': z.undefined(),
  'window.minimize': z.undefined(),
  'window.toggleMaximize': z.undefined(),
  'window.close': z.undefined(),
  'terminal.create': z.object({ id: z.string().min(1), cwd: z.string().min(1) }),
  'terminal.write': z.object({ id: z.string().min(1), data: z.string() }),
  'terminal.resize': z.object({
    id: z.string().min(1),
    cols: z.number().int().positive(),
    rows: z.number().int().positive(),
  }),
  'terminal.kill': z.object({ id: z.string().min(1) }),
  'project.list': z.undefined(),
  'project.add': z.object({ path: z.string().min(1), name: z.string().optional() }),
  'project.remove': z.object({ id: z.string().min(1) }),
  'endpoints.list': z.undefined(),
  'endpoints.upsert': z.object({
    id: z.string(),
    name: z.string().min(1),
    baseUrl: z.string().url(),
    flavor: z.enum(['openai-chat', 'anthropic-messages', 'ollama']),
    model: z.string().min(1),
    apiKey: z.string().nullable(),
    headers: z.record(z.string(), z.string()).default({}),
  }),
  'endpoints.remove': z.object({ id: z.string().min(1) }),
    'git.status': z.object({ path: z.string().min(1) }),
    'git.diffWorktree': z.object({ path: z.string().min(1) }),
    'fs.list': z.object({ path: z.string().min(1) }),
    'fs.readTextFile': z.object({
      path: z.string().min(1),
      maxBytes: z.number().int().positive().optional(),
    }),
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
  'providers.detect': { kind: string; binaryPath: string | null; version: string | null; authStatus: string }[]
  'window.minimize': { done: boolean }
  'window.toggleMaximize': { maximized: boolean }
  'window.close': { done: boolean }
  'terminal.create': { created: boolean }
  'terminal.write': { written: boolean }
  'terminal.resize': { resized: boolean }
  'terminal.kill': { killed: boolean }
  'project.list': { id: string; name: string; path: string; colorIndex: number; createdAt: number }[]
  'project.add': { id: string; name: string; path: string } | null
  'project.remove': { removed: boolean }
  'endpoints.list': {
    id: string
    name: string
    baseUrl: string
    flavor: string
    model: string
    apiKeyCipher: string | null
  }[]
  'endpoints.upsert': { id: string; name: string }
  'endpoints.remove': { removed: boolean }
    'git.status': {
      isRepo: boolean
      branch: string | null
      files: { path: string; staged: boolean; kind: string }[]
      error?: string
    }
    'git.diffWorktree': { diffText: string; error?: string }
    'fs.list': { name: string; type: 'file' | 'dir'; size: number }[]
    'fs.readTextFile': { content: string; truncated: boolean }
    'stream.subscribe': { subscribed: boolean }
  'stream.unsubscribe': { unsubscribed: boolean }
}

/** Payload shape for events delivered on a subscribed stream. */
export interface StreamFrame<P = unknown> {
  id: string
  name: StreamName
  payload: P
}
