import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { IpcRendererEvent } from 'electron'
import type { StreamBatchFrame, StreamFrame } from '@ari/contracts/rpc'
import { StreamRouter } from './stream-router'

const STREAM_CHANNEL = 'ari:stream'

const streams = new StreamRouter()
ipcRenderer.on(STREAM_CHANNEL, (_event: IpcRendererEvent, frame: StreamFrame | StreamBatchFrame) =>
  streams.dispatch(frame),
)

const api = {
  invoke: (method: string, params?: unknown): Promise<unknown> => {
    return ipcRenderer.invoke(`ari:${method}`, params)
  },
  /**
   * Absolute OS path for a renderer File (OS drag/drop/paste); '' when
   * unavailable. Sandboxed renderers cannot read paths themselves, so the
   * preload resolves them via Electron's file-utils API.
   */
  filePath: (file: File): string => {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      return ''
    }
  },
  /** Returns an unsubscribe function; frames arrive tagged by subscription id. */
  subscribe: (id: string, callback: (frame: StreamFrame) => void): (() => void) =>
    streams.subscribe(id, callback),
}

contextBridge.exposeInMainWorld('ari', api)

export type AriPreloadApi = typeof api
