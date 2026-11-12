import { app, powerMonitor } from 'electron'
import type { BrowserWindow } from 'electron'
import { createLogger } from '@ari/shared/logger'
import { isolateDevInstance } from './dev-instance'
import { DiscordPresence } from './discord-presence'
import { openSpeechSettings, registerRpc, startAppUpdateChecks } from './rpc'
import { AriaWidget } from './aria-widget'
import type { EngineHandle } from './rpc'
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
  let mainWindow: BrowserWindow | null = null
  let tray: TrayHandle | null = null
  let widget: AriaWidget | null = null
  let runtime: EngineHandle | null = null
  let quitting = false
  let shutdownStarted = false
  let shutdownComplete = false
  let backgrounded = false
  const presence = new DiscordPresence()

  const showMainWindow = (): void => {
    if (quitting || !mainWindow || mainWindow.isDestroyed()) return
    backgrounded = false
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  }
  const refreshTray = (update: (handle: TrayHandle) => void): void => {
    if (!tray) return
    try {
      if (tray.isDestroyed()) throw new Error('system tray was destroyed')
      update(tray)
    } catch (error) {
      log.warn('system tray unavailable; revealing Ari', { error })
      try {
        tray.destroy()
      } catch {
        /* already gone */
      }
      tray = null
      showMainWindow()
    }
  }

  app.on('second-instance', showMainWindow)
  app.on('activate', showMainWindow)
  app.on('before-quit', (event) => {
    quitting = true
    widget?.close()
    if (!runtime || shutdownComplete) return
    event.preventDefault()
    if (shutdownStarted) return
    shutdownStarted = true
    // Give providers and listeners time to close, but never make Quit wait
    // forever for an unresponsive provider. OS shutdown is not vetoed below.
    const deadline = setTimeout(() => {
      log.warn('shutdown deadline reached')
      app.exit(0)
    }, 5_000)
    void runtime
      .shutdown()
      .catch((error: unknown) => log.warn('shutdown failed', { error }))
      .finally(() => {
        clearTimeout(deadline)
        shutdownComplete = true
        app.quit()
      })
  })

  void app
    .whenReady()
    .then(() => {
      if (mainWindow || quitting) return
      // One window owns the whole startup: it stays hidden until the renderer has
      // painted its first frame, which is the launch animation itself, so there
      // is never a separate splash surface to hand over from.
      mainWindow = createMainWindow()
      const window = mainWindow
      window.on('close', (event) => {
        if (quitting) return
        event.preventDefault()
        refreshTray(() => undefined)
        if (tray) {
          // Keep the one runtime-owning webContents, including idle drafts and
          // subscriptions. Recreating it would require rebuilding the runtime.
          backgrounded = true
          window.hide()
        } else {
          app.quit()
        }
      })
      window.on('hide', () => refreshTray((handle) => handle.setBackgrounded(true)))
      window.on('show', () => {
        backgrounded = false
        refreshTray((handle) => handle.setBackgrounded(false))
      })
      window.webContents.once('destroyed', () => {
        if (!quitting) app.quit()
      })
      window.webContents.on('render-process-gone', (_event, details) => {
        if (quitting) return
        log.warn('renderer exited; revealing and reloading Ari', { reason: details.reason })
        showMainWindow()
        window.webContents.reload()
      })
      window.webContents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
        if (!isMainFrame || code === -3 || quitting) return
        log.error('main window failed to load', { code, description })
        app.quit()
      })
      // Electron does not emit before-quit for Windows session termination.
      // Do not prevent these events; start the same cleanup explicitly.
      window.on('query-session-end', () => app.quit())
      window.on('session-end', () => app.quit())
      powerMonitor.on('shutdown', () => app.quit())
      const firstPaint = afterFirstPaint(mainWindow)
      void firstPaint.then(() => {
        // The existing startup gate has a fallback for a renderer that never
        // reports its first frame. Keep even a trayless startup recoverable.
        if (!backgrounded && !quitting && !window.isDestroyed() && !window.isVisible())
          window.show()
      })
      mainWindow.once('ready-to-show', () => {
        if (quitting) return
        if (!backgrounded) window.show()
        startAppUpdateChecks()
      })
      try {
        tray = createTray(showMainWindow)
      } catch (error) {
        // A tray failure must not abort RPC startup or leave a hidden process.
        // Without a tray, Close follows the ordinary quit path on every OS.
        log.warn('system tray failed to start; Close will quit Ari', { error })
      }
      // Handlers register synchronously; driver detection hydrates in background.
      // Turn lifecycle events flow into the tray tooltip and the Discord status as the running count.
      runtime = registerRpc(mainWindow.webContents, {
        onRunningCount: (count) => {
          refreshTray((handle) => updateTrayStatus(handle, count))
          presence.setRunningCount(count)
        },
        onSettingsChanged: (settings) => {
          presence.setEnabled(settings.notifications.discordPresence)
          void widget?.configure(settings)
        },
        backgroundReady: firstPaint,
      })
      widget = new AriaWidget({
        voice: {
          stop: () => {
            void runtime!.invoke('aria.voice.stop').catch(() => undefined)
          },
          warm: () => {
            void runtime!.invoke('aria.voice.warm').catch(() => undefined)
          },
          arm: (sessionId, text) => runtime!.invoke('aria.voice.arm', { sessionId, text }),
        },
        mainWindow: () => mainWindow,
        invoke: runtime.invoke,
        openSettings: () => {
          if (mainWindow && !mainWindow.isDestroyed()) openSpeechSettings(mainWindow.webContents)
        },
      })
      void widget.configure(getSettingsStore().current)
      void getSettingsStore()
        .load()
        .catch((error: unknown) => log.warn('settings load failed', { error }))
        .then(() => {
          if (!quitting) {
            presence.setEnabled(getSettingsStore().current.notifications.discordPresence)
            void widget?.configure(getSettingsStore().current)
          }
        })
    })
    .catch((error: unknown) => {
      log.error('desktop startup failed', { error })
      app.quit()
    })

  app.on('will-quit', () => {
    presence.stop()
    tray?.destroy()
    tray = null
  })

  app.on('window-all-closed', () => {
    if (!quitting) app.quit()
  })
}
