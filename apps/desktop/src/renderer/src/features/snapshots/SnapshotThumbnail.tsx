import { useEffect, useRef } from 'react'
import { useReducedMotionConfig } from 'motion/react'
import { playSnapshotSound, takeSnapshotArrival, snapshotFileId } from './arrival'
import { snapshotFlightFrames, SNAPSHOT_FLIGHT_DURATION } from './snapshot-flight'

/** A single floating image settles into the existing 28px attachment thumbnail. */
export function SnapshotThumbnail({ file, src }: { file: File; src?: string }) {
  const destination = useRef<HTMLImageElement>(null)
  const reducedMotion = useReducedMotionConfig()
  useEffect(() => {
    const target = destination.current
    if (!src || !target) return
    let alive = true
    let overlay: HTMLDivElement | undefined
    let animations: Animation[] = []
    const finish = (): void => {
      target.style.opacity = ''
      animations.forEach((animation) => animation.cancel())
      overlay?.remove()
    }
    const start = (): void => {
      if (!alive) return
      // Measure after decoding so the flight starts with a painted image and
      // the composer has settled into its attachment layout.
      const bounds = target.getBoundingClientRect()
      if (!bounds.width || !bounds.height) return
      const options = takeSnapshotArrival(file)
      if (!options || Date.now() - options.capturedAt > 10_000) return
      if (options.sound) playSnapshotSound()
      if (
        !options.animation ||
        reducedMotion ||
        window.matchMedia('(prefers-reduced-motion: reduce)').matches ||
        !target.animate
      )
        return
      const width = Math.min(320, window.innerWidth * 0.32)
      const aspect =
        target.naturalWidth && target.naturalHeight
          ? target.naturalWidth / target.naturalHeight
          : 1.6
      const height = Math.min(width / aspect, window.innerHeight * 0.34)
      const from = { x: window.innerWidth / 2, y: Math.max(100, window.innerHeight * 0.3) }
      const to = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }
      overlay = document.createElement('div')
      overlay.setAttribute('aria-hidden', 'true')
      overlay.dataset.snapshotFlight = ''
      Object.assign(overlay.style, {
        position: 'fixed',
        left: `${from.x - width / 2}px`,
        top: `${from.y - width / 2}px`,
        width: `${width}px`,
        height: `${width}px`,
        pointerEvents: 'none',
        zIndex: '9999',
        transformOrigin: '50% 50%',
        willChange: 'transform, opacity',
      })
      const viewport = document.createElement('div')
      Object.assign(viewport.style, {
        position: 'absolute',
        left: '0',
        top: '50%',
        transform: 'translateY(-50%)',
        width: '100%',
        height: `${height}px`,
        overflow: 'hidden',
        borderRadius: '12px',
        boxShadow: '0 16px 48px #0005',
        outline: '1px solid var(--color-border)',
      })
      const preview = document.createElement('img')
      preview.src = src
      preview.alt = ''
      Object.assign(preview.style, {
        width: '100%',
        height: '100%',
        objectFit: 'cover',
        display: 'block',
      })
      viewport.append(preview)
      overlay.append(viewport)
      document.body.append(overlay)
      target.style.opacity = '0'
      const frames = snapshotFlightFrames({
        from,
        to,
        width,
        height,
        destinationWidth: bounds.width,
        destinationHeight: bounds.height,
      })
      const timing: KeyframeAnimationOptions = {
        duration: SNAPSHOT_FLIGHT_DURATION,
        easing: 'linear',
        fill: 'forwards',
      }
      animations = [
        overlay.animate(frames.flight, timing),
        viewport.animate(frames.crop, timing),
        target.animate(frames.handoff, timing),
      ]
      void Promise.all(animations.map((animation) => animation.finished))
        .then(() => {
          if (alive) finish()
        })
        .catch(() => {
          if (alive) finish()
        })
    }
    // A decoded object URL is shared by the thumbnail and flying preview.
    // Cancelled effects never consume the arrival or hide a replacement image.
    if (typeof target.decode === 'function')
      void target
        .decode()
        .then(start)
        .catch(() => undefined)
    else start()
    return () => {
      alive = false
      finish()
    }
  }, [file, src, reducedMotion])
  return (
    <img
      ref={destination}
      data-snapshot-id={snapshotFileId(file)}
      src={src}
      alt={file.name}
      title={file.name}
      className="size-7 shrink-0 rounded-md object-cover"
    />
  )
}
