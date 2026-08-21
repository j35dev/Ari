import { BrowserWindow, ipcMain, type WebContents } from 'electron'
import type { IPty, IPtyForkOptions } from 'node-pty'
import type { JournalEvent } from '@ari/contracts/events'
import type { SessionEventFrame } from '@ari/contracts/rpc'
import { Engine } from './engine'
import { RpcRegistry } from './rpc-registry'
import { getProjectStore, getSessionStore } from './store'
import { TerminalService, type PtyFactory, type PtyLike } from './terminal-service'
import { DriverRegistry } from '@ari/providers/registry'
import { ClaudeDriver } from '@ari/providers/claude'
import { CodexDriver } from '@ari/providers/codex'
import { OpencodeDriver } from '@ari/providers/opencode'
import { GrokDriver } from '@ari/providers/grok'
import { PiDriver } from '@ari/providers/pi'
import { detectDriver } from '@ari/providers/detector'
import { realDetectEnvironment } from '@ari/providers/types'

/**
 * Registers every installed CLI driver. Detection is async at boot; drivers
 * whose binaries are missing are simply absent from the registry, and the
 * providers page surfaces that via `providers.detect`.
 */
async function buildRegistry(): Promise<DriverRegistry> {
  const registry = new DriverRegistry()
  const env = realDetectEnvironment()
  const candidates: {
    kind: 'claude' | 'codex' | 'opencode' | 'grok' | 'pi'
    make: (bin: string) => unknown
  }[] = [
    { kind: 'claude', make: (bin) => new ClaudeDriver(bin) },
    { kind: 'codex', make: (bin) => new CodexDriver(bin) },
    { kind: 'opencode', make: (bin) => new OpencodeDriver(bin) },
    { kind: 'grok', make: (bin) => new GrokDriver(bin) },
    { kind: 'pi', make: (bin) => new PiDriver(bin) },
  ]
  for (const candidate of candidates) {
    const detection = await detectDriver(candidate.kind, env)
    if (detection.binaryPath) {
      registry.register(candidate.make(detection.binaryPath) as never)
    }
  }
  return registry
}

/**
 * Wires the engine + RPC registry to Electron IPC. The renderer can only
 * reach registered methods; payloads are validated in the registry; stream
 * frames are delivered over a single dedicated channel with per-subscription
 * ids.
 */
export const STREAM_CHANNEL = 'ari:stream'

/** Structural type for the lazily-loaded node-pty module. */
type NodePtyModule = {
  spawn(file: string, args: string[], options: IPtyForkOptions): IPty
}

export interface EngineHandle {
  engine: Engine
  registry: DriverRegistry
}

export function registerRpc(contents: WebContents): Promise<EngineHandle> {
  const rpcRegistry = new RpcRegistry({
    send: (frame) => {
      if (!contents.isDestroyed()) contents.send(STREAM_CHANNEL, frame)
    },
  })

  return buildRegistry().then((driverRegistry) => {
    const engine = new Engine({
      store: getSessionStore(),
      registry: driverRegistry,
      publish: (sessionId: string, event: JournalEvent) => {
        const payload: SessionEventFrame = { sessionId, event }
        rpcRegistry.publish('session.events', payload)
      },
    })

    // node-pty is built for Electron's ABI; load it lazily and adapt.
    let ptyModule: NodePtyModule | null = null
    void import('node-pty').then((m) => {
      ptyModule = m
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

    r.register('providers.detect', async () => driverRegistry.detectAll())

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

    r.register('terminal.create', (params) => {
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
      return project ? { id: project.id, name: project.name, path: project.path } : null
    })

    r.register('project.remove', async (params) => {
      return { removed: await getProjectStore().remove(params.id) }
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
  })
}

