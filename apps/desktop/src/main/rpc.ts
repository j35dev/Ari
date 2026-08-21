import { ipcMain, type WebContents } from 'electron'
import type { JournalEvent } from '@ari/contracts/events'
import type { SessionEventFrame } from '@ari/contracts/rpc'
import { Engine } from './engine'
import { RpcRegistry } from './rpc-registry'
import { getSessionStore } from './store'
import { DriverRegistry } from '@ari/providers/registry'
import { ClaudeDriver } from '@ari/providers/claude'
import { CodexDriver } from '@ari/providers/codex'
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
  const candidates: { kind: 'claude' | 'codex'; make: (bin: string) => unknown }[] = [
    { kind: 'claude', make: (bin) => new ClaudeDriver(bin) },
    { kind: 'codex', make: (bin) => new CodexDriver(bin) },
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

