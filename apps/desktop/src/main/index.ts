import { app, type BrowserWindow } from 'electron'
import { createLogger } from '@ari/shared/logger'
import { isolateDevInstance } from './dev-instance'
import { DiscordPresence } from './discord-presence'
import { openSpeechSettings, registerRpc, startAppUpdateChecks } from './rpc'
import { AriaWidget } from './aria-widget'
import { MainWindowLifecycle } from './aria-widget/main-window'
import { afterFirstPaint } from './startup-gate'
import { getSettingsStore } from './store'
import { createTray, type TrayHandle } from './tray'
import { updateTrayStatus } from './tray-status'
import { createMainWindow } from './window'

const log = createLogger('desktop:main')

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
  let mainWindows: MainWindowLifecycle<BrowserWindow> | null = null
  let tray: TrayHandle | null = null
  let widget: AriaWidget | null = null
  const presence = new DiscordPresence()

  app.on('second-instance', () => {
    mainWindows?.show()
  })

  void app.whenReady().then(() => {
    if (mainWindows) return
    // One window owns the whole startup: it stays hidden until the renderer has
    // painted its first frame, which is the launch animation itself, so there
    // is never a separate splash surface to hand over from.
    mainWindows = new MainWindowLifecycle(createMainWindow, (window) => {
      const firstPaint = afterFirstPaint(window)
      window.once('ready-to-show', startAppUpdateChecks)
      const handle = registerRpc(window.webContents, {
        onRunningCount: (count) => {
          updateTrayStatus(tray, count)
          presence.setRunningCount(count)
        },
        onSettingsChanged: (settings) => {
          presence.setEnabled(settings.notifications.discordPresence)
          void widget?.configure(settings)
        },
        backgroundReady: firstPaint,
      })
      widget?.close()
      const currentWidget = new AriaWidget({
        invoke: handle.invoke,
        openSettings: () => {
          if (mainWindows) openSpeechSettings(mainWindows.ensure().webContents)
        },
      })
      widget = currentWidget
      // Preserve close behavior; every tray/dock reopen binds a fresh widget and RPC.
      window.once('closed', () => {
        currentWidget.close()
        if (widget === currentWidget) widget = null
      })
      void currentWidget.configure(getSettingsStore().current)
    })
    mainWindows.ensure()
    tray = createTray(() => mainWindows?.show())
    void getSettingsStore()
      .load()
      .catch((error: unknown) => log.warn('settings load failed', { error }))
      .then(() => {
        presence.setEnabled(getSettingsStore().current.notifications.discordPresence)
        return widget?.configure(getSettingsStore().current)
      })

    app.on('activate', () => {
      mainWindows?.show()
    })
  })

  app.on('before-quit', () => widget?.close())
  app.on('will-quit', () => presence.stop())

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
