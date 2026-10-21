import { useCallback, useLayoutEffect, useReducer, useRef, type RefObject } from 'react'

/** Below this many rows a transcript mounts whole; laziness would only add work. */
export const LAZY_MIN_ROWS = 80
/** Opening a long session mounts this much estimated height of its tail. */
export const TAIL_BUDGET_PX = 4_000
/** How far beyond the viewport a placeholder starts mounting its row. */
const MOUNT_MARGIN = '1500px 0px'

export interface LazyRows {
  /** Whether the row renders its content, or a placeholder of its estimated height. */
  isMounted: (key: string) => boolean
  /** Ref for a placeholder element carrying `data-lazy-row={key}`. */
  observe: (element: HTMLElement | null) => (() => void) | undefined
  /** Mounts a row now, e.g. before jumping to it. */
  mount: (key: string) => void
}

/**
 * Progressive mounting for a long transcript. Rows stay in document flow —
 * the native scroll, and the browser's scroll anchoring, see one page — but
 * opening a session mounts only its tail. Every other row is a placeholder
 * of its estimated height until it comes within {@link MOUNT_MARGIN} of the
 * viewport, and once mounted it stays mounted, so scrolling back never
 * remounts anything. Rows that arrive after the history (a live turn) mount
 * at once.
 *
 * Without IntersectionObserver every row mounts, as before.
 */
export function useLazyRows(
  scrollRef: RefObject<HTMLElement | null>,
  rows: readonly { key: string }[],
  sessionId: string,
  estimate: (index: number) => number,
): LazyRows {
  const [, rerender] = useReducer((n: number) => n + 1, 0)
  const mountedRef = useRef(new Set<string>())
  const knownRef = useRef(new Set<string>())
  const sessionRef = useRef<string | null>(null)
  const observerRef = useRef<IntersectionObserver | null>(null)
  const pendingRef = useRef(new Set<HTMLElement>())

  if (sessionRef.current !== sessionId) {
    sessionRef.current = sessionId
    mountedRef.current = new Set()
    knownRef.current = new Set()
  }
  const mounted = mountedRef.current
  const known = knownRef.current
  if (known.size === 0 && rows.length > 0) {
    // The history a session opens with: mount the tail the reader lands on.
    const lazy = rows.length >= LAZY_MIN_ROWS && typeof IntersectionObserver !== 'undefined'
    let budget = lazy ? TAIL_BUDGET_PX : Number.POSITIVE_INFINITY
    for (let i = rows.length - 1; i >= 0; i--) {
      const key = rows[i]?.key
      if (key === undefined) continue
      known.add(key)
      if (budget > 0) mounted.add(key)
      if (lazy) budget -= estimate(i)
    }
  } else {
    for (const row of rows) {
      if (known.has(row.key)) continue
      known.add(row.key)
      mounted.add(row.key)
    }
  }

  useLayoutEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(
      (entries) => {
        let changed = false
        for (const entry of entries) {
          if (!entry.isIntersecting) continue
          observer.unobserve(entry.target)
          const key = entry.target instanceof HTMLElement ? entry.target.dataset.lazyRow : undefined
          if (key !== undefined && !mountedRef.current.has(key)) {
            mountedRef.current.add(key)
            changed = true
          }
        }
        if (changed) rerender()
      },
      { root: scrollRef.current, rootMargin: MOUNT_MARGIN },
    )
    observerRef.current = observer
    // Placeholders attach before the scroller does, so they wait for it here.
    for (const element of pendingRef.current) observer.observe(element)
    pendingRef.current.clear()
    return () => {
      observer.disconnect()
      observerRef.current = null
    }
  }, [scrollRef])

  const observe = useCallback((element: HTMLElement | null) => {
    if (element === null) return undefined
    const observer = observerRef.current
    if (observer !== null) observer.observe(element)
    else pendingRef.current.add(element)
    return () => {
      observerRef.current?.unobserve(element)
      pendingRef.current.delete(element)
    }
  }, [])

  const isMounted = useCallback((key: string) => mountedRef.current.has(key), [])
  const mount = useCallback((key: string) => {
    if (mountedRef.current.has(key)) return
    mountedRef.current.add(key)
    rerender()
  }, [])

  return { isMounted, observe, mount }
}
