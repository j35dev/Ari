import { useCallback, useRef } from 'react'

/**
 * Every floating surface the app has open: menus, popovers, scrims, tooltips.
 * Native views (the in-app browser) paint above the whole document, so their
 * owners subscribe here and step aside the moment one of these overlaps them,
 * instead of discovering the overlap by hit-testing after it has painted.
 */
const open = new Set<Element>()
const listeners = new Set<() => void>()
let queued = false

/**
 * Listeners run once per microtask, after the commit that changed the set and
 * before the browser paints it. A re-rendering surface detaches and reattaches
 * its ref in one commit; batching keeps that from reading as close-then-open.
 */
function notify(): void {
  if (queued) return
  queued = true
  queueMicrotask(() => {
    queued = false
    for (const listener of listeners) listener()
  })
}

/** Marks `element` as an open overlay until the returned function runs. */
export function registerOverlay(element: Element): () => void {
  open.add(element)
  notify()
  return () => {
    if (open.delete(element)) notify()
  }
}

/** Calls `listener` whenever the set of open overlays changes. */
export function subscribeOverlays(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** The overlays open right now. */
export function openOverlays(): Element[] {
  return [...open]
}

/**
 * A stable ref callback that registers whatever element it is attached to.
 * Safe to call from inside another ref callback: it accepts `null` on detach.
 */
export function useOverlayRef(): (node: Element | null) => void {
  const release = useRef<(() => void) | null>(null)
  return useCallback((node: Element | null) => {
    release.current?.()
    release.current = node === null ? null : registerOverlay(node)
  }, [])
}
