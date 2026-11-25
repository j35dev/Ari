import { crashReporter, dialog } from 'electron'
import { createLogger } from '@ari/shared/logger'
import { triageLog } from './triage/runtime'

const log = createLogger('desktop:crash')
const FLUSH_LIMIT_MS = 2_000

/**
 * Leaves a trace of process-level failures. Native crashes write minidumps to
 * the local `crashDumps` folder and are never uploaded. Uncaught exceptions are
 * logged without changing Electron's own handling; rejections are logged and
 * never take the main process down.
 */
export function installCrashReporting(target: NodeJS.Process = process): void {
  try {
    crashReporter.start({ uploadToServer: false })
  } catch (error) {
    log.warn('local crash dumps are unavailable', { error })
  }
  target.on('uncaughtExceptionMonitor', (error, origin) => {
    log.error('uncaught exception in the main process', { error, origin })
  })
  target.on('unhandledRejection', (reason) => {
    log.error('unhandled promise rejection in the main process', { error: reason })
  })
}

/**
 * Startup cannot continue: record why, then say so in a native dialog. Without
 * one a failed launch just vanished. The caller quits afterwards.
 */
export async function reportStartupFailure(reason: string, error: unknown): Promise<void> {
  log.error(reason, { error })
  let timer: NodeJS.Timeout | undefined
  await Promise.race([
    triageLog()
      .flush()
      .catch(() => undefined),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, FLUSH_LIMIT_MS)
    }),
  ])
  clearTimeout(timer)
  const detail = error instanceof Error ? error.message : String(error)
  dialog.showErrorBox(
    'Ari could not start',
    `${reason}.\n\n${detail}\n\nThe details are saved in Ari's triage log.`,
  )
}
