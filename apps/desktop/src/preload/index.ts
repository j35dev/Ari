import type { VoiceAudio } from '../renderer/src/features/aria/voice-playback'
import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { IpcRendererEvent } from 'electron'
import type { StreamBatchFrame, StreamFrame } from '@ari/contracts/rpc'
import { StreamRouter } from './stream-router'
import type {
  PendingSnapshot,
  SnapshotEvent,
  SnapshotStatus,
  SnapshotRectangle,
} from '../shared/snapshots'

const STREAM_CHANNEL = 'ari:stream'

const streams = new StreamRouter()
ipcRenderer.on(STREAM_CHANNEL, (_event: IpcRendererEvent, frame: StreamFrame | StreamBatchFrame) =>
  streams.dispatch(frame),
)

const api = {
  snapshots: {
    status: (): Promise<SnapshotStatus> => ipcRenderer.invoke('ari:snapshots.status'),
    pending: (): Promise<PendingSnapshot[]> => ipcRenderer.invoke('ari:snapshots.pending'),
    read: (id: string): Promise<PendingSnapshot & { dataBase64: string }> =>
      ipcRenderer.invoke('ari:snapshots.read', id),
    target: (id: string, target: string): Promise<string> =>
      ipcRenderer.invoke('ari:snapshots.target', id, target),
    acknowledge: (id: string): Promise<void> => ipcRenderer.invoke('ari:snapshots.acknowledge', id),
    destination: (id: string, rectangle: SnapshotRectangle): Promise<void> =>
      ipcRenderer.invoke('ari:snapshots.destination', id, rectangle),
    suppress: (suppressed: boolean): Promise<void> =>
      ipcRenderer.invoke('ari:snapshots.suppress', suppressed),
    onEvent: (callback: (event: SnapshotEvent) => void): (() => void) => {
      const receive = (_event: IpcRendererEvent, event: SnapshotEvent) => callback(event)
      ipcRenderer.on('ari:snapshots.event', receive)
      return () => ipcRenderer.removeListener('ari:snapshots.event', receive)
    },
  },
  voice: {
    played: (id: number, generation: number, error?: string): void =>
      ipcRenderer.send('ari:ariaVoice.played', { id, generation, error }),
    onAudio: (callback: (frame: VoiceAudio) => void): (() => void) => {
      const receive = (_event: IpcRendererEvent, frame: VoiceAudio) => callback(frame)
      ipcRenderer.on('ari:ariaVoice.audio', receive)
      return () => ipcRenderer.removeListener('ari:ariaVoice.audio', receive)
    },
  },
  dictation: {
    acquire: (token?: string): Promise<string> =>
      ipcRenderer.invoke('ari:speechCapture.acquire', token),
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
