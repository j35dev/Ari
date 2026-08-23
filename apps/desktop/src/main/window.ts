import { join } from 'node:path'
import { BrowserWindow, nativeTheme } from 'electron'
import { getSettingsStore } from './store'

/**
 * Platform chrome strategy (PLAN §8):
 *  - Windows: hidden frame + native titleBarOverlay (snap/max/min preserved),
 *    backgroundMaterial 'acrylic' so the glass chrome shows the desktop
 *  - macOS:   hiddenInset traffic lights + vibrancy 'under-window'
 *  - Linux:   hidden frame; custom controls ship in the renderer titlebar;
 *    transparent window over the desktop (compositor blur not guaranteed)
 *
 * Window bounds persist across launches via the settings store.
 */

/** Overlay symbol color matching --ari-fg (comet neutral-200). */
const OVERLAY_SYMBOL = '#eaeaea'

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
    backgroundColor: '#00000000',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    titleBarOverlay:
      process.platform === 'win32'
        ? { color: '#00000000', symbolColor: OVERLAY_SYMBOL, height: 38 }
        : false,
    // Glass: the desktop shows through the shell chrome. Windows gets DWM
    // acrylic; macOS gets native vibrancy; Linux composites its own blur via
    // CSS backdrop-filter inside a transparent window.
    ...(process.platform === 'win32'
      ? { backgroundMaterial: 'acrylic' as const }
      : process.platform === 'darwin'
        ? { vibrancy: 'under-window' as const, visualEffectState: 'active' as const }
        : { transparent: true }),
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  })

  if (process.platform === 'win32') {
    nativeTheme.themeSource = 'dark'
  }

  if (settings?.maximized) win.maximize()

  // Packaged builds enforce a strict CSP via response headers. Dev is exempt
  // so the Vite dev server's inline React-refresh preamble keeps working, and
  // so users can probe arbitrary model endpoints from the endpoints manager.
  if (!process.env['ELECTRON_RENDERER_URL']) {
    win.webContents.session.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [
            "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' http: https: ws:",
          ],
        },
      })
    })
  }

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
