import { useRef, useState, type TouchEvent } from 'react'

const THRESHOLD = 72

/**
 * Pull a scrolled-to-top list down to refresh it. Returns the handlers for
 * the scroll container and how far it has been pulled, for an indicator.
 */
export function usePullToRefresh(onRefresh: () => void): {
  pull: number
  ready: boolean
  handlers: {
    onTouchStart: (event: TouchEvent<HTMLElement>) => void
    onTouchMove: (event: TouchEvent<HTMLElement>) => void
    onTouchEnd: () => void
  }
} {
  const start = useRef<number | null>(null)
  const [pull, setPull] = useState(0)
  return {
    pull,
    ready: pull >= THRESHOLD,
    handlers: {
      onTouchStart: (event) => {
        start.current =
          event.currentTarget.scrollTop <= 0 ? (event.touches[0]?.clientY ?? null) : null
      },
      onTouchMove: (event) => {
        if (start.current === null) return
        const distance = (event.touches[0]?.clientY ?? start.current) - start.current
        // Resistance: the list follows the finger at half speed, then stops.
        setPull(Math.max(0, Math.min(THRESHOLD * 1.5, distance / 2)))
      },
      onTouchEnd: () => {
        if (pull >= THRESHOLD) onRefresh()
        start.current = null
        setPull(0)
      },
    },
  }
}
