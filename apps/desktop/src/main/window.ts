import { join } from 'node:path'
import { BrowserWindow } from 'electron'

/**
 * Platform chrome strategy (PLAN §8):
 *  - Windows: hidden frame + native titleBarOverlay (snap/max/min preserved)
 *  - macOS:   hiddenInset traffic lights
 *  - Linux:   hidden frame; custom controls ship in the renderer titlebar (M2)
 */
export function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
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

  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  }

  win.once('ready-to-show', () => win.show())
  return win
}
