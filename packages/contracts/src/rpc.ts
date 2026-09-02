import { z } from 'zod'
import { commandSchema } from './commands'
import { driverKindSchema, permissionModeSchema } from './common'
import type { DriverKind } from './common'
import { endpointFlavorSchema, endpointModelSchema } from './endpoint'
import type { DiscoveredModel, EndpointModel } from './endpoint'
import type { Project } from './project'
import type { Settings } from './settings'
import { settingsUpdateSchema, themeIdSchema } from './settings'

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
  effort: z.string().min(1).nullable().optional(),
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
  /** Absent only on the `replayDone` sentinel frame. */
  event?: unknown
  /** True while this frame is part of the journal replay on (re)subscribe. */
  replay?: boolean
  /** Sentinel: the replay burst for this session is complete. */
  replayDone?: boolean
}

/** Payload delivered on the terminal.data stream. */
export interface TerminalDataFrame {
  id: string
  data: string
}

/**
 * Payload delivered on the providers.updates stream: fresh detection rounds
 * (with update availability), catalog refresh notifications, and one-shot
 * sign-in signals.
 */
export type ProvidersUpdateFrame =
  | { type: 'detections'; detections: RpcResults['providers.detect'] }
  | { type: 'catalog'; at: number }
  /** A provider refused a turn for want of a login; sign in to unblock it. */
  | { type: 'auth.required'; kind: DriverKind; label: string; logins: ProviderLoginMethod[] }
  /** Install/upgrade accepted; Settings and toasts can show a spinner immediately. */
  | { type: 'install.started'; kind: DriverKind; operation: 'install' | 'upgrade' }
  /** One line of live install/upgrade output. */
  | { type: 'install.progress'; kind: DriverKind; stream: 'stdout' | 'stderr'; text: string }
  /** Operation finished; `ok` reflects the post-run re-detect, not just exit code. */
  | {
      type: 'install.settled'
      kind: DriverKind
      operation: 'install' | 'upgrade'
      ok: boolean
      reason: string | null
      truncated: boolean
      /** First line of `--version` after the mandatory re-probe. */
      version?: string | null
    }

/**
 * One login a provider told Ari it can run. The command is the agent's own
 * CLI performing its own OAuth; Ari only spawns it in a terminal — it never
 * sees, stores, or forwards a credential.
 */
export const providerLoginMethodSchema = z.object({
  methodId: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  command: z.string().min(1),
  args: z.array(z.string()),
})
export type ProviderLoginMethod = z.infer<typeof providerLoginMethodSchema>
export const providerLoginMethodsSchema = z.array(providerLoginMethodSchema)

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

/**
 * Ceiling on a provider config payload. These are hand-written settings files —
 * the largest documented one is a few kilobytes — so a cap this generous still
 * refuses anything that is really a pasted transcript or a binary.
 */
export const PROVIDER_CONFIG_MAX_CHARS = 256 * 1024

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
  /** Sessions another agent already has on disk; `projectId` scopes to one registered project. */
  'sessions.importable': z.object({ projectId: z.string().min(1).optional() }),
  'sessions.import': z.object({
    candidateId: z.string().min(1),
    /** Defaults to the project whose folder matches the session's own cwd. */
    projectId: z.string().min(1).optional(),
  }),
  'usage.summary': z.undefined(),
  'usage.ccusage': z.object({ subcommand: z.enum(['daily', 'monthly', 'blocks']).optional() }),
  'command.dispatch': z.object({ command: commandSchema }),
  'providers.detect': z.undefined(),
  'providers.models': z.undefined(),
  'providers.plan': z.object({ kind: driverKindSchema }),
  'providers.install': z.object({
    kind: driverKindSchema,
    operation: z.enum(['install', 'upgrade']),
  }),
  'providers.cancelInstall': z.object({ kind: driverKindSchema }),
  'providers.authProbe': z.object({ kind: driverKindSchema }),
  'providers.login': z.object({ kind: driverKindSchema }),
  'providers.configFiles': z.object({ kind: driverKindSchema }),
  'providers.readConfig': z.object({ kind: driverKindSchema, fileId: z.string().min(1) }),
  'providers.writeConfig': z.object({
    kind: driverKindSchema,
    fileId: z.string().min(1),
    content: z.string().max(PROVIDER_CONFIG_MAX_CHARS),
  }),
  'window.minimize': z.undefined(),
  'window.toggleMaximize': z.undefined(),
  'window.close': z.undefined(),
  'theme.apply': z.object({ themeId: themeIdSchema }),
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
  'project.open': z.object({ path: z.string().min(1), name: z.string().optional() }),
  'project.close': z.object({ id: z.string().min(1) }),
  'project.remove': z.object({ id: z.string().min(1) }),
  'dialog.pickFolder': z.object({ defaultPath: z.string().min(1).optional() }),
  'shell.revealPath': z.object({ path: z.string().min(1) }),
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
    flavor: endpointFlavorSchema,
    model: z.string().min(1),
    /** Omitted = keep the stored list; provided = replace it wholesale. */
    models: z.array(endpointModelSchema).optional(),
    // Omitted on update = keep the stored key; null clears it.
    apiKey: z.string().nullable().optional(),
    headers: z.record(z.string(), z.string()).default({}),
  }),
  'endpoints.remove': z.object({ id: z.string().min(1) }),
  'endpoints.test': z.object({
    /** Saved endpoint whose stored key should be used when `apiKey` is null. */
    id: z.string().min(1).optional(),
    baseUrl: z.string().url(),
    flavor: endpointFlavorSchema,
    apiKey: z.string().nullable().default(null),
  }),
  /**
   * Queries an endpoint's own model listing. `id` names a saved endpoint, so
   * its stored key is reused; `persist` (default true) writes the merged list
   * back. The settings form probes with `persist: false` — it must not save an
   * endpoint the user has not submitted yet.
   */
  'endpoints.discoverModels': z.object({
    id: z.string().min(1).optional(),
    baseUrl: z.string().url(),
    flavor: endpointFlavorSchema,
    apiKey: z.string().nullable().default(null),
    persist: z.boolean().default(true),
  }),
  /** Replaces an endpoint's model list (manual adds and removals). */
  'endpoints.setModels': z.object({
    id: z.string().min(1),
    models: z.array(endpointModelSchema),
    /** Optional new default model; must exist in `models`. */
    defaultModel: z.string().min(1).optional(),
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
  'git.createPr': z.object({
    path: z.string().min(1),
    title: z.string().min(1).max(300),
    body: z.string().max(8000).optional(),
    base: z.string().min(1).max(200).optional(),
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
  'scripts.list': z.object({ path: z.string().min(1) }),
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
  /**
   * Sessions another agent has on disk and Ari could replay. `imported` is
   * derived from the Ari journals' own provider refs, so it cannot drift from
   * what actually exists.
   */
  'sessions.importable': {
    kind: 'pi'
    id: string
    candidateId: string
    cwd: string
    title: string
    startedAt: number
    updatedAt: number
    messageCount: number
    imported: boolean
  }[]
  /** Failure is data: no matching project and an already-imported session are both expected. */
  'sessions.import':
    | { ok: true; sessionId: string; title: string; messageCount: number }
    | { ok: false; error: string }
  'usage.summary': UsageSummary
  /**
   * Output of `npx ccusage` (the community Claude Code usage analyzer) run
   * out-of-process. `ok` false carries the failure reason; `output` holds the
   * tail-capped report text.
   */
  'usage.ccusage': { ok: boolean; output: string; error: string | null }
  'command.dispatch': { accepted: boolean }
  'providers.detect': {
    kind: string
    /** True when a binary was resolved on disk; independent of authStatus. */
    installed: boolean
    binaryPath: string | null
    version: string | null
    authStatus: string
    /** Why authStatus is 'unknown'; never carries credential values. */
    authReason?: string
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
  'providers.models': {
    kind: string
    source: 'live' | 'cache' | 'snapshot' | 'static'
    models: CatalogModelInfo[]
    /** Thought/reasoning levels the harness advertised; empty when it has none. */
    efforts: { id: string; label: string; description?: string; current?: boolean }[]
    /**
     * Permission modes the harness advertised over ACP, each mapped onto the
     * Ari mode it behaves like (codex `yolo` → `full`); empty when none were
     * discovered, in which case the picker falls back to Ari's own vocabulary.
     */
    modes: {
      id: string
      label: string
      description?: string
      ariMode: 'ask' | 'allow-edits' | 'full'
      current?: boolean
    }[]
  }[]
  /**
   * The literal argv Ari would run to install or upgrade a provider CLI, so
   * the confirm dialog can show the exact command before anything executes.
   * `null` when the kind has no known install channel.
   */
  'providers.plan': {
    manager: string
    installCommand: string[]
    upgradeCommand: string[]
    display: string
  } | null
  /** Accepted = the operation started; rejected when one is already running. */
  'providers.install': { started: boolean; reason?: string }
  'providers.cancelInstall': { cancelled: boolean }
  /**
   * Preflight: opens a throwaway ACP connection to answer whether the agent is
   * already signed in, reusing whatever harness exists before any login is
   * offered. `ready` means the existing harness already works; `auth-required`
   * carries the logins the agent advertises (empty when it offers none).
   */
  'providers.authProbe':
    | { status: 'ready'; label: string; version?: string | null }
    | { status: 'auth-required'; label: string; logins: ProviderLoginMethod[] }
    | { status: 'unknown'; reason: string }
  /**
   * The logins Ari can offer for a provider, resolved from the agent's own
   * `authMethods`. Returns the same exact command/args the terminal pane will
   * run, so a confirm dialog and the actual launch can never drift.
   */
  'providers.login': { label: string; logins: ProviderLoginMethod[] }
  /**
   * The agent's own configuration files Ari can show and edit — the vendor's
   * format, read and written verbatim. `null` dir means Ari has no confirmed
   * layout for that agent, which is different from having one that is empty.
   */
  'providers.configFiles': {
    dir: string | null
    files: {
      id: string
      label: string
      path: string
      format: 'json' | 'toml' | 'markdown'
      description: string
      exists: boolean
      /** UTF-8 byte size on disk; 0 when absent. */
      size: number
    }[]
  }
  'providers.readConfig': { content: string; exists: boolean; path: string; truncated: boolean }
  /** Failure comes back as data: an invalid path or unparseable JSON is expected. */
  'providers.writeConfig': { ok: true; bytesWritten: number } | { ok: false; error: string }
  'window.minimize': { done: boolean }
  'window.toggleMaximize': { maximized: boolean }
  'window.close': { done: boolean }
  /** Native chrome repainted for the given theme (overlay + OS scheme hint). */
  'theme.apply': { applied: boolean }
  'terminal.create': { created: boolean }
  'terminal.write': { written: boolean }
  'terminal.resize': { resized: boolean }
  'terminal.kill': { killed: boolean }
  'project.list': Project[]
  'project.add': Project
  'project.open': Project
  'project.close': Project | null
  'project.remove': { removed: boolean }
  /** Native folder picker; `path` is null when the user cancels (clean no-op). */
  'dialog.pickFolder': { path: string | null }
  'shell.revealPath': { revealed: boolean }
  'files.index': { paths: string[] }
  'search.content': ContentSearchMatch[]
  'endpoints.list': {
    id: string
    name: string
    baseUrl: string
    flavor: string
    /** Default model used when a session does not name one explicitly. */
    model: string
    /** Every model this endpoint serves; always contains `model`. */
    models: EndpointModel[]
    apiKeyCipher: string | null
  }[]
  'endpoints.upsert': { id: string; name: string }
  'endpoints.remove': { removed: boolean }
  'endpoints.test': { ok: boolean; latencyMs: number; message: string }
  /** `error` is null on success; `saved` is true when the list was persisted. */
  'endpoints.discoverModels': {
    models: DiscoveredModel[]
    error: string | null
    saved: boolean
  }
  'endpoints.setModels': { models: EndpointModel[]; defaultModel: string } | null
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
  /** `url` is null when gh succeeded without printing one; error explains failures. */
  'git.createPr': { ok: boolean; url: string | null; error?: string }
    'fs.list': { name: string; type: 'file' | 'dir'; size: number }[]
    'fs.readTextFile': { content: string; truncated: boolean }
    'fs.writeTextFile': { bytesWritten: number }
  /**
   * The session workspace's structured plan (`.ari-todo.json` written by
   * Ari Core's `todo_write`). `items: null` when no plan exists.
   */
  'plan.get': { items: { text: string; status: 'pending' | 'in_progress' | 'done' }[] | null; error?: string }
  /** npm-style scripts declared in the folder's package.json (M21.3). */
  'scripts.list': { scripts: { name: string; command: string }[]; error?: string }
    'stream.subscribe': { subscribed: boolean }
  'stream.unsubscribe': { unsubscribed: boolean }
}

/** Payload shape for events delivered on a subscribed stream. */
export interface StreamFrame<P = unknown> {
  id: string
  name: StreamName
  payload: P
}
