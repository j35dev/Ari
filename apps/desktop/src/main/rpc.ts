import { open, readFile, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, shell, type WebContents } from 'electron'
import type { IPty, IPtyForkOptions } from '@lydell/node-pty'
import type { JournalEvent } from '@ari/contracts/events'
import type { DriverKind } from '@ari/contracts/common'
import type { RpcResults, SessionEventFrame } from '@ari/contracts/rpc'
import type { ProvidersUpdateFrame } from '@ari/contracts/rpc'
import { createLogger } from '@ari/shared/logger'
import { Engine } from './engine'
import { commit as gitCommit, performGitAction, push as gitPush, stage as gitStage } from './git-actions'
import { writeTextFile } from './fs-write'
import { RunningTurnCounter } from './running-turns'
import { RpcRegistry } from './rpc-registry'
import { searchProjectContent } from './content-search'
import { queryTurnDiff } from './turn-diff'
import { listScripts } from './scripts-list'
import { createPullRequest } from './gh-pr'
import { getEndpointStore, getProjectStore, getSessionStore, getSettingsStore } from './store'
import { TerminalService, type PtyFactory, type PtyLike } from './terminal-service'
import { ensureProjectWatched, getIndexedFiles, stopWatchingProject } from './watcher-bridge'
import { applyThemeToWindow } from './window'
import { themeOf } from '@ari/ui/themes'
import { DriverRegistry } from '@ari/providers/registry'
import { ClaudeDriver } from '@ari/providers/claude'
import { CodexDriver } from '@ari/providers/codex'
import { OpencodeDriver } from '@ari/providers/opencode'
import { GrokDriver } from '@ari/providers/grok'
import { PiDriver } from '@ari/providers/pi'
import { HermesDriver } from '@ari/providers/hermes'
import { detectDriver } from '@ari/providers/detector'
import type { DetectEnvironment, Detection } from '@ari/providers/types'
import { resolveDetectionEnvironment } from '@ari/providers/shell-env'
import { CatalogService } from '@ari/providers/catalog-service'
import { catalogSource, modelsFor } from '@ari/providers/catalogs'
import { createUpdateChecker } from '@ari/providers/updates'
import { planFor } from '@ari/providers/package-manager'
import { runInstall, type InstallHandle } from '@ari/providers/install'
import { AcpDriver } from '@ari/providers/acp'
import { resolveAcpLaunch } from '@ari/providers/acp/launches'
import type { AcpLaunch } from '@ari/providers/acp/connection'
import type { Driver } from '@ari/providers/driver'
import { AriCoreDriver } from '@ari/ari-core/driver'

const log = createLogger('desktop:rpc')

/**
 * Kinds whose ACP server is probed for the agent's own model list. Native
 * ACP servers are cheap to ask; npx adapters would download packages in the
 * background, so they only run when explicitly requested.
 */
function acpProbeKinds(): DriverKind[] {
  if (process.env['ARI_ACP'] === '0') return []
  if (process.env['ARI_ACP_PROBE_ALL'] === '1') {
    return ['claude', 'codex', 'opencode', 'grok', 'pi', 'hermes']
  }
  return ['opencode', 'hermes']
}

/**
 * Opens a throwaway ACP session against the agent and reads its advertised
 * model list (session config options, category `model`) — models fetched
 * from the provider itself instead of a bundled list (M16).
 */
async function probeAcpModels(kind: DriverKind): Promise<RpcResults['providers.models'][number]['models'] | null> {
  const { detectDriver } = await import('@ari/providers/detector')
  const detection = await detectDriver(kind)
  if (!detection.binaryPath) return null
  const launch = resolveAcpLaunch(kind, { cliBinaryPath: detection.binaryPath })
  if (launch === null) return null
  const { AcpConnection } = await import('@ari/providers/acp/connection')
  const connection = await AcpConnection.connect({ launch, cwd: homedir(), initializeTimeoutMs: 20_000 })
  try {
    const created = await connection.newSession(homedir())
    const modelOption = (created.configOptions ?? []).find((o) => o.category === 'model' && o.type === 'select')
    const models = (modelOption?.options ?? [])
      .filter((v) => typeof v.value === 'string' && v.value.length > 0)
      .map((v) => ({
        id: v.value as string,
        label: typeof v.name === 'string' && v.name.length > 0 ? v.name : (v.value as string),
      }))
    return models
  } finally {
    connection.kill()
  }
}

/**
 * Every CLI kind probed by `providers.detect`, regardless of hydration state,
 * so the providers grid is complete even while drivers are still registering.
 */
const ALL_CLI_KINDS: DriverKind[] = ['claude', 'codex', 'opencode', 'grok', 'pi', 'hermes']

/** Short cache so mount-time detect calls from several views share one probe round. */
let detectionCache: { at: number; value: Promise<RpcResults['providers.detect']> } | null = null
const DETECTION_CACHE_TTL_MS = 30_000

/** Enriched detections (update info) cached for an hour; refreshed in background. */
let updateCache: { at: number; value: RpcResults['providers.detect'] } | null = null
const UPDATE_CACHE_TTL_MS = 60 * 60 * 1000

/** One in-flight install/upgrade per driver kind; the UI gates on this. */
const installsInFlight = new Map<DriverKind, InstallHandle>()

const updateChecker = createUpdateChecker()

function probeAllDetections(): Promise<RpcResults['providers.detect']> {
  if (detectionCache === null || Date.now() - detectionCache.at > DETECTION_CACHE_TTL_MS) {
    // GUI-launched processes inherit a minimal PATH; the enriched env layers
    // in login-shell + version-manager dirs so terminal-installed CLIs resolve.
    detectionCache = {
      at: Date.now(),
      value: resolveDetectionEnvironment().then((env: DetectEnvironment) =>
        Promise.all(
          [...ALL_CLI_KINDS, 'ari-core' as DriverKind].map(async (kind) => {
            try {
              return await detectDriver(kind, env)
            } catch (error) {
              log.error('detection crashed', { kind, error: String(error) })
              return {
                kind,
                installed: false,
                binaryPath: null,
                version: null,
                authStatus: 'unknown',
                authReason: 'Detection failed - see logs.',
              } satisfies Detection
            }
          }),
        ),
      ),
    }
  }
  // Serve the fast offline round immediately; enrich with update info once
  // the registry answers and publish the fresh set to stream subscribers.
  void detectionCache.value
    .then(async (detections) => {
      if (updateCache !== null && Date.now() - updateCache.at < UPDATE_CACHE_TTL_MS) {
        return updateCache.value
      }
      const enriched = await updateChecker.enrich(detections as Detection[])
      updateCache = { at: Date.now(), value: enriched }
      rpcRegistryRef?.publish('providers.updates', {
        type: 'detections',
        detections: enriched,
      } satisfies ProvidersUpdateFrame)
      return enriched
    })
    .catch((error: unknown) => log.debug('update enrichment failed', { error: String(error) }))
  return detectionCache.value
}

/**
 * Module-level hook so the detection round can publish stream frames without
 * threading the registry through every helper; set during registerRpc.
 */
let rpcRegistryRef: RpcRegistry | null = null

/**
 * Registers each installed CLI driver as its detection resolves, preferring
 * the ACP transport (M16) with the legacy one-shot CLI driver as automatic
 * fallback inside {@link AcpDriver}. Detection is concurrent and runs in the
 * background — the RPC surface is fully usable the instant this runs.
 */
function hydrateDrivers(registry: DriverRegistry): void {
  const candidates: {
    kind: 'claude' | 'codex' | 'opencode' | 'grok' | 'pi' | 'hermes'
    make: (bin: string) => Driver
  }[] = [
    { kind: 'claude', make: (bin) => new ClaudeDriver(bin) },
    { kind: 'codex', make: (bin) => new CodexDriver(bin) },
    { kind: 'opencode', make: (bin) => new OpencodeDriver(bin) },
    { kind: 'grok', make: (bin) => new GrokDriver(bin) },
    { kind: 'pi', make: (bin) => new PiDriver(bin) },
    { kind: 'hermes', make: (bin) => new HermesDriver(bin) },
  ]
  void resolveDetectionEnvironment()
    .then((env) =>
      Promise.all(
        candidates.map(async (candidate) => {
          try {
            const detection = await detectDriver(candidate.kind, env)
            if (!detection.binaryPath) return
            const launch: AcpLaunch | null = resolveAcpLaunch(candidate.kind, {
              cliBinaryPath: detection.binaryPath,
            })
            registry.register(
              new AcpDriver(candidate.kind, launch, candidate.make(detection.binaryPath)),
            )
            log.info('driver registered', {
              kind: candidate.kind,
              version: detection.version,
              transport: launch === null ? 'cli' : 'acp+fallback',
            })
          } catch (error) {
            log.error('driver detection failed', { kind: candidate.kind, error: String(error) })
          }
        }),
      ),
    )
}

/**
 * Wires the engine + RPC registry to Electron IPC synchronously: every handler
 * exists before the first renderer invoke can land; payloads are validated in
 * the registry; stream frames are delivered over a single dedicated channel
 * with per-subscription ids.
 */
export const STREAM_CHANNEL = 'ari:stream'

/** Structural type for the lazily-loaded pty module (@lydell/node-pty). */
type NodePtyModule = {
  spawn(file: string, args: string[], options: IPtyForkOptions): IPty
}

export interface EngineHandle {
  engine: Engine
  registry: DriverRegistry
}

export interface RegisterRpcOptions {
  /** Notified whenever the live mid-turn count changes (tray status). */
  onRunningCount?: (runningCount: number) => void
}

/** Hard ceiling for `fs.readTextFile` regardless of the requested maxBytes. */
const FS_READ_MAX_BYTES = 512 * 1024

/** Bytes sniffed for NUL to decide a payload is binary. */
const FS_BINARY_SNIFF_BYTES = 2048

/**
 * Cached loader for node-pty. The module is ABI-coupled to Electron and can
 * genuinely fail to load (missing prebuilds); the failure is captured once and
 * surfaced as a descriptive terminal error instead of hanging forever.
 */
let ptyModule: NodePtyModule | null = null
let ptyLoadPromise: Promise<NodePtyModule | null> | null = null
function loadPtyModule(): Promise<NodePtyModule | null> {
  ptyLoadPromise ??= import('@lydell/node-pty').then(
    (m) => m,
    (error: unknown) => {
      log.error('node-pty failed to load', { error: String(error) })
      return null
    },
  )
  return ptyLoadPromise
}
void loadPtyModule().then((m) => {
  ptyModule = m
})

export function registerRpc(contents: WebContents, options: RegisterRpcOptions = {}): EngineHandle {
  const rpcRegistry = new RpcRegistry({
    send: (frame) => {
      if (!contents.isDestroyed()) contents.send(STREAM_CHANNEL, frame)
    },
  })
  rpcRegistryRef = rpcRegistry

  // The registry exists immediately with Ari Core attached; CLI drivers are
  // added as background detection completes. Nothing waits on that to answer.
  const driverRegistry = new DriverRegistry()
  driverRegistry.register(new AriCoreDriver(getEndpointStore()))
  hydrateDrivers(driverRegistry)

  // Model catalogs: bundled snapshot serves the first paint; a background
  // models.dev refresh plus live ACP probes (agents advertising their own
  // model lists) upgrade the pickers without any restart.
  const catalogService = new CatalogService({
    cachePath: join(app.getPath('userData'), 'model-catalog.json'),
    probeModels: (kind) => probeAcpModels(kind),
    probeKinds: acpProbeKinds(),
  })
  catalogService.start()

  // The running-turn counter feeds the tray from the same event flow the
  // renderer subscribes to; no extra engine coupling.
  const runningTurns = new RunningTurnCounter()
  const engine = new Engine({
    store: getSessionStore(),
    registry: driverRegistry,
    publish: (sessionId: string, event: JournalEvent) => {
      const payload: SessionEventFrame = { sessionId, event }
      rpcRegistry.publish('session.events', payload)
      if (options.onRunningCount && runningTurns.push(event)) {
        options.onRunningCount(runningTurns.count)
      }
    },
    // Workspace resolution lives here so the engine never guesses: ad-hoc
    // sessions run against the home directory; project sessions resolve the
    // registered folder path by id.
    resolveWorkspace: async (projectId) => {
      if (projectId === 'adhoc') return homedir()
      await getProjectStore().load()
      return getProjectStore().get(projectId)?.path ?? null
    },
  })

  const ptyFactory: PtyFactory = (file, args, options) => {
    if (!ptyModule) throw new Error('terminal backend still loading')
    const raw = ptyModule.spawn(file, args, {
      name: options.name,
      cwd: options.cwd,
      env: options.env,
    })
    // Bridge node-pty's event properties onto the service's callback style.
    const dataListeners: ((data: string) => void)[] = []
    const exitListeners: ((code: number) => void)[] = []
    raw.onData((data) => dataListeners.forEach((l) => l(data)))
    raw.onExit((_e) => exitListeners.forEach((l) => l(0)))
    const pty: PtyLike = {
      pid: raw.pid,
      write: (data) => raw.write(data),
      resize: (cols, rows) => raw.resize(cols, rows),
      kill: () => raw.kill(),
      onData: (cb) => dataListeners.push(cb),
      onExit: (cb) => exitListeners.push(() => cb(0)),
    }
    return pty
  }
  const terminals = new TerminalService(
    {
      onData: (id, data) => rpcRegistry.publish('terminal.data', { id, data }),
      onExit: () => undefined,
    },
    ptyFactory,
  )

  const r = rpcRegistry
  r.register('ping', () => ({ pong: true, at: Date.now() }))

  r.register('app.info', () => ({
    platform: process.platform,
    homeDir: homedir(),
    cwd: process.cwd(),
    version: app.getVersion(),
  }))

  // Settings are the single writer's file; load once at boot so window
  // bounds and renderer reads share the same in-memory state.
  void getSettingsStore().load()

  r.register('settings.get', async () => {
    const store = getSettingsStore()
    await store.load()
    return store.current
  })

  r.register('settings.update', async (params) => getSettingsStore().update(params))

  r.register('session.list', async () => getSessionStore().listSessions())

  r.register('session.create', async (params) => {
    const store = getSessionStore()
    const sessionId = `sess_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
    await store.append(sessionId, {
      type: 'session.created',
      session: {
        id: sessionId,
        projectId: params.projectId,
        title: params.title,
        driverKind: params.driverKind,
        modelId: params.modelId,
        permissionMode: params.permissionMode,
        status: 'idle',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    })
    return { sessionId }
  })

  r.register('session.load', async (params) => {
    const model = await getSessionStore().load(params.sessionId)
    return model.session ? model : null
  })

  r.register('session.destroy', async (params) => {
    await getSessionStore().destroy(params.sessionId)
    return { destroyed: true }
  })

  // Usage dashboard feed: per-session rows + totals from the sidecar indexes.
  r.register('usage.summary', async () => getSessionStore().usageSummary())

  // Full ccusage report (the community Claude Code analyzer) run out-of-process.
  // argv only; npx resolves/downloads the package so nothing is preinstalled.
  // Cached: npx cold-starts take tens of seconds and usage data is minutes-stale
  // by nature, so repeated page visits reuse the last report.
  let ccusageCache: { at: number; result: RpcResults['usage.ccusage'] } | null = null
  const CCUSAGE_CACHE_TTL_MS = 10 * 60 * 1000
  r.register('usage.ccusage', (params) => {
    const sub = params.subcommand ?? 'daily'
    if (sub === 'daily' && ccusageCache !== null && Date.now() - ccusageCache.at < CCUSAGE_CACHE_TTL_MS) {
      return Promise.resolve(ccusageCache.result)
    }
    return new Promise<RpcResults['usage.ccusage']>((resolvePromise) => {
      const chunks: string[] = []
      let failure: string | null = null
      const handle = runInstall(
        ['npx', '-y', 'ccusage@latest', sub, '--json'],
        (event) => {
          if (event.type === 'progress') chunks.push(event.line.text)
          if (event.type === 'failed') failure = event.reason
        },
        { timeoutMs: 90_000, outputTailBytes: 64 * 1024 },
      )
      void handle.done.then(() => {
        const result: RpcResults['usage.ccusage'] = { ok: failure === null, output: chunks.join('\n'), error: failure }
        if (sub === 'daily' && result.ok) ccusageCache = { at: Date.now(), result }
        resolvePromise(result)
      })
    })
  })

  r.register('command.dispatch', async (params) => engine.dispatch(params.command))

  r.register('providers.detect', () => probeAllDetections())

  r.register('providers.plan', async (params) => {
    const detections = await probeAllDetections()
    const binaryPath = detections.find((d) => d.kind === params.kind)?.binaryPath ?? null
    return planFor(params.kind, binaryPath)
  })

  r.register('providers.install', async (params) => {
    // Single-flight per kind: a second click while one runs is a no-op, not a
    // second package-manager process racing the first over the same prefix.
    if (installsInFlight.has(params.kind)) {
      return { started: false, reason: 'An operation is already running for this provider.' }
    }
    const detections = await probeAllDetections()
    const binaryPath = detections.find((d) => d.kind === params.kind)?.binaryPath ?? null
    const plan = planFor(params.kind, binaryPath)
    if (plan === null) {
      return { started: false, reason: 'No known install channel for this provider.' }
    }
    const argv = params.operation === 'install' ? plan.installCommand : plan.upgradeCommand

    const publish = (frame: ProvidersUpdateFrame): void => {
      rpcRegistryRef?.publish('providers.updates', frame)
    }
    let truncated = false
    let exitCode: number | null = null
    let failure: string | null = null

    const handle = runInstall(argv, (event) => {
      if (event.type === 'progress') {
        publish({
          type: 'install.progress',
          kind: params.kind,
          stream: event.line.stream,
          text: event.line.text,
        })
        return
      }
      if (event.type === 'exit') {
        truncated = event.truncated
        exitCode = event.code
        if (event.timedOut) failure = 'Timed out after 5 minutes.'
        else if (event.code !== 0) failure = `Exited with code ${String(event.code)}.`
        return
      }
      if (event.type === 'failed') failure = event.reason
    })
    installsInFlight.set(params.kind, handle)

    void handle.done
      .then(async () => {
        // Verify by re-probing: a zero exit code does not prove the binary is
        // now resolvable (wrong prefix, PATH not refreshed, partial install).
        detectionCache = null
        updateCache = null
        const after = await probeAllDetections()
        const nowInstalled = after.find((d) => d.kind === params.kind)?.installed ?? false
        const ok = failure === null && exitCode === 0 && nowInstalled
        publish({
          type: 'install.settled',
          kind: params.kind,
          operation: params.operation,
          ok,
          reason: ok ? null : (failure ?? 'The CLI is still not detected after the command finished.'),
          truncated,
        })
      })
      .catch((error: unknown) => log.warn('install settle failed', { error: String(error) }))
      .finally(() => installsInFlight.delete(params.kind))

    return { started: true }
  })

  r.register('providers.cancelInstall', async (params) => {
    const handle = installsInFlight.get(params.kind)
    if (handle === undefined) return { cancelled: false }
    await handle.cancel()
    return { cancelled: true }
  })

  // Merged model catalogs per kind: dynamic overlay → snapshot → static.
  r.register('providers.models', () =>
    ALL_CLI_KINDS.map((kind) => ({
      kind,
      source: catalogSource(kind),
      models: modelsFor(kind),
    })),
  )

  r.register('window.minimize', () => {
    BrowserWindow.fromWebContents(contents)?.minimize()
    return { done: true }
  })

  r.register('window.toggleMaximize', () => {
    const win = BrowserWindow.fromWebContents(contents)
    if (!win) return { maximized: false }
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
    return { maximized: win.isMaximized() }
  })

  r.register('window.close', () => {
    BrowserWindow.fromWebContents(contents)?.close()
    return { done: true }
  })

  // Live theme change: repaint native chrome (Windows overlay symbols + the OS
  // light/dark hint). Window material is fixed at creation, so a glass <-> opaque
  // switch only takes full effect on the next launch.
  r.register('theme.apply', (params) => {
    const win = BrowserWindow.fromWebContents(contents)
    if (!win) return { applied: false }
    applyThemeToWindow(win, themeOf(params.themeId))
    return { applied: true }
  })

  r.register('terminal.create', async (params) => {
    // Await the guarded loader so a slow native import delays creation instead
    // of failing it; a hard load failure becomes a descriptive error.
    const mod = await loadPtyModule()
    if (!mod) throw new Error('terminal backend unavailable (native module failed to load)')
    ptyModule = mod
    terminals.create(params.id, params.cwd)
    return { created: true }
  })

  r.register('terminal.write', (params) => {
    terminals.write(params.id, params.data)
    return { written: true }
  })

  r.register('terminal.resize', (params) => {
    terminals.resize(params.id, params.cols, params.rows)
    return { resized: true }
  })

  r.register('terminal.kill', (params) => {
    terminals.kill(params.id)
    return { killed: true }
  })

  r.register('project.list', async () => getProjectStore().load())

  r.register('project.add', async (params) => {
    const project = await getProjectStore().add(params.path, params.name)
    // Warm the watcher + mentions file index in the background; the index
    // walk is awaited lazily on the first `files.index` call instead.
    if (project.status === 'ok') void ensureProjectWatched(project)
    return project
  })

  // Opening is add + mark-open: the store canonicalizes the path so the same
  // folder never yields two sidebar groups.
  r.register('project.open', async (params) => {
    const project = await getProjectStore().open(params.path, params.name)
    if (project.status === 'ok') void ensureProjectWatched(project)
    return project
  })

  // Non-destructive: the project and its sessions survive, it just leaves the
  // sidebar. `project.remove` is the destructive counterpart.
  r.register('project.close', async (params) => getProjectStore().close(params.id))

  r.register('project.remove', async (params) => {
    const project = getProjectStore().get(params.id)
    const removed = await getProjectStore().remove(params.id)
    // Stop indexing/watching the folder; a removed project must not keep
    // consuming fs events for the rest of the process.
    if (removed && project) void stopWatchingProject(project.path, project.id)
    return { removed }
  })

  r.register('dialog.pickFolder', async (params) => {
    const options: Electron.OpenDialogOptions = { properties: ['openDirectory'] }
    if (params?.defaultPath) options.defaultPath = params.defaultPath
    const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null
    const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options)
    // Cancel must be a clean no-op, not an error the renderer has to catch.
    if (result.canceled) return { path: null }
    return { path: result.filePaths[0] ?? null }
  })

  r.register('shell.revealPath', (params) => {
    shell.showItemInFolder(params.path)
    return { revealed: true }
  })

  r.register('files.index', async (params) => {
    await getProjectStore().load()
    const project = getProjectStore().get(params.projectId)
    if (!project) throw new Error(`unknown project: ${params.projectId}`)
    // Lazily (re)build after restarts: watchers only exist for projects
    // added during this app run.
    await ensureProjectWatched(project)
    return { paths: getIndexedFiles(params.projectId) ?? [] }
  })

  // Project-wide content search (M18.4): resolves the folder from the project
  // registry or an explicit path, then delegates to the jailed, capped,
  // time-boxed searcher in ./content-search.
  r.register('search.content', async (params) => {
    let root = params.path ?? null
    if (params.projectId !== undefined) {
      await getProjectStore().load()
      const project = getProjectStore().get(params.projectId)
      if (!project) throw new Error(`unknown project: ${params.projectId}`)
      root = project.path
    }
    if (root === null) throw new Error('projectId or path is required')
    return searchProjectContent(root, params.query, { maxResults: params.maxResults })
  })

  r.register('endpoints.list', async () => {
    const store = getEndpointStore()
    await store.load()
    return store.list()
  })

  r.register('endpoints.upsert', async (params) => {
    const store = getEndpointStore()
    await store.load()
    const saved = await store.upsert({
      id: params.id,
      name: params.name,
      baseUrl: params.baseUrl,
      flavor: params.flavor,
      model: params.model,
      headers: params.headers,
      // undefined keeps the stored key; null clears it (store semantics).
      apiKey: params.apiKey === undefined ? undefined : params.apiKey || null,
    })
    return { id: saved.id, name: saved.name }
  })

  r.register('endpoints.remove', async (params) => {
    const store = getEndpointStore()
    await store.load()
    return { removed: await store.remove(params.id) }
  })

  // Connection probe runs in the main process: the renderer is blocked from
  // cross-origin fetches by CORS, which would report every endpoint broken.
  r.register('endpoints.test', async (params) => {
    const base = params.baseUrl.replace(/\/+$/, '')
    const url =
      params.flavor === 'anthropic-messages'
        ? `${base}/v1/models`
        : params.flavor === 'ollama'
          ? `${base}/api/tags`
          : `${base}/models`
    const headers: Record<string, string> =
      params.flavor === 'anthropic-messages'
        ? { 'x-api-key': params.apiKey ?? '', 'anthropic-version': '2023-06-01' }
        : params.flavor === 'openai-chat' && params.apiKey
          ? { Authorization: `Bearer ${params.apiKey}` }
          : {}
    const startedAt = Date.now()
    try {
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(6000) })
      const latencyMs = Date.now() - startedAt
      // Any HTTP answer proves the endpoint is reachable; auth/model problems
      // surface with their real status so the user can fix them precisely.
      return {
        ok: true,
        latencyMs,
        message:
          response.status === 200 ? 'connected' : `reachable (HTTP ${response.status} ${response.statusText})`,
      }
    } catch (error) {
      const latencyMs = Date.now() - startedAt
      const message =
        error instanceof Error && error.name === 'TimeoutError' ? 'timed out' : 'unreachable'
      return { ok: false, latencyMs, message }
    }
  })

  r.register('git.status', async (params) => {
    const { GitService } = await import('@ari/engine/git')
    const result = await new GitService().status(params.path)
    if (!result.ok) return { isRepo: false, branch: null, files: [], error: result.error.message }
    return {
      isRepo: true,
      branch: result.value.branch,
      files: result.value.files,
    }
  })

  r.register('git.diffWorktree', async (params) => {
    const { GitService } = await import('@ari/engine/git')
    const result = await new GitService().diffForRef(params.path, 'HEAD')
    if (!result.ok) return { diffText: '', error: result.error.message }
    return { diffText: result.value }
  })

  // Per-turn diff (M8.4): worktree vs the turn's hidden checkpoint ref.
  r.register('git.turnDiff', async (params) => {
    const { GitService } = await import('@ari/engine/git')
    return queryTurnDiff((cwd, gitRef) => new GitService().diffForRef(cwd, gitRef), params)
  })

  // Mutating git actions (M19.5): performGitAction jails `path` to an existing
  // directory and maps every failure into a `{ ok: false, error }` result so
  // nothing throws across IPC.
  r.register('git.add', async (params) =>
    performGitAction(params.path, () => gitStage(params.path, params.paths)),
  )

  r.register('git.commit', async (params) =>
    performGitAction(params.path, () => gitCommit(params.path, params.message)),
  )

  r.register('git.push', async (params) =>
    performGitAction(params.path, () => gitPush(params.path, params.remote)),
  )

  // Ship flow (M21.4): open a PR through the GitHub CLI.
  r.register('git.createPr', async (params) => {
    const info = await stat(params.path).catch(() => null)
    if (info === null || !info.isDirectory()) {
      return { ok: false, url: null, error: 'path must be an existing project directory' }
    }
    const result = await createPullRequest(params.path, {
      title: params.title,
      ...(params.body !== undefined ? { body: params.body } : {}),
      ...(params.base !== undefined ? { base: params.base } : {}),
    })
    return result.ok
      ? { ok: true, url: result.value.length > 0 ? result.value : null }
      : { ok: false, url: null, error: result.error.message }
  })

  r.register('fs.list', async (params) => {
    // Path jail: the caller passes an absolute directory; it must exist and
    // be a directory, and only regular files/dirs directly inside are
    // returned (symlinks and special entries are skipped so listings cannot
    // escape the tree).
    const info = await stat(params.path).catch(() => null)
    if (info === null) throw new Error('path does not exist')
    if (!info.isDirectory()) throw new Error('not a directory')
    const dirents = await readdir(params.path, { withFileTypes: true })
    const listed: RpcResults['fs.list'] = []
    for (const dirent of dirents) {
      if (dirent.isDirectory()) {
        listed.push({ name: dirent.name, type: 'dir', size: 0 })
      } else if (dirent.isFile()) {
        const size = await stat(join(params.path, dirent.name)).then((s) => s.size, () => 0)
        listed.push({ name: dirent.name, type: 'file', size })
      }
    }
    return listed.sort((a, b) =>
      a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1,
    )
  })

  r.register('fs.readTextFile', async (params) => {
    const cap = Math.min(params.maxBytes ?? FS_READ_MAX_BYTES, FS_READ_MAX_BYTES)
    const handle = await open(params.path, 'r')
    try {
      const { size } = await handle.stat()
      if (size === 0) return { content: '', truncated: false }
      const length = Math.min(size, cap)
      const buffer = Buffer.alloc(length)
      const { bytesRead } = await handle.read(buffer, 0, length, 0)
      if (buffer.subarray(0, Math.min(bytesRead, FS_BINARY_SNIFF_BYTES)).includes(0)) {
        throw new Error('binary file')
      }
      return {
        content: buffer.subarray(0, bytesRead).toString('utf8'),
        truncated: size > bytesRead,
      }
    } finally {
      await handle.close()
    }
  })

  r.register('fs.writeTextFile', async (params) => {
    // Writes are jailed harder than reads: the target must canonicalize
    // (symlinks included) inside a registered project folder.
    await getProjectStore().load()
    const roots = getProjectStore().list().map((p) => p.path)
    const bytesWritten = await writeTextFile(params, roots)
    return { bytesWritten }
  })

  // Structured plan surface (research wave M20): reads the `.ari-todo.json`
  // that Ari Core's todo_write tool maintains in the session workspace.
  r.register('plan.get', async (params) => {
    try {
      const raw = await readFile(join(params.path, '.ari-todo.json'), 'utf8')
      const parsed: unknown = JSON.parse(raw)
      if (!Array.isArray(parsed)) return { items: null }
      const items: { text: string; status: 'pending' | 'in_progress' | 'done' }[] = []
      for (const entry of parsed) {
        const record = entry as { text?: unknown; status?: unknown }
        if (
          typeof record?.text === 'string' &&
          record.text.length > 0 &&
          (record.status === 'pending' || record.status === 'in_progress' || record.status === 'done')
        ) {
          items.push({ text: record.text, status: record.status })
        }
      }
      return { items }
    } catch {
      return { items: null }
    }
  })

  // Run scripts (M21.3): npm-style `scripts` from the folder's package.json.
  r.register('scripts.list', async (params) => listScripts(params.path))

  r.register('stream.subscribe', (params) => {
    rpcRegistry.subscribe({
      id: params.id,
      name: params.name,
      params: params.params,
    })
    // Replay the journal so late subscribers get full history first. Frames
    // are tagged `replay` and terminated by a `replayDone` sentinel so the
    // renderer can order the burst against live events that arrive while the
    // journal is being read — otherwise a mid-turn resubscribe (e.g. returning
    // from Settings) delivers the same seq twice and the transcript doubles.
    if (params.name === 'session.events') {
      const sessionId = params.params['sessionId']
      if (typeof sessionId === 'string') {
        void engine
          .replaySession(sessionId)
          .then((events) => {
            for (const event of events) {
              rpcRegistry.publish('session.events', { sessionId, event, replay: true } satisfies SessionEventFrame)
            }
            rpcRegistry.publish('session.events', { sessionId, replayDone: true } satisfies SessionEventFrame)
          })
          .catch((error: unknown) => log.warn('journal replay failed', { sessionId, error: String(error) }))
      }
    }
    if (params.name === 'terminal.data') {
      const terminalId = params.params['id']
      if (typeof terminalId === 'string') {
        const scrollback = terminals.replay(terminalId)
        if (scrollback.length > 0) {
          rpcRegistry.publish('terminal.data', { id: terminalId, data: scrollback })
        }
      }
    }
    if (params.name === 'providers.updates') {
      // Late subscribers immediately get the current state of both feeds.
      if (updateCache !== null) {
        rpcRegistry.publish('providers.updates', {
          type: 'detections',
          detections: updateCache.value,
        } satisfies ProvidersUpdateFrame)
      }
      rpcRegistry.publish('providers.updates', {
        type: 'catalog',
        at: catalogService.lastRefreshAt,
      } satisfies ProvidersUpdateFrame)
    }
    return { subscribed: true }
  })

  r.register('stream.unsubscribe', (params) => {
    rpcRegistry.unsubscribe(params.id)
    return { unsubscribed: true }
  })

  const methods = [
    'ping',
    'app.info',
    'session.list',
    'session.create',
    'session.load',
    'session.destroy',
    'usage.summary',
    'usage.ccusage',
    'command.dispatch',
    'providers.detect',
    'providers.models',
    'providers.plan',
    'providers.install',
    'providers.cancelInstall',
    'window.minimize',
    'window.toggleMaximize',
    'window.close',
    'theme.apply',
    'terminal.create',
    'terminal.write',
    'terminal.resize',
    'terminal.kill',
    'project.list',
    'project.add',
    'project.open',
    'project.close',
    'project.remove',
    'dialog.pickFolder',
    'shell.revealPath',
    'files.index',
    'search.content',
    'endpoints.list',
    'endpoints.upsert',
    'endpoints.remove',
    'endpoints.test',
    'settings.get',
    'settings.update',
    'git.status',
    'git.diffWorktree',
    'git.turnDiff',
    'git.add',
    'git.commit',
    'git.push',
    'fs.list',
    'fs.readTextFile',
    'fs.writeTextFile',
    'stream.subscribe',
    'stream.unsubscribe',
  ] as const

  for (const method of methods) {
    ipcMain.removeHandler(`ari:${method}`)
    ipcMain.handle(`ari:${method}`, (_event, payload) => {
      return rpcRegistry.invoke(method, payload).catch((error: unknown) => {
        throw error instanceof Error ? error : new Error(String(error))
      })
    })
  }

  return { engine, registry: driverRegistry }
}
