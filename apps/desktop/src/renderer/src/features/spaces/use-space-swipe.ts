import { useEffect, useRef } from 'react'

/**
 * Two-finger trackpad swipes switch spaces. Electron (like the browser) delivers
 * them as horizontal `wheel` events on Windows and macOS, so the switch is built
 * from those rather than an OS gesture API that would only exist on one of them.
 *
 * The hard part is not detecting a swipe but not stealing one. A transcript's
 * code block, a diff, an inspector — any of them can scroll sideways, and a
 * gesture over one is the user scrolling, not the user switching tabs. The
 * detector therefore refuses a gesture whose target sits inside a horizontal
 * scroller, refuses one that is mostly vertical, and swallows the momentum tail
 * that follows a switch so a single flick moves exactly one tab.
 */

/** Direction of travel: -1 is the previous tab, 1 the next. */
export type SwipeDirection = -1 | 1

export interface SwipeDetectorOptions {
  /** Distance (px) the gesture must travel before it switches. */
  threshold?: number
  /** A pause longer than this starts a fresh gesture. */
  idleMs?: number
  /** After a switch, ignore deltas for this long (trackpad momentum). */
  cooldownMs?: number
}

export interface SwipeSample {
  deltaX: number
  deltaY: number
  at: number
}

export interface SwipeDetector {
  /** Folds one wheel sample in; returns the direction to switch when it fires. */
  feed: (sample: SwipeSample) => SwipeDirection | null
  reset: () => void
}

export const SWIPE_THRESHOLD = 120
const IDLE_MS = 160
const COOLDOWN_MS = 500

/**
 * Pure swipe state machine, kept out of the hook so the arithmetic is testable
 * without a DOM or a real trackpad.
 */
export function createSwipeDetector(options: SwipeDetectorOptions = {}): SwipeDetector {
  const threshold = options.threshold ?? SWIPE_THRESHOLD
  const idleMs = options.idleMs ?? IDLE_MS
  const cooldownMs = options.cooldownMs ?? COOLDOWN_MS
  let accumulated = 0
  let lastAt = 0
  let lastFiredAt = Number.NEGATIVE_INFINITY

  return {
    feed({ deltaX, deltaY, at }) {
      // A fresh gesture after a pause starts from zero, so two unrelated small
      // nudges do not add up into a switch.
      if (at - lastAt > idleMs) accumulated = 0
      lastAt = at

      // The momentum tail after a switch must not fire a second one.
      if (at - lastFiredAt < cooldownMs) {
        accumulated = 0
        return null
      }

      // Mostly-vertical motion is scrolling the page, never a tab swipe.
      if (Math.abs(deltaY) > Math.abs(deltaX)) {
        accumulated = 0
        return null
      }

      accumulated += deltaX
      if (Math.abs(accumulated) < threshold) return null

      // Positive deltaX scrolls toward the right, which is a finger drag to the
      // left — the browser-tab reading of "swipe left for the next tab".
      const direction: SwipeDirection = accumulated < 0 ? -1 : 1
      accumulated = 0
      lastFiredAt = at
      return direction
    },
    reset() {
      accumulated = 0
      lastAt = 0
    },
  }
}

/** True when walking up from `target` hits an element that can scroll sideways. */
export function hasHorizontalScroller(target: EventTarget | null): boolean {
  let node = target instanceof Element ? target : null
  while (node !== null) {
    if (node instanceof HTMLElement) {
      const overflowX = getComputedStyle(node).overflowX
      if (
        (overflowX === 'auto' || overflowX === 'scroll') &&
        node.scrollWidth > node.clientWidth + 1
      ) {
        return true
      }
    }
    node = node.parentElement
  }
  return false
}

/**
 * Attaches the swipe gesture to the window, so a two-finger swipe anywhere in
 * the workspace feels like switching a browser tab. A sideways scroll is left
 * alone: the detector skips any gesture whose target sits in a horizontal
 * scroller, and only a gesture that actually switches calls `preventDefault`,
 * which is why the listener is native and non-passive.
 */
export function useSpaceSwipe({
  onSwipe,
  enabled = true,
}: {
  onSwipe: (direction: SwipeDirection) => void
  enabled?: boolean
}): void {
  const onSwipeRef = useRef(onSwipe)
  onSwipeRef.current = onSwipe

  useEffect(() => {
    if (!enabled) return
    const detector = createSwipeDetector()
    const onWheel = (event: WheelEvent): void => {
      // Pinch-zoom arrives as Ctrl+wheel and is not a tab swipe.
      if (event.ctrlKey) return
      // Vertical scrolling is the common case; reject it before the ancestor
      // walk below, which resolves computed styles and is not free on every
      // wheel tick. Feeding the delta still ends any gesture in progress.
      if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
        detector.feed({ deltaX: 0, deltaY: event.deltaY, at: event.timeStamp })
        return
      }
      if (hasHorizontalScroller(event.target)) return
      const direction = detector.feed({
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        at: event.timeStamp,
      })
      if (direction === null) return
      event.preventDefault()
      onSwipeRef.current(direction)
    }
    window.addEventListener('wheel', onWheel, { passive: false })
    return () => window.removeEventListener('wheel', onWheel)
  }, [enabled])
}
