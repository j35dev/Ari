import { app, BrowserWindow } from 'electron'
import { isolateDevInstance } from './dev-instance'
import { registerRpc, startAppUpdateChecks } from './rpc'
import { createTray, type TrayHandle } from './tray'
import { updateTrayStatus } from './tray-status'
import { createMainWindow } from './window'

// The launch animation's signature sound is Web Audio; without this switch
// Chromium blocks it until the first user gesture.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
// Google properties (YouTube) often fail with net::ERR_FAILED under HTTP/3 in Electron.
app.commandLine.appendSwitch('disable-quic')

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
      startAppUpdateChecks()
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
}
