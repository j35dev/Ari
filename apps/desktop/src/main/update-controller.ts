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
 *
 * The retained state above is only ever published through frames, so every
 * check has to end on one: a check nobody asked for never announces itself,
 * and either outcome re-announces the staged release while one is on disk.
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
  /** Version moving over the wire right now, so a late subscriber can be told. */
  let downloadVersion: string | null = null
  /** Latest whole-percent progress of that download, or null before any event. */
  let downloadPercent: number | null = null
  /** True while the in-flight check is one the user asked for. */
  let manualCheck = false
  let scheduled = false

  const fail = (message: string, silent: boolean): void => {
    checking = false
    downloading = false
    manualCheck = false
    downloadVersion = null
    downloadPercent = null
    log.warn('update failed', { error: message, silent })
    if (!silent) publish({ type: 'error', message })
  }

  /**
   * Re-announces the staged release, if one is on disk. Every check outcome
   * while something is staged ends here: that release is what `install` and
   * install-on-quit apply, so subscribers return to 'ready' instead of being
   * left on the check's `checking` frame or told the build is current.
   */
  const reannounceStaged = (): boolean => {
    if (staged === null) return false
    publish({ type: 'downloaded', version: staged })
    return true
  }

  const port = config.createPort({
    checkingForUpdate: () => {
      checking = true
    },
    available: (version) => {
      checking = false
      manualCheck = false
      // A check landing mid-download must not offer a second release.
      if (downloading) return
      // electron-updater compares against the *running* build, so a check
      // after a download still reports the staged release as available. Once
      // a release is staged it is the one `quitAndInstall` and install-on-quit
      // apply, so it stays the standing answer: a newer release found now is
      // offered by the next check, after this one has actually installed,
      // rather than replacing an installer already on disk.
      if (reannounceStaged()) return
      available = version
      publish({ type: 'available', version, currentVersion: port.currentVersion() })
    },
    notAvailable: () => {
      checking = false
      manualCheck = false
      available = null
      // A staged release still installs on quit, so calling the build current
      // here would contradict what happens on the next restart.
      if (reannounceStaged()) return
      publish({ type: 'none', at: Date.now() })
    },
    progress: (percent) => {
      const rounded = Math.round(percent)
      downloadPercent = rounded
      publish({ type: 'download.progress', percent: rounded })
    },
    downloaded: (version) => {
      checking = false
      downloading = false
      available = null
      downloadVersion = null
      downloadPercent = null
      staged = version
      publish({ type: 'downloaded', version })
    },
    error: (message) => {
      fail(message, !(downloading || (checking && manualCheck)))
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
    // Only a check the user asked for announces itself. A background check
    // stays silent by design — above all on failure — so a `checking` frame
    // for one would park the UI on a spinner nothing is coming to clear, and
    // no frame could clear it without either claiming the build is current or
    // breaking that silence.
    if (manual) publish({ type: 'checking', manual })
    void port
      .checkForUpdates()
      .catch((cause: unknown) => fail(describe(cause), !manual))
      .finally(() => {
        // electron-updater can settle without emitting anything at all when
        // the updater is inactive. Left alone that holds `checking` forever,
        // which blocks every later check and keeps a manual check's spinner
        // running — so a check always ends in a terminal outcome.
        if (checking) fail('The update check ended without a result.', !manual)
      })
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
    downloadVersion = version
    downloadPercent = null
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
    // A download in flight outranks `available`, which survives one on purpose
    // so a failure can be retried: a late subscriber re-offered the release
    // would offer a second download that `download` then refuses, and would
    // lose the progress the toast is already showing.
    if (downloading && downloadVersion !== null) {
      const frames: AppUpdateFrame[] = [
        { type: 'download.started', version: downloadVersion },
      ]
      if (downloadPercent !== null) {
        frames.push({ type: 'download.progress', percent: downloadPercent })
      }
      return frames
    }
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
