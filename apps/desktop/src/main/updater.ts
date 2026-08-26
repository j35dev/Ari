import { createRequire } from 'node:module'
import { app } from 'electron'
import { createLogger } from '@ari/shared/logger'
import type { AppUpdater } from 'electron-updater'

const log = createLogger('desktop:updater')

// electron-updater is CommonJS; the main bundle is ESM, so resolve it through
// require instead of a named import (which throws at runtime in Electron).
const nodeRequire = createRequire(import.meta.url)
const { autoUpdater } = nodeRequire('electron-updater') as { autoUpdater: AppUpdater }

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000
const FIRST_CHECK_DELAY_MS = 8_000

/**
 * Auto-update (M14.6): packaged builds check GitHub releases on startup and
 * every six hours, download in the background, and install on quit — the
 * user never blocks on an update. Dev runs and update failures are silent:
 * a flaky network must never surface as an app error. Note macOS auto-update
 * only works for signed builds; unsigned mac installs stay on manual updates.
 */
export function startAutoUpdater(): void {
  if (!app.isPackaged) return
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.on('update-downloaded', () => {
    log.info('update downloaded; installs on next restart')
  })
  const check = (): void => {
    void autoUpdater.checkForUpdates().catch((cause: unknown) => {
      log.warn('auto-update check failed', {
        error: cause instanceof Error ? cause.message : String(cause),
      })
    })
  }
  setTimeout(check, FIRST_CHECK_DELAY_MS)
  setInterval(check, CHECK_INTERVAL_MS)
}
