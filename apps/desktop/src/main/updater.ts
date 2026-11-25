import { createRequire } from 'node:module'
import { app, shell } from 'electron'
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

/** Where a release's installers live; matches `publish` in electron-builder.yml. */
export function releasePage(version: string): string {
  return `https://github.com/j35dev/Ari/releases/tag/v${version}`
}

/**
 * The update controller for this process. Dev runs get a disabled controller
 * rather than none, so Settings can explain why no updates are offered.
 * macOS builds are ad-hoc signed, and Squirrel.Mac only installs an update
 * signed by a Developer ID, so on macOS an update is offered as a link to
 * its GitHub release rather than downloaded and then refused.
 */
export function createAppUpdater(publish: (frame: AppUpdateFrame) => void): UpdateController {
  return createUpdateController({
    createPort: createElectronPort,
    publish,
    enabled: app.isPackaged,
    ...(process.platform === 'darwin'
      ? { manualRelease: { pageFor: releasePage, open: (url: string) => shell.openExternal(url) } }
      : {}),
  })
}
