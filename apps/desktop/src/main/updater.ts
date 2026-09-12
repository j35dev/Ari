import { createRequire } from 'node:module'
import { app } from 'electron'
import type { AppUpdateFrame } from '@ari/contracts/rpc'
import type { AppUpdater } from 'electron-updater'
import {
  createUpdateController,
  type UpdateController,
  type UpdateHandlers,
  type UpdatePort,
} from './update-controller'

// electron-updater is CommonJS; the main bundle is ESM, so resolve it through
// require instead of a named import (which throws at runtime in Electron).
const nodeRequire = createRequire(import.meta.url)
const { autoUpdater } = nodeRequire('electron-updater') as { autoUpdater: AppUpdater }

/**
 * Wires the controller's handlers onto electron-updater. Each handler binds to
 * its own event, so electron-updater's payload types (`UpdateInfo`,
 * `ProgressInfo`) are unwrapped here and nothing downstream sees them.
 */
function createElectronPort(handlers: UpdateHandlers): UpdatePort {
  autoUpdater.on('checking-for-update', () => handlers.checkingForUpdate())
  autoUpdater.on('update-available', (info) => handlers.available(info.version))
  autoUpdater.on('update-not-available', () => handlers.notAvailable())
  autoUpdater.on('download-progress', (progress) => handlers.progress(progress.percent))
  autoUpdater.on('update-downloaded', (info) => handlers.downloaded(info.version))
  autoUpdater.on('error', (error) => handlers.error(error.message))

  return {
    currentVersion: () => app.getVersion(),
    checkForUpdates: () => autoUpdater.checkForUpdates(),
    downloadUpdate: () => autoUpdater.downloadUpdate(),
    quitAndInstall: () => autoUpdater.quitAndInstall(),
    setAutoDownload: (enabled) => {
      autoUpdater.autoDownload = enabled
    },
    setInstallOnQuit: (enabled) => {
      autoUpdater.autoInstallOnAppQuit = enabled
    },
  }
}

/**
 * The update controller for this process. Dev runs get a disabled controller
 * rather than none, so Settings can explain why no updates are offered. Note
 * macOS auto-update only works for signed builds; unsigned mac installs stay
 * on manual updates.
 */
export function createAppUpdater(publish: (frame: AppUpdateFrame) => void): UpdateController {
  return createUpdateController({
    createPort: createElectronPort,
    publish,
    enabled: app.isPackaged,
  })
}
