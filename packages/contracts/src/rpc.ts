import { z } from 'zod'
import { commandSchema } from './commands'
import { driverKindSchema, permissionModeSchema } from './common'
import type { Settings } from './settings'
import { settingsUpdateSchema } from './settings'

/**
 * The RPC surface between renderer and engine. Method names are an allowlist;
 * every payload is validated in the main process before a handler runs.
 */

export const sessionSummarySchema = z.object({
  id: z.string(),
  projectId: z.string(),
  title: z.string(),
  updatedAt: z.number(),
  /** Messages in the session; 0 marks a pristine, reusable session. */
  messageCount: z.number().int().nonnegative(),
  /** Sidebar flags; treat missing as false. The engine always reports them. */
  archived: z.boolean().optional(),
  pinned: z.boolean().optional(),
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

/** One per-session row of the `usage.summary` dashboard payload. */
export const usageRowSchema = z.object({
  sessionId: z.string(),
  title: z.string(),
  driverKind: z.string(),
  updatedAt: z.number(),
  inputTokens: z.number().nonnegative(),
  outputTokens: z.number().nonnegative(),
  /** Provider-reported cost sum; null while no event carried a price. */
  costUsd: z.number().nullable(),
})
export type UsageRow = z.infer<typeof usageRowSchema>

export const usageSummarySchema = z.object({
  /** Sessions with recorded tokens, newest first; empty until any usage lands. */
  rows: z.array(usageRowSchema),
  totals: usageRowSchema.pick({ inputTokens: true, outputTokens: true, costUsd: true }),
})
export type UsageSummary = z.infer<typeof usageSummarySchema>

/** Stream names the renderer may subscribe to. */
export const streamNames = ['session.events', 'terminal.data', 'providers.updates'] as const
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
 * Payload delivered on the providers.updates stream: fresh detection rounds
 * (with update availability) and catalog refresh notifications.
 */
export type ProvidersUpdateFrame =
  | { type: 'detections'; detections: RpcResults['providers.detect'] }
  | { type: 'catalog'; at: number }

/** One model entry in a driver's picker catalog. */
export const catalogModelSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  /** Short context-window hint rendered beside the label, e.g. `200k`. */
  contextHint: z.string().optional(),
})
export type CatalogModelInfo = z.infer<typeof catalogModelSchema>

/**
 * One path component of a hidden checkpoint ref (`refs/ari/<session>/<turn>`).
 * Mirrors the name rules enforced by @ari/engine/git.
 */
export const checkpointComponentSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)
  .refine((v) => !v.includes('..') && !v.endsWith('.lock'), {
    message: 'invalid checkpoint ref component',
  })

/** Hard ceiling for `search.content` results regardless of requested maxResults. */
export const SEARCH_CONTENT_MAX_RESULTS = 200

/** A single content-search hit: file path relative to the searched root. */
export const contentMatchSchema = z.object({
  path: z.string().min(1),
  line: z.number().int().min(1),
  text: z.string(),
})
export type ContentSearchMatch = z.infer<typeof contentMatchSchema>

/**
 * Outcome for the mutating git RPCs (`git.add` / `git.commit` / `git.push`):
 * failures come back as data instead of being thrown across IPC.
 */
export type GitActionResult = { ok: true } | { ok: false; error: string }

/** Invoke-method parameter schemas. The result side is typed via
 * {@link RpcResults}; zod validates results only at development boundaries.
 */
export const rpcParams = {
  ping: z.undefined(),
  'app.info': z.undefined(),
  'session.list': z.undefined(),
  'session.create': sessionCreateParamsSchema,
  'session.load': z.object({ sessionId: z.string().min(1) }),
  'session.destroy': z.object({ sessionId: z.string().min(1) }),
  'usage.summary': z.undefined(),
  'command.dispatch': z.object({ command: commandSchema }),
  'providers.detect': z.undefined(),
  'providers.models': z.undefined(),
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
  'files.index': z.object({ projectId: z.string().min(1) }),
  'search.content': z
    .object({
      /** Registered project id; resolved to its folder by the handler. */
      projectId: z.string().min(1).optional(),
      /** Explicit folder to search (jail boundary); used when projectId is absent. */
      path: z.string().min(1).optional(),
      query: z.string().min(1),
      maxResults: z.number().int().positive().max(SEARCH_CONTENT_MAX_RESULTS).optional(),
    })
    .refine((v) => v.projectId !== undefined || v.path !== undefined, {
      message: 'projectId or path is required',
    }),
  'endpoints.list': z.undefined(),
  'endpoints.upsert': z.object({
    id: z.string(),
    name: z.string().min(1),
    baseUrl: z.string().url(),
    flavor: z.enum(['openai-chat', 'anthropic-messages', 'ollama']),
    model: z.string().min(1),
    // Omitted on update = keep the stored key; null clears it.
    apiKey: z.string().nullable().optional(),
    headers: z.record(z.string(), z.string()).default({}),
  }),
  'endpoints.remove': z.object({ id: z.string().min(1) }),
  'endpoints.test': z.object({
    baseUrl: z.string().url(),
    flavor: z.enum(['openai-chat', 'anthropic-messages', 'ollama']),
    apiKey: z.string().nullable().default(null),
  }),
  'settings.get': z.undefined(),
  'settings.update': settingsUpdateSchema,
    'git.status': z.object({ path: z.string().min(1) }),
    'git.diffWorktree': z.object({ path: z.string().min(1) }),
    'git.turnDiff': z.object({
      path: z.string().min(1),
      sessionId: checkpointComponentSchema,
      turnId: checkpointComponentSchema,
    }),
    'git.add': z.object({
      path: z.string().min(1),
      /** Repo-relative pathspecs passed to `git add --`; `['.']` stages everything. */
      paths: z.array(z.string().min(1)).min(1),
    }),
    'git.commit': z.object({
      path: z.string().min(1),
      message: z.string().min(1),
    }),
    'git.push': z.object({
      path: z.string().min(1),
      /** Remote name; defaults to `origin` in the handler. */
      remote: z.string().min(1).optional(),
    }),
    'fs.list': z.object({ path: z.string().min(1) }),
    'fs.readTextFile': z.object({
      path: z.string().min(1),
      maxBytes: z.number().int().positive().optional(),
    }),
    'fs.writeTextFile': z.object({
      path: z.string().min(1),
      content: z.string(),
    }),
  'plan.get': z.object({ path: z.string().min(1) }),
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
  'app.info': {
    platform: string
    homeDir: string
    cwd: string
    version: string
  }
  'session.list': SessionSummary[]
  'session.create': { sessionId: string }
  'session.load': unknown
  'session.destroy': { destroyed: boolean }
  'usage.summary': UsageSummary
  'command.dispatch': { accepted: boolean }
  'providers.detect': {
    kind: string
    binaryPath: string | null
    version: string | null
    authStatus: string
    /** Newest version published upstream; null when unknown or not checkable. */
    latestVersion?: string | null
    /** True when latestVersion > version; null when either side is unknown. */
    updateAvailable?: boolean | null
  }[]
  /**
   * Merged model catalogs per driver kind, sourced live from the provider
   * (`source: 'live'`), a cached refresh (`'cache'`), the bundled snapshot
   * (`'snapshot'`), or static defaults (`'static'`).
   */
  'providers.models': { kind: string; source: 'live' | 'cache' | 'snapshot' | 'static'; models: CatalogModelInfo[] }[]
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
  'files.index': { paths: string[] }
  'search.content': ContentSearchMatch[]
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
  'endpoints.test': { ok: boolean; latencyMs: number; message: string }
  'settings.get': Settings
  'settings.update': Settings
    'git.status': {
      isRepo: boolean
      branch: string | null
      files: { path: string; staged: boolean; kind: string }[]
      error?: string
    }
    'git.diffWorktree': { diffText: string; error?: string }
    'git.turnDiff': { diffText: string | null; error?: string }
    'git.add': GitActionResult
    'git.commit': GitActionResult
    'git.push': GitActionResult
    'fs.list': { name: string; type: 'file' | 'dir'; size: number }[]
    'fs.readTextFile': { content: string; truncated: boolean }
    'fs.writeTextFile': { bytesWritten: number }
  /**
   * The session workspace's structured plan (`.ari-todo.json` written by
   * Ari Core's `todo_write`). `items: null` when no plan exists.
   */
  'plan.get': { items: { text: string; status: 'pending' | 'in_progress' | 'done' }[] | null; error?: string }
    'stream.subscribe': { subscribed: boolean }
  'stream.unsubscribe': { unsubscribed: boolean }
}

/** Payload shape for events delivered on a subscribed stream. */
export interface StreamFrame<P = unknown> {
  id: string
  name: StreamName
  payload: P
}
