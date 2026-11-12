import { join } from 'node:path'
import { app, BrowserWindow, nativeTheme } from 'electron'
import type { WebContents } from 'electron'
import { oklchToHex } from '@ari/ui/color'
import { themeOf } from '@ari/ui/themes'
import type { Theme } from '@ari/ui/themes'
import { appDisplayName } from './dev-instance'
import { attachAppShellNavigationGuard } from './app-shell-guard'
import { getSettingsStore } from './store'
import type { RpcRegistry } from './rpc-registry'

/** Native chrome and the renderer Close button use the same window lifecycle. */
export function registerWindowControls(contents: WebContents, registry: RpcRegistry): void {
  registry.register('window.minimize', () => {
    BrowserWindow.fromWebContents(contents)?.minimize()
    return { done: true }
  })
  registry.register('window.toggleMaximize', () => {
    const win = BrowserWindow.fromWebContents(contents)
    if (!win) return { maximized: false }
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
    return { maximized: win.isMaximized() }
  })
  registry.register('window.close', () => {
    BrowserWindow.fromWebContents(contents)?.close()
    return { done: true }
  })
}

/**
 * The native window always uses a solid `backgroundColor` from the active
 * theme's `bg` token, so no desktop content bleeds through and a light theme
 * never flashes black before the renderer paints.
 *
 * Window bounds persist across launches via the settings store.
 */

/** Fallback chrome colors if a token ever fails to parse. */
const FALLBACK_BG = '#171717'
const FALLBACK_SYMBOL = '#eaeaea'

/** Packaged renderer policy; remote audio is restricted to HTTPS media only. */
export const PACKAGED_CONTENT_SECURITY_POLICY =
  "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' http: https: ws:; media-src 'self' https: blob:"

export interface ThemeWindowChrome {
  backgroundColor: string
  symbolColor: string
}

/** Native window colors derived from a theme. */
export function themeWindowChrome(theme: Theme): ThemeWindowChrome {
  const symbolColor = oklchToHex(theme.colors.fg) ?? FALLBACK_SYMBOL
  return { backgroundColor: oklchToHex(theme.colors.bg) ?? FALLBACK_BG, symbolColor }
}

/** The theme the window should paint, per persisted settings. */
export function persistedTheme(): Theme {
  return themeOf(getSettingsStore().current.appearance.themeId)
}

/**
 * Repaints native chrome for a live theme change: the Windows overlay symbol
 * color and the OS-level light/dark hint.
 */
export function applyThemeToWindow(win: BrowserWindow, theme: Theme): void {
  const chrome = themeWindowChrome(theme)
  nativeTheme.themeSource = theme.scheme
  if (process.platform === 'win32' && !win.isDestroyed()) {
    win.setTitleBarOverlay({ color: '#00000000', symbolColor: chrome.symbolColor, height: 44 })
  }
}

export function createMainWindow(): BrowserWindow {
  const settings = getSettingsStore().current.window
  const theme = persistedTheme()
  const chrome = themeWindowChrome(theme)

  const win = new BrowserWindow({
    width: settings?.width ?? 1280,
    height: settings?.height ?? 800,
    x: settings?.x,
    y: settings?.y,
    minWidth: 960,
    minHeight: 600,
    show: false,
    title: appDisplayName(app.isPackaged),
    backgroundColor: chrome.backgroundColor,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    titleBarOverlay:
      process.platform === 'win32'
        ? { color: '#00000000', symbolColor: chrome.symbolColor, height: 44 }
        : false,
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  })
  // Keep named dev instances distinguishable in the taskbar/window switcher.
  if (!app.isPackaged && process.env.ARI_DEV_INSTANCE) {
    win.on('page-title-updated', (event) => event.preventDefault())
  }

  nativeTheme.themeSource = theme.scheme

  if (settings?.maximized) win.maximize()

  // Packaged builds enforce a strict CSP via response headers. Dev is exempt
  // so the Vite dev server's inline React-refresh preamble keeps working, and
  // so users can probe arbitrary model endpoints from the endpoints manager.
  if (!process.env['ELECTRON_RENDERER_URL']) {
    win.webContents.session.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [PACKAGED_CONTENT_SECURITY_POLICY],
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

  attachAppShellNavigationGuard(win.webContents)

  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL']).catch(() => undefined)
  } else {
    void win.loadFile(join(import.meta.dirname, '../renderer/index.html')).catch(() => undefined)
  }

  // The main lifecycle decides whether the first paint should reveal this
  // window: a Close received during startup must remain hidden.
  return win
}
