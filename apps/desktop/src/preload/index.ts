import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import type { StreamFrame } from '@ari/contracts/rpc'

const STREAM_CHANNEL = 'ari:stream'

const api = {
  invoke: (method: string, params?: unknown): Promise<unknown> => {
    return ipcRenderer.invoke(`ari:${method}`, params)
  },
  /** Returns an unsubscribe function; frames arrive tagged by subscription id. */
  subscribe: (id: string, callback: (frame: StreamFrame) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, frame: StreamFrame): void => {
      if (frame.id === id) callback(frame)
    }
    ipcRenderer.on(STREAM_CHANNEL, listener)
    return () => {
      ipcRenderer.removeListener(STREAM_CHANNEL, listener)
    }
  },
}

contextBridge.exposeInMainWorld('ari', api)

export type AriPreloadApi = typeof api
