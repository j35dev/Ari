import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { WidgetSnapshot } from './model'

contextBridge.exposeInMainWorld('ariaWidget', {
  invoke: (method: string, params?: unknown): Promise<unknown> =>
    method === 'speech.status' || method === 'speech.transcribe'
      ? ipcRenderer.invoke('ari:ariaWidget.speech', { method, payload: params })
      : ipcRenderer.invoke(`ari:${method}`, params),
  onState: (callback: (state: WidgetSnapshot) => void): (() => void) => {
    const receive = (_event: IpcRendererEvent, state: WidgetSnapshot): void => callback(state)
    ipcRenderer.on('ari:ariaWidget.state', receive)
    return () => ipcRenderer.removeListener('ari:ariaWidget.state', receive)
  },
})
