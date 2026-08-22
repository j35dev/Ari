import { open, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { app, BrowserWindow, ipcMain, type WebContents } from 'electron'
import type { IPty, IPtyForkOptions } from '@lydell/node-pty'
import type { JournalEvent } from '@ari/contracts/events'
import type { DriverKind } from '@ari/contracts/common'
import type { RpcResults, SessionEventFrame } from '@ari/contracts/rpc'
import { createLogger } from '@ari/shared/logger'
import { Engine } from './engine'
import { RpcRegistry } from './rpc-registry'
import { getEndpointStore, getProjectStore, getSessionStore, getSettingsStore } from './store'
import { TerminalService, type PtyFactory, type PtyLike } from './terminal-service'
import { ensureProjectWatched, getIndexedFiles } from './watcher-bridge'
import { DriverRegistry } from '@ari/providers/registry'
import { ClaudeDriver } from '@ari/providers/claude'
import { CodexDriver } from '@ari/providers/codex'
import { OpencodeDriver } from '@ari/providers/opencode'
import { GrokDriver } from '@ari/providers/grok'
import { PiDriver } from '@ari/providers/pi'
import { HermesDriver } from '@ari/providers/hermes'
import { detectDriver } from '@ari/providers/detector'
import type { DetectEnvironment } from '@ari/providers/types'
import { realDetectEnvironment } from '@ari/providers/types'
import { AriCoreDriver } from '@ari/ari-core/driver'

const log = createLogger('desktop:rpc')

/**
 * Every CLI kind probed by `providers.detect`, regardless of hydration state,
 * so the providers grid is complete even while drivers are still registering.
 */
const ALL_CLI_KINDS: DriverKind[] = ['claude', 'codex', 'opencode', 'grok', 'pi', 'hermes']

/** Short cache so mount-time detect calls from several views share one probe round. */
let detectionCache: { at: number; value: Promise<RpcResults['providers.detect']> } | null = null
const DETECTION_CACHE_TTL_MS = 30_000

function probeAllDetections(): Promise<RpcResults['providers.detect']> {
  if (detectionCache === null || Date.now() - detectionCache.at > DETECTION_CACHE_TTL_MS) {
    const env: DetectEnvironment = realDetectEnvironment()
    detectionCache = {
      at: Date.now(),
      value: Promise.all(
        [...ALL_CLI_KINDS, 'ari-core' as DriverKind].map(async (kind) => {
          try {
            return await detectDriver(kind, env)
          } catch (error) {
            log.error('detection crashed', { kind, error: String(error) })
            return { kind, binaryPath: null, version: null, authStatus: 'unknown' }
          }
        }),
      ),
    }
  }
  return detectionCache.value
}

/**
 * Registers each installed CLI driver as its detection resolves. Detection is
 * concurrent and runs in the background — the RPC surface is fully usable the
 * instant this function is called.
 */
function hydrateDrivers(registry: DriverRegistry): void {
  const env = realDetectEnvironment()
  const candidates: {
    kind: 'claude' | 'codex' | 'opencode' | 'grok' | 'pi' | 'hermes'
    make: (bin: string) => unknown
  }[] = [
    { kind: 'claude', make: (bin) => new ClaudeDriver(bin) },
    { kind: 'codex', make: (bin) => new CodexDriver(bin) },
    { kind: 'opencode', make: (bin) => new OpencodeDriver(bin) },
    { kind: 'grok', make: (bin) => new GrokDriver(bin) },
    { kind: 'pi', make: (bin) => new PiDriver(bin) },
    { kind: 'hermes', make: (bin) => new HermesDriver(bin) },
  ]
  void Promise.all(
    candidates.map(async (candidate) => {
      try {
        const detection = await detectDriver(candidate.kind, env)
        if (detection.binaryPath) {
          registry.register(candidate.make(detection.binaryPath) as never)
          log.info('driver registered', { kind: candidate.kind, version: detection.version })
        }
      } catch (error) {
        log.error('driver detection failed', { kind: candidate.kind, error: String(error) })
      }
    }),
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

export function registerRpc(contents: WebContents): EngineHandle {
  const rpcRegistry = new RpcRegistry({
    send: (frame) => {
      if (!contents.isDestroyed()) contents.send(STREAM_CHANNEL, frame)
    },
  })

  // The registry exists immediately with Ari Core attached; CLI drivers are
  // added as background detection completes. Nothing waits on that to answer.
  const driverRegistry = new DriverRegistry()
  driverRegistry.register(new AriCoreDriver(getEndpointStore()))
  hydrateDrivers(driverRegistry)

  const engine = new Engine({
    store: getSessionStore(),
    registry: driverRegistry,
    publish: (sessionId: string, event: JournalEvent) => {
      const payload: SessionEventFrame = { sessionId, event }
      rpcRegistry.publish('session.events', payload)
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

  r.register('command.dispatch', async (params) => engine.dispatch(params.command))

  r.register('providers.detect', () => probeAllDetections())

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
    if (project) void ensureProjectWatched(project)
    return project ? { id: project.id, name: project.name, path: project.path } : null
  })

  r.register('project.remove', async (params) => {
    return { removed: await getProjectStore().remove(params.id) }
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

  r.register('stream.subscribe', (params) => {
    rpcRegistry.subscribe({
      id: params.id,
      name: params.name,
      params: params.params,
    })
    // Replay the journal so late subscribers get full history first.
    if (params.name === 'session.events') {
      const sessionId = params.params['sessionId']
      if (typeof sessionId === 'string') {
        void engine.replaySession(sessionId).then((events) => {
          for (const event of events) {
            rpcRegistry.publish('session.events', { sessionId, event } satisfies SessionEventFrame)
          }
        })
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
    'command.dispatch',
    'providers.detect',
    'window.minimize',
    'window.toggleMaximize',
    'window.close',
    'terminal.create',
    'terminal.write',
    'terminal.resize',
    'terminal.kill',
    'project.list',
    'project.add',
    'project.remove',
    'files.index',
    'endpoints.list',
    'endpoints.upsert',
    'endpoints.remove',
    'endpoints.test',
    'settings.get',
    'settings.update',
    'git.status',
    'git.diffWorktree',
    'fs.list',
    'fs.readTextFile',
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
