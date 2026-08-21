import { ipcMain, type WebContents } from 'electron'
import type { StreamFrame } from '@ari/contracts/rpc'
import { RpcRegistry, type HandlerMap } from './rpc-registry'
import { getSessionStore } from './store'

/**
 * Wires the RPC registry to Electron IPC. The renderer can only reach
 * registered methods; payloads are validated in the registry; stream frames
 * are delivered over a single dedicated channel with per-subscription ids.
 */
export const STREAM_CHANNEL = 'ari:stream'

export function registerRpc(contents: WebContents): RpcRegistry {
  const registry = new RpcRegistry({
    send: (frame: StreamFrame) => {
      if (!contents.isDestroyed()) contents.send(STREAM_CHANNEL, frame)
    },
  })

  registry.register('ping', () => ({ pong: true, at: Date.now() }))

  registry.register('session.list', async () => {
    return getSessionStore().listSessions()
  })

  registry.register('session.create', async (params) => {
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

  registry.register('session.load', async (params) => {
    const model = await getSessionStore().load(params.sessionId)
    return model.session ? model : null
  })

  registry.register('session.destroy', async (params) => {
    await getSessionStore().destroy(params.sessionId)
    return { destroyed: true }
  })

  // Turn execution arrives with the driver runtime (M4); until then the
  // dispatcher validates and rejects commands explicitly rather than silently.
  registry.register('command.dispatch', () => Promise.resolve({ accepted: false }))

  registry.register('stream.subscribe', (params) => {
    registry.subscribe({
      id: params.id,
      name: params.name,
      params: params.params,
    })
    return { subscribed: true }
  })

  registry.register('stream.unsubscribe', (params) => {
    registry.unsubscribe(params.id)
    return { unsubscribed: true }
  })

  const methods = [
    'ping',
    'session.list',
    'session.create',
    'session.load',
    'session.destroy',
    'command.dispatch',
    'stream.subscribe',
    'stream.unsubscribe',
  ] as const

  for (const method of methods) {
    ipcMain.removeHandler(`ari:${method}`)
    ipcMain.handle(`ari:${method}`, (_event, payload) => {
      return registry.invoke(method, payload).catch((error: unknown) => {
        throw error instanceof Error ? error : new Error(String(error))
      })
    })
  }

  return registry
}

export type { HandlerMap }
