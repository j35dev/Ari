import { useEffect, useRef, useState } from 'react'
import './awaken-splash.css'

/**
 * The launch screen. It lives inside the app window and covers the shell
 * while the engine comes up, then fades away to reveal it.
 *
 * The wordmark rises in, its dot warms to the accent, and a hairline under it
 * shimmers until the engine is ready, then fills. It is meant to be brief:
 *  - `AWAKEN_MIN_MS` keeps a fast boot from flashing the screen for one frame
 *  - once the engine is ready and that floor has passed, the outro runs and
 *    `onDone` fires, at which point the parent drops the screen
 *  - `AWAKEN_MAX_MS` is a hard ceiling, so a wedged boot cannot trap the user
 */

/** Just long enough for the wordmark to land; a fast boot is not held back further. */
export const AWAKEN_MIN_MS = 900
/** How long the hand-over fade plays before the app takes over. */
export const AWAKEN_OUTRO_MS = 360
/** Ceiling on the whole screen, ready or not. */
export const AWAKEN_MAX_MS = 12_000

export interface AwakenSplashProps {
  /** True once the engine connection is live. */
  ready: boolean
  /** Called after the outro; the parent then unmounts the screen. */
  onDone: () => void
}

export function AwakenSplash({ ready, onDone }: AwakenSplashProps) {
  const [outro, setOutro] = useState(false)
  const [floorPassed, setFloorPassed] = useState(false)
  const [expired, setExpired] = useState(false)
  const doneRef = useRef(false)

  useEffect(() => {
    const floor = setTimeout(() => setFloorPassed(true), AWAKEN_MIN_MS)
    const ceiling = setTimeout(() => setExpired(true), AWAKEN_MAX_MS)
    return () => {
      clearTimeout(floor)
      clearTimeout(ceiling)
    }
  }, [])

  useEffect(() => {
    if (doneRef.current) return
    if (!expired && !(ready && floorPassed)) return
    doneRef.current = true
    setOutro(true)
    const handover = setTimeout(onDone, AWAKEN_OUTRO_MS)
    return () => clearTimeout(handover)
  }, [ready, floorPassed, expired, onDone])

  return (
    <div
      className="ari-awaken"
      data-testid="awaken-splash"
      data-outro={outro ? 'on' : 'off'}
      data-ready={ready ? 'on' : 'off'}
      role="img"
      aria-label="Ari is starting"
    >
      <div className="ari-awaken-glow" aria-hidden="true" />
      <div className="ari-awaken-center">
        <div className="ari-awaken-word" data-testid="awaken-word">
          Ari<span className="ari-awaken-dot">.</span>
        </div>
        <div className="ari-awaken-line" aria-hidden="true">
          <span className="ari-awaken-line-fill" />
        </div>
        <div className="ari-awaken-status">{ready ? 'ready' : 'starting'}</div>
      </div>
    </div>
  )
}
