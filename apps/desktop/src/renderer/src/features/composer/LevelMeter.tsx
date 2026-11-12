import './level-meter.css'

/** Bars across the meter. At 3px wide with 2px gaps the row is 158px. */
export const LEVEL_BARS = 32

/** Tallest bar, in cells. A cell is 3px lit plus a 1px gap, so five is 19px. */
const MAX_CELLS = 5

/** The recorder reports quiet speech well under 1; lift it into the meter's range. */
const GAIN = 3

/** How many recorder ticks one bar spans when the user asked for less motion. */
export const REDUCED_MOTION_STRIDE = 4

/** Whole cells (1 to {@link MAX_CELLS}) for one input level in [0, 1]. */
export function levelCells(level: number): number {
  const scaled = Math.min(1, Math.max(0, level) * GAIN)
  return Math.max(1, Math.round(scaled * MAX_CELLS))
}

/** Appends one bar to the rolling history, newest last, dropping the oldest. */
export function pushCells(history: readonly number[], cells: number): number[] {
  const kept =
    history.length >= LEVEL_BARS ? history.slice(history.length - LEVEL_BARS + 1) : history
  return [...kept, cells]
}

/** True when the app setting or the OS asks for reduced motion. */
export function prefersReducedMotion(): boolean {
  if (typeof document === 'undefined') return false
  const root = document.documentElement
  if (root.hasAttribute('data-ari-reduced-motion') || root.dataset['reducedMotion'] === 'true') {
    return true
  }
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
}

/**
 * Recent microphone levels as a row of pixel bars, newest at the right. Bars
 * the history has not reached yet rest at one cell, so the row never changes
 * width while it fills. `bars` shortens the row (the widget's pill); `label`
 * names it for assistive tech, and without one the meter is decoration.
 */
export function LevelMeter({
  cells,
  bars = LEVEL_BARS,
  label,
}: {
  cells: readonly number[]
  bars?: number
  label?: string
}) {
  const recent = cells.slice(-bars)
  const lead = bars - recent.length
  return (
    <span
      className="ari-levels"
      role={label === undefined ? undefined : 'img'}
      aria-label={label}
      aria-hidden={label === undefined ? true : undefined}
    >
      {Array.from({ length: bars }, (_, index) => {
        const height = (index < lead ? 1 : (recent[index - lead] ?? 1)) * 4 - 1
        return <i key={index} style={{ height: `${height}px` }} />
      })}
    </span>
  )
}
