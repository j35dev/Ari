import { join } from 'node:path'
import { BrowserWindow } from 'electron'
import { getSettingsStore } from './store'

/**
 * Platform chrome strategy (PLAN §8):
 *  - Windows: hidden frame + native titleBarOverlay (snap/max/min preserved)
 *  - macOS:   hiddenInset traffic lights
 *  - Linux:   hidden frame; custom controls ship in the renderer titlebar
 *
 * Window bounds persist across launches via the settings store.
 */
export function createMainWindow(): BrowserWindow {
  const settings = getSettingsStore().current.window

  const win = new BrowserWindow({
    width: settings?.width ?? 1280,
    height: settings?.height ?? 800,
    x: settings?.x,
    y: settings?.y,
    minWidth: 960,
    minHeight: 600,
    show: false,
    backgroundColor: '#0b0b0e',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    titleBarOverlay:
      process.platform === 'win32' ? { color: '#00000000', symbolColor: '#e6e6ea' } : false,
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  })

  if (settings?.maximized) win.maximize()

  const persistBounds = (): void => {
    if (win.isDestroyed() || win.isMinimized()) return
    const bounds = win.isMaximized() ? null : win.getBounds()
    const store = getSettingsStore()
    void store
      .update({
        window:
          bounds === null
            ? {
                ...(store.current.window ?? {
                  x: 0,
                  y: 0,
                  width: 1280,
                  height: 800,
                }),
                maximized: true,
              }
            : { ...bounds, maximized: false },
      })
      .catch(() => undefined)
  }

  win.on('resized', persistBounds)
  win.on('moved', persistBounds)
  win.on('maximize', persistBounds)
  win.on('unmaximize', persistBounds)

  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  }

  win.once('ready-to-show', () => win.show())
  return win
}
