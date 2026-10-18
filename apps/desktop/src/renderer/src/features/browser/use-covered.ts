import { useEffect, useState, type RefObject } from 'react'

const EDGE_STEP = 24
const FILL_STEP = 96
const MIN_GAP_MS = 150

/**
 * Where to hit-test `rect`: a tight ring just inside its edge, which anything
 * anchored outside must cross, and a loose grid for what floats in the middle.
 */
function* probePoints(rect: DOMRect): Generator<[number, number]> {
  const left = rect.left + 1
  const top = rect.top + 1
  const right = rect.right - 1
  const bottom = rect.bottom - 1
  for (let x = left; x < right; x += EDGE_STEP) {
    yield [x, top]
    yield [x, bottom]
  }
  for (let y = top; y < bottom; y += EDGE_STEP) {
    yield [left, y]
    yield [right, y]
  }
  for (let y = top + FILL_STEP; y < bottom; y += FILL_STEP) {
    for (let x = left + FILL_STEP; x < right; x += FILL_STEP) yield [x, y]
  }
}

/**
 * True when something the user opened is painted over `host`. Toasts do not
 * count: they arrive unasked and can stay up indefinitely, and the host has
 * to stay usable meanwhile.
 */
export function isCovered(host: Element): boolean {
  for (const [x, y] of probePoints(host.getBoundingClientRect())) {
    const top = document.elementFromPoint(x, y)
    if (top === null || host.contains(top)) continue
    if (top.closest('[data-toast-viewport]') === null) return true
  }
  return false
}

/**
 * Whether app UI (a dialog, palette, menu) currently overlaps the host element.
 * A native view stacked on the host paints above the whole document, so its
 * owner has to move it out of the way while this is true.
 */
export function useCovered(hostRef: RefObject<Element | null>, enabled: boolean): boolean {
  const [covered, setCovered] = useState(false)

  useEffect(() => {
    const host = hostRef.current
    if (!enabled || host === null) return
    let timer: number | undefined
    let checkedAt = -MIN_GAP_MS
    const check = (): void => {
      timer = undefined
      checkedAt = performance.now()
      setCovered(isCovered(host))
    }
    // A full sweep costs a few ms and a streaming transcript mutates every
    // frame, so sweeps are spaced out rather than run per mutation.
    const schedule = (): void => {
      if (timer !== undefined) return
      timer = window.setTimeout(check, Math.max(0, checkedAt + MIN_GAP_MS - performance.now()))
    }
    const observer = new MutationObserver(schedule)
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style'],
    })
    schedule()
    return () => {
      observer.disconnect()
      window.clearTimeout(timer)
      setCovered(false)
    }
  }, [hostRef, enabled])

  return covered
}
