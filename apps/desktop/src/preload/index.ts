import { contextBridge, ipcRenderer } from 'electron'

const api = {
  ping: (): Promise<{ pong: boolean; at: number }> => ipcRenderer.invoke('ari:ping'),
}

contextBridge.exposeInMainWorld('ari', api)

export type AriPreloadApi = typeof api
