import type { VoiceAudio } from '../renderer/src/features/aria/voice-playback'
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
  voice: {
    played: (id: number, generation: number, error?: string): void =>
      ipcRenderer.send('ari:ariaVoice.played', { id, generation, error }),
    onAudio: (
      callback: (frame: VoiceAudio) => void,
    ): (() => void) => {
      const receive = (
        _event: IpcRendererEvent,
        frame: VoiceAudio,
      ) => callback(frame)
      ipcRenderer.on('ari:ariaVoice.audio', receive)
      return () => ipcRenderer.removeListener('ari:ariaVoice.audio', receive)
    },
  },
  dictation: {
    acquire: (): Promise<string> => ipcRenderer.invoke('ari:speechCapture.acquire'),
    release: (token: string): Promise<void> =>
      ipcRenderer.invoke('ari:speechCapture.release', token),
  },
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
