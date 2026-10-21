import { openOverlays, subscribeOverlays } from '@ari/ui/overlay-registry'

/** Shadows and focus rings reach a little past a surface's box. */
const BLEED = 8

interface Box {
  left: number
  top: number
  right: number
  bottom: number
  width: number
  height: number
}

/** True when `overlay`, padded by its shadow, shares any area with a non-empty `host`. */
export function overlaps(host: Box, overlay: Box): boolean {
  if (host.width <= 0 || host.height <= 0 || overlay.width <= 0 || overlay.height <= 0) return false
  return (
    overlay.left - BLEED < host.right &&
    overlay.right + BLEED > host.left &&
    overlay.top - BLEED < host.bottom &&
    overlay.bottom + BLEED > host.top
  )
}

/**
 * Calls `onChange` whenever a registered overlay starts or stops overlapping
 * `host`. The check runs in the microtask after an overlay mounts, before it
 * first paints, and then every frame while any overlay is open, since a
 * floating menu settles into place (and may move) after it mounts.
 */
export function watchOverlays(host: Element, onChange: (overlaid: boolean) => void): () => void {
  let overlaid = false
  let frame: number | undefined

  const check = (): void => {
    const open = openOverlays()
    const hostBox = host.getBoundingClientRect()
    const next = open.some((overlay) => overlaps(hostBox, overlay.getBoundingClientRect()))
    if (next !== overlaid) {
      overlaid = next
      onChange(next)
    }
    if (open.length > 0) frame ??= requestAnimationFrame(tick)
  }

  const tick = (): void => {
    frame = undefined
    check()
  }

  const unsubscribe = subscribeOverlays(check)
  check()
  return () => {
    unsubscribe()
    if (frame !== undefined) cancelAnimationFrame(frame)
  }
}
