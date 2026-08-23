import { app, BrowserWindow, shell } from 'electron'
import { registerRpc } from './rpc'
import { createTray, type TrayHandle } from './tray'
import { updateTrayStatus } from './tray-status'
import { createMainWindow } from './window'

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
    mainWindow = createMainWindow()
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
