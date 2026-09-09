import { useEffect, useMemo, useRef, useState } from 'react'
import { playAwakenSound } from './awaken-sound'
import './awaken-splash.css'

/**
 * The "Ari awakens" launch moment. It lives inside the app window — same
 * size, same surface — and covers the shell while the engine comes up, then
 * wipes away to reveal it. There is no second window: the animation is the
 * app's own first frame.
 *
 * Choreography is a glitch reveal: scattered corruption fragments, a
 * mono corrupt flash with RGB-split ghosts and glitch bands, a scanline
 * flash, then the wordmark settling with a cinematic impact and a `ready`
 * beat.
 *
 * Handover rules:
 *  - the sequence gets `MIN_MS` to play out, so a fast boot never truncates it
 *  - once the engine is ready and that floor has passed, the outro runs and
 *    `onDone` fires, at which point the parent drops the splash
 *  - `MAX_MS` is a hard ceiling: a wedged boot can never trap the user behind
 *    the animation (the old splash window had the same guarantee at 12s)
 */

/** Long enough for the reveal (1.16s) + `ready` beat (1.88s) to land. */
export const AWAKEN_MIN_MS = 2_600
/** How long the outro (wordmark swell + veil wipe) plays before handover. */
export const AWAKEN_OUTRO_MS = 640
/** Ceiling on the whole moment, ready or not. */
export const AWAKEN_MAX_MS = 12_000

/** Beats of the reveal timeline, in milliseconds after mount. */
const FRAGMENTS_AT = 330
const CORRUPT_AT = 540
const GHOST_B_AT = 650
const GHOST_C_AT = 790
const FLASHLINE_AT = 940
const REVEAL_AT = 1_160
const READY_AT = 1_880

const FRAGMENT_COUNT = 38
const FRAGMENT_COLORS = [
  'var(--ari-awaken-glitch)',
  'var(--ari-awaken-glitch)',
  'var(--ari-awaken-glitch)',
  'var(--ari-awaken-glitch-cyan)',
  'var(--ari-awaken-glitch-pink)',
  'var(--ari-awaken-glitch-soft)',
]

interface Fragment {
  left: string
  top: string
  width: string
  height: string
  opacity: number
  background: string
}

export interface AwakenSplashProps {
  /** True once the engine connection is live. */
  ready: boolean
  /** Called after the outro; the parent then unmounts the splash. */
  onDone: () => void
}

export function AwakenSplash({ ready, onDone }: AwakenSplashProps) {
  const [beat, setBeat] = useState(0)
  const [outro, setOutro] = useState(false)
  const [floorPassed, setFloorPassed] = useState(false)
  const [expired, setExpired] = useState(false)
  const doneRef = useRef(false)
  const soundDisposeRef = useRef<(() => void) | null>(null)

  const fragments = useMemo<Fragment[]>(
    () =>
      Array.from({ length: FRAGMENT_COUNT }, () => {
        const horizontal = Math.random() > 0.35
        return {
          left: `${5 + Math.random() * 90}%`,
          top: `${8 + Math.random() * 84}%`,
          width: horizontal
            ? `${2 + Math.random() * 18}px`
            : `${2 + Math.random() * 5}px`,
          height: horizontal
            ? `${2 + Math.random() * 4}px`
            : `${2 + Math.random() * 14}px`,
          opacity: 0.22 + Math.random() * 0.65,
          background:
            FRAGMENT_COLORS[Math.floor(Math.random() * FRAGMENT_COLORS.length)] ??
            'var(--ari-awaken-glitch)',
        }
      }),
    [],
  )

  // Reveal timeline: beats flip classes on the mounted layers, so each CSS
  // animation fires exactly once. The impact plays on the reveal beat.
  useEffect(() => {
    const schedule = (at: number, next: number): ReturnType<typeof setTimeout> =>
      setTimeout(() => setBeat(next), at)
    const timers = [
      schedule(FRAGMENTS_AT, 1),
      schedule(CORRUPT_AT, 2),
      schedule(GHOST_B_AT, 3),
      schedule(GHOST_C_AT, 4),
      schedule(FLASHLINE_AT, 5),
      setTimeout(() => {
        setBeat(6)
        soundDisposeRef.current = playAwakenSound()
      }, REVEAL_AT),
      schedule(READY_AT, 7),
    ]
    return () => {
      for (const timer of timers) clearTimeout(timer)
      soundDisposeRef.current?.()
      soundDisposeRef.current = null
    }
  }, [])

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
      <div className="ari-awaken-flashline" data-on={beat >= 5 ? 'on' : 'off'} aria-hidden="true" />

      <div className="ari-awaken-stage" aria-hidden="true">
        <div className="ari-awaken-fragments" data-on={beat >= 1 ? 'on' : 'off'}>
          {fragments.map((fragment, i) => (
            <i
              key={i}
              className="ari-awaken-fragment"
              style={{
                left: fragment.left,
                top: fragment.top,
                width: fragment.width,
                height: fragment.height,
                opacity: fragment.opacity,
                background: fragment.background,
              }}
            />
          ))}
        </div>

        <div className="ari-awaken-band ari-awaken-b1" data-on={beat >= 3 ? 'on' : 'off'} />
        <div className="ari-awaken-band ari-awaken-b2" data-on={beat >= 4 ? 'on' : 'off'} />
        <div className="ari-awaken-band ari-awaken-b3" data-on={beat >= 5 ? 'on' : 'off'} />

        <div className="ari-awaken-wordbox">
          <div className="ari-awaken-ghost ari-awaken-ga" data-on={beat >= 2 ? 'on' : 'off'}>
            Ari.
          </div>
          <div className="ari-awaken-ghost ari-awaken-gb" data-on={beat >= 3 ? 'on' : 'off'}>
            Ari.
          </div>
          <div className="ari-awaken-ghost ari-awaken-gc" data-on={beat >= 4 ? 'on' : 'off'}>
            Ari.
          </div>

          <div className="ari-awaken-corrupt" data-on={beat >= 2 ? 'on' : 'off'}>
            Ari.
          </div>
          <div className="ari-awaken-word" data-on={beat >= 6 ? 'on' : 'off'} data-testid="awaken-word">
            Ari<span className="ari-awaken-dot" data-on={beat >= 6 ? 'on' : 'off'}>.</span>
          </div>
        </div>
      </div>

      <div className="ari-awaken-ready" data-on={beat >= 7 ? 'on' : 'off'}>
        ready
      </div>
      <div className="ari-awaken-veil" aria-hidden="true" />
    </div>
  )
}
