import { useLayoutEffect, useRef, type RefObject } from 'react'

/**
 * One once-a-second clock for every live readout (elapsed timers, the working
 * word). However many turns and delegated children are running, the renderer
 * holds a single interval, all readouts tick on the same beat, and nothing is
 * scheduled while none is mounted. Looping visuals are CSS animations and do
 * not use this at all.
 */

export const TICK_MS = 1000

type Listener = (now: number) => void

const listeners = new Set<Listener>()
let timer: ReturnType<typeof setInterval> | undefined

function tick(): void {
  const now = Date.now()
  for (const listener of listeners) listener(now)
}

/** Calls `listener` on every shared tick until the returned function is called. */
export function subscribeTick(listener: Listener): () => void {
  listeners.add(listener)
  if (timer === undefined) timer = setInterval(tick, TICK_MS)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && timer !== undefined) {
      clearInterval(timer)
      timer = undefined
    }
  }
}

/** Whether the shared interval is currently scheduled (for tests). */
export function clockRunning(): boolean {
  return timer !== undefined
}

/**
 * A text readout that repaints itself on the shared tick without a React
 * render: the returned ref's text is replaced in place. Render the element
 * with constant children so React never reconciles the text it no longer
 * owns. A change of `key` (a new start time) repaints at once.
 */
export function useTickingText<T extends HTMLElement>(
  format: (now: number) => string,
  key: unknown,
): RefObject<T | null> {
  const ref = useRef<T>(null)
  const formatRef = useRef(format)
  formatRef.current = format
  useLayoutEffect(() => {
    const paint = (now: number): void => {
      if (ref.current !== null) ref.current.textContent = formatRef.current(now)
    }
    paint(Date.now())
    return subscribeTick(paint)
  }, [key])
  return ref
}
