import type { AppUpdateFrame, UpdateStart } from '@ari/contracts/rpc'
import { createLogger } from '@ari/shared/logger'

const log = createLogger('desktop:update-controller')

const FIRST_CHECK_DELAY_MS = 8_000
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

const DISABLED_REASON = 'Updates are only available in installed builds.'

/**
 * Every lifecycle signal, wired in one call. electron-updater has no
 * subscribe-once API, so taking the whole set lets the adapter register each
 * handler against its own event and keep every payload's type end to end.
 */
export interface UpdateHandlers {
  checkingForUpdate(): void
  /** Version string of the release found. */
  available(version: string): void
  notAvailable(): void
  /** Download completion, 0–100. */
  progress(percent: number): void
  /** Version string of the release now staged on disk. */
  downloaded(version: string): void
  error(message: string): void
}

/** The slice of electron-updater the controller drives. */
export interface UpdatePort {
  currentVersion(): string
  checkForUpdates(): Promise<unknown>
  downloadUpdate(): Promise<unknown>
  quitAndInstall(): void
  /** electron-updater downloads as part of a check when this is on; Ari keeps it off. */
  setAutoDownload(enabled: boolean): void
  setInstallOnQuit(enabled: boolean): void
}

export interface UpdateController {
  /** Wire the check schedule. Idempotent, and a no-op on disabled builds. */
  start(): void
  check(manual: boolean): UpdateStart
  download(): UpdateStart
  install(): UpdateStart
  /** Frames a late subscriber needs to rebuild current state; often empty. */
  snapshot(): AppUpdateFrame[]
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/**
 * Owns Ari's update lifecycle (M14.6). Unlike a stock electron-updater setup
 * this never downloads unbidden: a check only announces what exists, and
 * bytes move when the user asks. Background failures stay in the log — a
 * flaky network must not surface as an app error — while failures the user
 * actually initiated (manual check, in-flight download) are published so the
 * UI can explain itself.
 *
 * Auto-install-on-quit stays on: a release the user downloaded but never
 * restarted into still lands on the next normal quit.
 */
export function createUpdateController(config: {
  /** Receives the controller's handlers and returns the wired port. */
  createPort: (handlers: UpdateHandlers) => UpdatePort
  publish: (frame: AppUpdateFrame) => void
  enabled: boolean
  firstCheckDelayMs?: number
  checkIntervalMs?: number
}): UpdateController {
  const { publish, enabled } = config
  const firstCheckDelayMs = config.firstCheckDelayMs ?? FIRST_CHECK_DELAY_MS
  const checkIntervalMs = config.checkIntervalMs ?? CHECK_INTERVAL_MS

  /** Announced by the last check, not yet downloaded. */
  let available: string | null = null
  /** Downloaded and waiting for `install`. */
  let staged: string | null = null
  let checking = false
  let downloading = false
  /** True while the in-flight check is one the user asked for. */
  let manualCheck = false
  let scheduled = false

  const fail = (message: string, silent: boolean): void => {
    checking = false
    downloading = false
    manualCheck = false
    log.warn('update failed', { error: message, silent })
    if (!silent) publish({ type: 'error', message })
  }

  const port = config.createPort({
    checkingForUpdate: () => {
      checking = true
    },
    available: (version) => {
      checking = false
      // A check landing mid-download must not offer a second release.
      if (downloading) return
      // electron-updater compares against the *running* build, so a check
      // after a download still reports the staged release as available. Keep
      // it staged rather than offering a second copy of the same version.
      if (staged === version) return
      available = version
      staged = null
      publish({ type: 'available', version, currentVersion: port.currentVersion() })
    },
    notAvailable: () => {
      checking = false
      available = null
      publish({ type: 'none', at: Date.now() })
    },
    progress: (percent) => {
      publish({ type: 'download.progress', percent: Math.round(percent) })
    },
    downloaded: (version) => {
      checking = false
      downloading = false
      available = null
      staged = version
      publish({ type: 'downloaded', version })
    },
    error: (message) => {
      fail(message, !(downloading || manualCheck))
    },
  })

  port.setAutoDownload(false)
  port.setInstallOnQuit(true)

  const check = (manual: boolean): UpdateStart => {
    if (!enabled) return { started: false, reason: DISABLED_REASON }
    if (downloading) return { started: false, reason: 'An update is already downloading.' }
    if (checking) return { started: false, reason: 'A check is already running.' }
    checking = true
    manualCheck = manual
    publish({ type: 'checking', manual })
    void port.checkForUpdates().catch((cause: unknown) => fail(describe(cause), !manual))
    return { started: true, reason: null }
  }

  const download = (): UpdateStart => {
    if (!enabled) return { started: false, reason: DISABLED_REASON }
    if (downloading) return { started: false, reason: 'An update is already downloading.' }
    if (staged !== null) {
      return { started: false, reason: `Ari ${staged} is already downloaded.` }
    }
    if (available === null) {
      return { started: false, reason: 'No update is available to download.' }
    }
    const version = available
    downloading = true
    publish({ type: 'download.started', version })
    // `available` survives a failure so the user can retry the download.
    void port.downloadUpdate().catch((cause: unknown) => fail(describe(cause), false))
    return { started: true, reason: null }
  }

  const install = (): UpdateStart => {
    if (!enabled) return { started: false, reason: DISABLED_REASON }
    if (staged === null) {
      return { started: false, reason: 'No update has been downloaded yet.' }
    }
    try {
      port.quitAndInstall()
    } catch (cause: unknown) {
      const message = describe(cause)
      fail(message, false)
      return { started: false, reason: message }
    }
    return { started: true, reason: null }
  }

  const snapshot = (): AppUpdateFrame[] => {
    if (staged !== null) return [{ type: 'downloaded', version: staged }]
    if (available !== null) {
      return [{ type: 'available', version: available, currentVersion: port.currentVersion() }]
    }
    return []
  }

  const start = (): void => {
    if (!enabled || scheduled) return
    scheduled = true
    setTimeout(() => void check(false), firstCheckDelayMs)
    setInterval(() => void check(false), checkIntervalMs)
  }

  return { start, check, download, install, snapshot }
}
