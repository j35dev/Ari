import { app, BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isolateDevInstance } from './dev-instance'
import { registerRpc } from './rpc'
import { createTray, type TrayHandle } from './tray'
import { updateTrayStatus } from './tray-status'
import { startAutoUpdater } from './updater'
import { createMainWindow } from './window'
import { isAppUrl, isExternalOpenable } from './external-links'

// The launch animation's signature sound is Web Audio; without this switch
// Chromium blocks it until the first user gesture.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

// Unpackaged `pnpm dev` must take this identity before the lock: Electron keys
// the mutex (and every userData store) off app name. Installed Ari stays on
// its own profile so both can run at once.
isolateDevInstance(app)

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  let mainWindow: BrowserWindow | null = null
  let tray: TrayHandle | null = null

  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  void app.whenReady().then(() => {
    if (mainWindow) return
    // One window owns the whole startup: it stays hidden until the renderer has
    // painted its first frame, which is the launch animation itself, so there
    // is never a separate splash surface to hand over from.
    mainWindow = createMainWindow()
    mainWindow.once('ready-to-show', () => {
      startAutoUpdater()
    })
    tray = createTray(() => {
      if (!mainWindow || mainWindow.isDestroyed()) mainWindow = createMainWindow()
      mainWindow.show()
      mainWindow.focus()
    })
    // Handlers register synchronously; driver detection hydrates in background.
    // Turn lifecycle events flow into the tray tooltip as the running count.
    registerRpc(mainWindow.webContents, {
      onRunningCount: (count) => updateTrayStatus(tray, count),
    })

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        mainWindow = createMainWindow()
        registerRpc(mainWindow.webContents)
      }
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('web-contents-created', (_event, contents) => {
    // Popups (window.open / target=_blank) open in the OS browser.
    contents.setWindowOpenHandler(({ url }) => {
      if (isExternalOpenable(url)) void shell.openExternal(url)
      return { action: 'deny' }
    })
    // Same-window clicks (bare <a href> from transcript markdown) never
    // navigate the ADE: the app entry stays, everything openable goes to the
    // OS browser, everything else is dropped. Only the packaged renderer's
    // own entry file counts as the app — never an arbitrary file:/data: URL.
    const devServerUrl = process.env['ELECTRON_RENDERER_URL']
    const appFileUrl = devServerUrl
      ? undefined
      : pathToFileURL(join(import.meta.dirname, '../renderer/index.html')).href
    const guardNavigation = (_navEvent: { preventDefault(): void }, url: string): void => {
      if (isAppUrl(url, devServerUrl, appFileUrl)) return
      _navEvent.preventDefault()
      if (isExternalOpenable(url)) void shell.openExternal(url)
    }
    contents.on('will-navigate', guardNavigation)
    contents.on('will-redirect', guardNavigation)
  })
}
