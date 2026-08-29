import { useEffect, useRef, useState } from 'react'
import { playAwakenSound } from './awaken-sound'
import './awaken-splash.css'

/**
 * The "Ari awakens" launch moment (M27.1). It lives inside the app window —
 * same size, same surface — and covers the shell while the engine comes up,
 * then wipes away to reveal it. There is no second window: the animation is
 * the app's own first frame.
 *
 * Handover rules:
 *  - the sequence gets `MIN_MS` to play out, so a fast boot never truncates it
 *  - once the engine is ready and that floor has passed, the outro runs and
 *    `onDone` fires, at which point the parent drops the splash
 *  - `MAX_MS` is a hard ceiling: a wedged boot can never trap the user behind
 *    the animation (the old splash window had the same guarantee at 12s)
 */

/** Long enough for the caption beat (2.10s + 0.6s) to land. */
export const AWAKEN_MIN_MS = 2_800
/** How long the outro (logo swell + veil wipe) plays before handover. */
export const AWAKEN_OUTRO_MS = 640
/** Ceiling on the whole moment, ready or not. */
export const AWAKEN_MAX_MS = 12_000

export interface AwakenSplashProps {
  /** True once the engine connection is live. */
  ready: boolean
  /** Called after the outro; the parent then unmounts the splash. */
  onDone: () => void
}

export function AwakenSplash({ ready, onDone }: AwakenSplashProps) {
  const [outro, setOutro] = useState(false)
  const [floorPassed, setFloorPassed] = useState(false)
  const [expired, setExpired] = useState(false)
  const doneRef = useRef(false)

  useEffect(() => playAwakenSound(), [])

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
      role="img"
      aria-label="Ari is starting"
    >
      <div className="ari-awaken-grain" aria-hidden="true" />
      <div className="ari-awaken-bloom" aria-hidden="true" />

      <div className="ari-awaken-spark-wrap" aria-hidden="true">
        <svg className="ari-awaken-spark" viewBox="0 0 40 40">
          <path
            d="M20 0C22 12 28 18 40 20C28 22 22 28 20 40C18 28 12 22 0 20C12 18 18 12 20 0Z"
            fill="var(--ari-awaken-gold)"
          />
        </svg>
      </div>

      <div className="ari-awaken-logo" aria-hidden="true">
        <svg viewBox="0 0 520 520">
          <path
            className="ari-awaken-arc"
            d="M116 284 A146 146 0 1 1 404 284"
            fill="none"
            stroke="var(--ari-awaken-gold)"
            strokeWidth="6"
            strokeLinecap="round"
          />
          <path
            className="ari-awaken-horizon"
            d="M58 322 Q260 224 462 322"
            fill="none"
            stroke="var(--ari-awaken-ink)"
            strokeWidth="14"
            strokeLinecap="round"
          />
          <g className="ari-awaken-a" fill="var(--ari-awaken-ink)">
            <path d="M167 355 L246 112 L276 112 L353 355 L315 355 L295 288 L227 288 L207 355 Z" />
            <path d="M237 254 L285 254 L261 178 Z" fill="var(--ari-awaken-bg)" />
          </g>
          <path
            className="ari-awaken-star"
            d="M355 142C357 158 364 165 380 168C364 171 357 178 355 194C353 178 346 171 330 168C346 165 353 158 355 142Z"
            fill="var(--ari-awaken-gold)"
          />
          <g className="ari-awaken-wordmark" fill="var(--ari-awaken-ink)">
            <text
              x="260"
              y="437"
              textAnchor="middle"
              fontSize="50"
              fontWeight="600"
              letterSpacing="18"
            >
              ARI
            </text>
          </g>
        </svg>
      </div>

      <div className="ari-awaken-caption">Agent Development Environment</div>
      <div className="ari-awaken-veil" aria-hidden="true" />
    </div>
  )
}
