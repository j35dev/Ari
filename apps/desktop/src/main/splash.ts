import { join } from 'node:path'
import { app, BrowserWindow } from 'electron'

/** The "Ari awakens" startup splash (M14): a frameless dark canvas with the
 * brand animation and a synthesized signature sound. It covers the whole
 * startup sequence — driver detection, catalog hydration, renderer load —
 * and hands over to the main window the moment it is actually ready. */
export const SPLASH_FALLBACK_MS = 12_000
/** How long the page's outro animation may play before we close it. */
const SPLASH_OUTRO_MS = 1_400

/** Packaged builds get the page via extraResources; dev reads it in place. */
function splashIndexPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'splash', 'index.html')
    : join(import.meta.dirname, '../../resources/splash/index.html')
}

export function createSplashWindow(): BrowserWindow {
  const splash = new BrowserWindow({
    width: 760,
    height: 560,
    frame: false,
    resizable: false,
    movable: false,
    center: true,
    alwaysOnTop: true,
    show: true,
    backgroundColor: '#070709',
    title: 'Ari',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  })
  splash.setMenuBarVisibility(false)
  void splash.loadFile(splashIndexPath())
  return splash
}

/**
 * Signals the page to play its outro and closes it once the animation is
 * done. Idempotent; a destroyed splash is a no-op.
 */
export function finishSplash(splash: BrowserWindow | null): BrowserWindow | null {
  if (splash === null || splash.isDestroyed()) return null
  splash.webContents.executeJavaScript('window.finishAriSplash && window.finishAriSplash();').catch(
    () => undefined,
  )
  const closing = splash
  setTimeout(() => {
    if (!closing.isDestroyed()) closing.close()
  }, SPLASH_OUTRO_MS)
  return null
}
