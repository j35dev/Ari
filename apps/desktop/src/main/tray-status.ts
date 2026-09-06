import { PACKAGED_APP_NAME } from './dev-instance'

/**
 * Tray status copy + plumbing, free of Electron imports so the logic stays
 * unit-testable headless. tray.ts provides the real sink.
 */

/** Human-readable tray summary: idle, or the live count of mid-turn turns. */
export function trayTooltip(runningCount: number, productName = PACKAGED_APP_NAME): string {
  return runningCount > 0 ? `${productName} — ${runningCount} running` : `${productName} — idle`
}

export interface TrayStatusSink {
  /** Refreshes the tooltip (+ any status label) from the running count. */
  setStatus(runningCount: number): void
}

export function updateTrayStatus(tray: TrayStatusSink | null, runningCount: number): void {
  tray?.setStatus(runningCount)
}
