import { app, BrowserWindow, shell } from 'electron'
import { registerRpc } from './rpc'
import { createSplashWindow, finishSplash, SPLASH_FALLBACK_MS } from './splash'
import { createTray, type TrayHandle } from './tray'
import { updateTrayStatus } from './tray-status'
import { startAutoUpdater } from './updater'
import { createMainWindow } from './window'

// The splash's synthesized signature sound is Web Audio; without this switch
// Chromium blocks it until the first user gesture.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

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
    // The splash owns the screen while drivers detect and the renderer loads;
    // the main window is created immediately but stays hidden until ready.
    let splash: BrowserWindow | null = createSplashWindow()
    const splashFallback = setTimeout(() => {
      splash = finishSplash(splash)
    }, SPLASH_FALLBACK_MS)

    mainWindow = createMainWindow()
    mainWindow.webContents.once('did-finish-load', () => {
      clearTimeout(splashFallback)
      splash = finishSplash(splash)
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
    contents.setWindowOpenHandler(({ url }) => {
      void shell.openExternal(url)
      return { action: 'deny' }
    })
  })
}
