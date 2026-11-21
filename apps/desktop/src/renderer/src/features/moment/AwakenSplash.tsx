import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import {
  ARI_MARK_ANGLE,
  ARI_MARK_CAP_RIGHT,
  ARI_MARK_FOLD_PATH,
  ARI_MARK_PATH,
  ARI_MARK_VIEWBOX,
} from '@ari/ui/brand/ari-mark'
import './awaken-splash.css'

/**
 * The launch screen. It lives inside the app window and covers the shell
 * while the engine comes up, then fades away to reveal it.
 *
 * The mark draws itself: the left leg sweeps up from its foot into the cap,
 * then the right leg folds down from under the cap. The wordmark settles
 * beneath it in a faint glow, and a hairline shimmers until the engine is
 * ready. Every moving part animates only transform and opacity, so the motion
 * stays on the compositor while the shell mounts underneath and keeps the
 * main thread busy; a main-thread animation would skip straight to its end.
 *
 *  - `AWAKEN_MIN_MS` lets the whole mark land before a fast boot hands over
 *  - once the engine is ready and that floor has passed, the outro runs and
 *    `onDone` fires, at which point the parent drops the screen
 *  - `AWAKEN_MAX_MS` is a hard ceiling, so a wedged boot cannot trap the user
 */

/** Long enough to see the mark draw and the wordmark land. */
export const AWAKEN_MIN_MS = 1_400
/** How long the hand-over plays before the app takes over. */
export const AWAKEN_OUTRO_MS = 450
/** Ceiling on the whole screen, ready or not. */
export const AWAKEN_MAX_MS = 12_000

/** On-screen width of the mark, in px. */
const MARK_WIDTH = 148
const MARK_HEIGHT = (MARK_WIDTH * ARI_MARK_VIEWBOX.height) / ARI_MARK_VIEWBOX.width
const VIEWBOX = `0 0 ${ARI_MARK_VIEWBOX.width} ${ARI_MARK_VIEWBOX.height}`

export interface AwakenSplashProps {
  /** True once the engine connection is live. */
  ready: boolean
  /** Called after the outro; the parent then unmounts the screen. */
  onDone: () => void
}

/**
 * A wipe along one leg: a window rotated onto the leg's axis slides open from
 * `pivot` while its content slides the other way, so the face appears to be
 * drawn in place. Both moves are transforms.
 */
function Wipe({
  face,
  pivot,
  angle,
  length,
  children,
}: {
  face: 'front' | 'back'
  pivot: [number, number]
  angle: number
  length: number
  children: ReactNode
}) {
  const style = {
    left: pivot[0],
    top: pivot[1],
    '--ari-awaken-angle': `${angle}deg`,
    '--ari-awaken-len': `${length}px`,
  } as CSSProperties
  return (
    <div className="ari-awaken-wipe" data-face={face} style={style}>
      <div className="ari-awaken-wipe-window">
        <div className="ari-awaken-wipe-content">
          <svg
            viewBox={VIEWBOX}
            width={MARK_WIDTH}
            height={MARK_HEIGHT}
            style={{ position: 'absolute', left: -pivot[0], top: -pivot[1] }}
          >
            {children}
          </svg>
        </div>
      </div>
    </div>
  )
}

function AwakenMark() {
  const id = useId().replace(/:/g, '')
  const clip = `ari-awaken-clip-${id}`
  // The front face is everything outside the tucked leg.
  const front = `M-50 -50 H150 V150 H-50 Z ${ARI_MARK_FOLD_PATH}`
  const capRight = (ARI_MARK_CAP_RIGHT / ARI_MARK_VIEWBOX.width) * MARK_WIDTH
  return (
    <div className="ari-awaken-mark" style={{ width: MARK_WIDTH, height: MARK_HEIGHT }}>
      <Wipe face="back" pivot={[capRight, 0]} angle={ARI_MARK_ANGLE} length={MARK_HEIGHT * 1.36}>
        <defs>
          <clipPath id={`${clip}-b`}>
            <path d={ARI_MARK_PATH} />
          </clipPath>
        </defs>
        <path d={ARI_MARK_FOLD_PATH} className="ari-awaken-fold" clipPath={`url(#${clip}-b)`} />
      </Wipe>
      <Wipe
        face="front"
        pivot={[0, MARK_HEIGHT]}
        angle={-ARI_MARK_ANGLE}
        length={MARK_HEIGHT * 1.5}
      >
        <defs>
          <clipPath id={`${clip}-f`}>
            <path d={ARI_MARK_PATH} />
          </clipPath>
        </defs>
        <path
          d={front}
          fillRule="evenodd"
          className="ari-awaken-face"
          clipPath={`url(#${clip}-f)`}
        />
      </Wipe>
    </div>
  )
}

export function AwakenSplash({ ready, onDone }: AwakenSplashProps) {
  const [outro, setOutro] = useState(false)
  const [floorPassed, setFloorPassed] = useState(false)
  const [expired, setExpired] = useState(false)
  const [play, setPlay] = useState(false)
  const onDoneRef = useRef(onDone)

  useEffect(() => {
    onDoneRef.current = onDone
  }, [onDone])

  useEffect(() => {
    const floor = setTimeout(() => setFloorPassed(true), AWAKEN_MIN_MS)
    const ceiling = setTimeout(() => setExpired(true), AWAKEN_MAX_MS)
    // Start the motion on the first painted frame, not at mount: the window
    // is revealed on that frame, so nothing plays before it can be seen.
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => setPlay(true))
    })
    return () => {
      clearTimeout(floor)
      clearTimeout(ceiling)
      cancelAnimationFrame(frame)
    }
  }, [])

  useEffect(() => {
    if (expired || (ready && floorPassed)) setOutro(true)
  }, [ready, floorPassed, expired])

  // Once the fade starts, boot updates must not cancel or restart its handover.
  useEffect(() => {
    if (!outro) return
    const handover = setTimeout(() => onDoneRef.current(), AWAKEN_OUTRO_MS)
    return () => clearTimeout(handover)
  }, [outro])

  return (
    <div
      className="ari-awaken"
      data-testid="awaken-splash"
      data-outro={outro ? 'on' : 'off'}
      data-ready={ready ? 'on' : 'off'}
      data-play={play ? 'on' : 'off'}
      role="img"
      aria-label="Ari is starting"
    >
      <div className="ari-awaken-glow" aria-hidden="true" />
      <div className="ari-awaken-center">
        <AwakenMark />
        <div className="ari-awaken-word" data-testid="awaken-word">
          ari
        </div>
        <div className="ari-awaken-line" aria-hidden="true">
          <span className="ari-awaken-line-fill" />
        </div>
        <span className="sr-only">{ready ? 'ready' : 'starting'}</span>
      </div>
    </div>
  )
}
