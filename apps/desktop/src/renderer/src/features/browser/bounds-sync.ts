export interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

/** Frames without movement before the per-frame watch stands down. */
const SETTLE_FRAMES = 8

function roundedRect(target: Element): Bounds {
  const rect = target.getBoundingClientRect()
  return {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  }
}

function sameBounds(a: Bounds | null, b: Bounds): boolean {
  return (
    a !== null && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
  )
}

/**
 * Everything whose box can move `target` without resizing it: each ancestor
 * and that ancestor's siblings (a sidebar collapsing beside the rail shifts
 * the rail's x but never its size).
 */
function layoutNeighbours(target: Element): Element[] {
  const out: Element[] = [target]
  for (let node: Element | null = target; node !== null && node !== document.body; ) {
    const parent: Element | null = node.parentElement
    if (parent === null) break
    for (const sibling of parent.children) if (sibling !== node) out.push(sibling)
    out.push(parent)
    node = parent
  }
  return out
}

/** A finite animation running on `target` or an ancestor; endless ones would never settle. */
function animating(target: Element): boolean {
  for (let node: Element | null = target; node !== null; node = node.parentElement) {
    for (const animation of node.getAnimations()) {
      const end = animation.effect?.getComputedTiming().endTime ?? Infinity
      if (animation.playState === 'running' && Number.isFinite(Number(end))) return true
    }
  }
  return false
}

/**
 * Reports `target`'s rounded viewport rect to `onChange` whenever it moves or
 * resizes. A ResizeObserver alone misses moves, and a rect read once mid-slide
 * is stale by the next frame, so any hint of layout change (a neighbour
 * resizing, the window resizing, a transition or animation starting) starts a
 * per-frame comparison that runs until the rect has held still for a few
 * frames and no ancestor is animating. `onChange` only fires on real change.
 */
export function trackBounds(target: Element, onChange: (bounds: Bounds) => void): () => void {
  let last: Bounds | null = null
  let frame: number | undefined
  let still = 0

  const measure = (): boolean => {
    const next = roundedRect(target)
    if (sameBounds(last, next)) return false
    last = next
    onChange(next)
    return true
  }

  const tick = (): void => {
    frame = undefined
    if (measure() || animating(target)) still = 0
    else still += 1
    if (still < SETTLE_FRAMES) frame = requestAnimationFrame(tick)
  }

  const kick = (): void => {
    still = 0
    if (frame === undefined) frame = requestAnimationFrame(tick)
  }

  const resize = new ResizeObserver(kick)
  for (const element of layoutNeighbours(target)) resize.observe(element)
  const events = ['resize', 'transitionrun', 'animationstart', 'transitionend', 'animationend']
  for (const name of events) window.addEventListener(name, kick, true)
  measure()
  kick()

  return () => {
    resize.disconnect()
    for (const name of events) window.removeEventListener(name, kick, true)
    if (frame !== undefined) cancelAnimationFrame(frame)
  }
}
