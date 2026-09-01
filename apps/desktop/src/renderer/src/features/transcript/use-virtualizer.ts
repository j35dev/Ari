import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Minimal windowing hook mirroring the `@tanstack/react-virtual` API subset the
 * transcript needs (dynamic measured rows, overscan, absolute-positioned items,
 * programmatic scrolling). Implemented in-tree because the dependency is not
 * provisioned yet; swapping to the real package is a drop-in import change.
 *
 * Rows are re-measured via a shared ResizeObserver, so heights stay accurate as
 * content streams or reflows (code blocks, images, expand/collapse) — without
 * that, the spacer drifts from reality and scroll positions land on wrong rows
 * once the transcript holds many messages.
 */

export interface VirtualItem {
  index: number
  key: string
  start: number
  size: number
}

export interface UseVirtualizerOptions {
  count: number
  /** Estimate used before an element has been measured. */
  estimateSize: (index: number) => number
  getScrollElement: () => HTMLElement | null
  /** Extra rows rendered beyond the visible window on each side. */
  overscan?: number
}

export interface Virtualizer {
  getTotalSize(): number
  getVirtualItems(): VirtualItem[]
  /** Ref callback for row elements; reads `data-index` and records height. */
  measureElement(node: HTMLElement | null): void
  scrollToOffset(offset: number, behavior?: ScrollBehavior): void
  scrollToBottom(behavior?: ScrollBehavior): void
  /** Start offset of any row (measured or estimated), e.g. for jump links. */
  getRowStart(index: number): number
  /** Bumps whenever a measurement changes — drive dependent memoization off it. */
  getVersion(): number
}

export function useVirtualizer(options: UseVirtualizerOptions): Virtualizer {
  const { count, estimateSize, getScrollElement, overscan = 4 } = options

  const sizesRef = useRef<number[]>([])
  const nodesRef = useRef(new Map<number, HTMLElement>())
  const observerRef = useRef<ResizeObserver | null>(null)
  const [scrollOffset, setScrollOffset] = useState(0)
  const [measureVersion, setMeasureVersion] = useState(0)

  // Live mirrors so the stable API always reads current values even though the
  // returned object is created once.
  const countRef = useRef(count)
  const overscanRef = useRef(overscan)
  const estimateRef = useRef(estimateSize)
  const scrollGetterRef = useRef(getScrollElement)
  const scrollOffsetRef = useRef(scrollOffset)
  const measureVersionRef = useRef(measureVersion)
  const sizesVersionRef = useRef(0)
  const lastClientHeightRef = useRef(0)
  const offsetsCacheRef = useRef<{ version: number; count: number; offsets: number[] } | null>(null)
  const userScrollingRef = useRef(false)
  const pendingDeltaRef = useRef(0)
  const scrollIdleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  countRef.current = count
  overscanRef.current = overscan
  estimateRef.current = estimateSize
  scrollGetterRef.current = getScrollElement
  measureVersionRef.current = measureVersion
  // Prefer the live DOM offset. Writing React state back onto the ref here
  // was clobbering a fresher scrollTop (stick-to-bottom / overflow-anchor)
  // and windowing the first rows into a viewport that had already jumped
  // to the bottom of the spacer — the transcript flashed empty.
  const liveElement = scrollGetterRef.current()
  scrollOffsetRef.current = liveElement ? liveElement.scrollTop : scrollOffset

  if (sizesRef.current.length !== count) {
    const next = new Array<number>(count)
    for (let i = 0; i < count; i++) {
      next[i] = sizesRef.current[i] ?? estimateRef.current(i)
    }
    sizesRef.current = next
    sizesVersionRef.current++
  }

  // Offsets are recomputed only when a size or the row count changes, not on
  // every scroll frame.
  const getOffsets = useCallback((): number[] => {
    const cached = offsetsCacheRef.current
    if (cached && cached.version === sizesVersionRef.current && cached.count === countRef.current) {
      return cached.offsets
    }
    const n = countRef.current
    const sizes = sizesRef.current
    const offsets = new Array<number>(n + 1)
    offsets[0] = 0
    for (let i = 0; i < n; i++) {
      offsets[i + 1] = (offsets[i] ?? 0) + (sizes[i] ?? estimateRef.current(i))
    }
    offsetsCacheRef.current = { version: sizesVersionRef.current, count: n, offsets }
    return offsets
  }, [])

  // Stable getter wrapper so the listener/observer effect does not re-run on
  // every render (callers pass a fresh arrow each time).
  const stableGetScroll = useCallback(() => scrollGetterRef.current(), [])

  const bump = useCallback(() => setMeasureVersion((v) => v + 1), [])

  const applyScrollCorrection = useCallback(
    (element: HTMLElement, delta: number): void => {
      if (delta === 0) return
      const corrected = Math.max(0, element.scrollTop + delta)
      element.scrollTop = corrected
      scrollOffsetRef.current = corrected
    },
    [],
  )

  const flushPendingCorrection = useCallback((): void => {
    userScrollingRef.current = false
    const element = stableGetScroll()
    const delta = pendingDeltaRef.current
    pendingDeltaRef.current = 0
    if (element) applyScrollCorrection(element, delta)
  }, [applyScrollCorrection, stableGetScroll])

  const markUserScrolling = useCallback((): void => {
    userScrollingRef.current = true
    if (scrollIdleTimerRef.current !== null) clearTimeout(scrollIdleTimerRef.current)
    scrollIdleTimerRef.current = setTimeout(() => {
      scrollIdleTimerRef.current = null
      flushPendingCorrection()
    }, 120)
  }, [flushPendingCorrection])

  /**
   * Applies fresh row heights, keeping the viewport anchored to whatever the
   * reader is looking at. A row that sits entirely above the scroll position and
   * then changes height pushes every later row down by that delta; without a
   * matching `scrollTop` correction the transcript slides under the reader's
   * eyes. That is what made scrolling back through a long conversation feel like
   * it stuck and fought at every block boundary: rows enter the window at the
   * 64px estimate, get measured for real, and shove the content away again.
   *
   * Writing `scrollTop` during an in-flight wheel/trackpad gesture cancels the
   * rest of that gesture in Chromium, so the transcript feels stuck until the
   * reader starts a new flick. While they are scrolling we accumulate the
   * correction and apply it once the gesture ends.
   */
  const applyMeasurements = useCallback(
    (updates: { index: number; size: number }[]): void => {
      const sizes = sizesRef.current
      // Read the pre-change layout before any size is written.
      const offsets = getOffsets()
      const element = stableGetScroll()
      const scrollTop = element?.scrollTop ?? scrollOffsetRef.current
      let changed = false
      let deltaAbove = 0
      for (const { index, size } of updates) {
        if (index < 0 || index >= sizes.length) continue
        const previous = sizes[index] ?? 0
        if (Math.abs(size - previous) <= 0.5) continue
        if ((offsets[index] ?? 0) + previous <= scrollTop) deltaAbove += size - previous
        sizes[index] = size
        changed = true
      }
      if (!changed) return
      sizesVersionRef.current++
      if (deltaAbove !== 0 && element) {
        if (userScrollingRef.current) pendingDeltaRef.current += deltaAbove
        else applyScrollCorrection(element, deltaAbove)
      }
      bump()
    },
    [applyScrollCorrection, bump, getOffsets, stableGetScroll],
  )

  const measureNode = useCallback(
    (node: HTMLElement): void => {
      const index = Number(node.dataset['index'] ?? -1)
      if (index < 0) return
      applyMeasurements([{ index, size: node.getBoundingClientRect().height }])
    },
    [applyMeasurements],
  )

  // One ResizeObserver re-measures rows as their content height changes. A
  // resize without a matching row (the container) still re-renders so the
  // viewport is recomputed even when row heights don't shift.
  const handleResize = useCallback(
    (entries: ResizeObserverEntry[]): void => {
      const updates: { index: number; size: number }[] = []
      let containerTouched = false
      for (const entry of entries) {
        const el = entry.target as HTMLElement
        const index = Number(el.dataset['index'] ?? -1)
        if (index < 0 || index >= sizesRef.current.length) {
          containerTouched = true
          continue
        }
        updates.push({ index, size: el.getBoundingClientRect().height })
      }
      const version = sizesVersionRef.current
      applyMeasurements(updates)
      // Only bump on a real viewport-height change. Observing the scroller
      // and bumping on every notification retriggered stick-to-bottom in a
      // tight loop (measure → scroll → notify → measure).
      if (containerTouched && sizesVersionRef.current === version) {
        const height = stableGetScroll()?.clientHeight ?? 0
        if (height !== lastClientHeightRef.current) {
          lastClientHeightRef.current = height
          bump()
        }
      }
    },
    [applyMeasurements, bump, stableGetScroll],
  )

  // Attach the scroll listener and row-height observer once.
  useEffect(() => {
    const element = stableGetScroll()
    if (!element) return
    const onScroll = (): void => {
      const top = element.scrollTop
      scrollOffsetRef.current = top
      setScrollOffset(top)
    }
    onScroll()
    element.addEventListener('scroll', onScroll, { passive: true })
    element.addEventListener('wheel', markUserScrolling, { passive: true })
    element.addEventListener('touchmove', markUserScrolling, { passive: true })

    let observer: ResizeObserver | null = null
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(handleResize)
      observer.observe(element)
      observerRef.current = observer
    }

    return () => {
      element.removeEventListener('scroll', onScroll)
      element.removeEventListener('wheel', markUserScrolling)
      element.removeEventListener('touchmove', markUserScrolling)
      if (scrollIdleTimerRef.current !== null) clearTimeout(scrollIdleTimerRef.current)
      observer?.disconnect()
      observerRef.current = null
    }
  }, [stableGetScroll, handleResize, markUserScrolling])

  const measureElement = useCallback(
    (node: HTMLElement | null): void => {
      if (!node) return
      const index = Number(node.dataset['index'] ?? -1)
      if (index < 0 || index >= sizesRef.current.length) return
      const prev = nodesRef.current.get(index)
      if (prev && prev !== node) observerRef.current?.unobserve(prev)
      nodesRef.current.set(index, node)
      measureNode(node)
      observerRef.current?.observe(node)
    },
    [measureNode],
  )

  const scrollToOffset = useCallback(
    (offset: number, behavior?: ScrollBehavior): void => {
      const element = stableGetScroll()
      // jsdom (test environment) has no Element.scrollTo; scrollTop is the
      // equivalent everywhere that matters.
      if (element && typeof element.scrollTo === 'function') {
        element.scrollTo({ top: offset, left: 0, behavior })
      } else if (element) {
        element.scrollTop = offset
      }
    },
    [stableGetScroll],
  )

  const getTotalSize = useCallback((): number => {
    const offsets = getOffsets()
    return offsets[offsets.length - 1] ?? 0
  }, [getOffsets])

  const scrollToBottom = useCallback(
    (behavior?: ScrollBehavior): void => {
      const element = stableGetScroll()
      if (element && element.scrollHeight > element.clientHeight) {
        // Painted layout is authoritative. Requesting getTotalSize() (the
        // spacer) overshoots max scrollTop and fights Chromium overflow
        // anchoring — the scroller bounces between 0, mid, and the bottom.
        scrollToOffset(Math.max(0, element.scrollHeight - element.clientHeight), behavior)
        return
      }
      // jsdom (and the first frame before layout) has no useful scrollHeight.
      scrollToOffset(getTotalSize(), behavior)
    },
    [getTotalSize, scrollToOffset, stableGetScroll],
  )

  const getRowStart = useCallback(
    (index: number): number => {
      const offsets = getOffsets()
      return offsets[index] ?? 0
    },
    [getOffsets],
  )

  const getVirtualItems = useCallback((): VirtualItem[] => {
    const sizes = sizesRef.current
    const n = sizes.length
    if (n === 0) return []
    const offsets = getOffsets()
    const element = stableGetScroll()
    const viewport = element?.clientHeight ?? 0
    const scroll = element?.scrollTop ?? scrollOffsetRef.current

    // Binary search: first row whose bottom edge is below scrollTop.
    let firstVisible = 0
    let lo = 0
    let hi = n - 1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if ((offsets[mid + 1] ?? 0) <= scroll) {
        firstVisible = mid + 1
        lo = mid + 1
      } else {
        hi = mid - 1
      }
    }
    let lastVisible = firstVisible
    while (lastVisible < n - 1 && (offsets[lastVisible + 1] ?? 0) < scroll + viewport) {
      lastVisible++
    }

    const start = Math.max(0, firstVisible - overscanRef.current)
    const end = Math.min(n - 1, lastVisible + overscanRef.current)

    const items: VirtualItem[] = []
    for (let index = start; index <= end; index++) {
      items.push({
        index,
        key: index.toString(),
        start: offsets[index] ?? 0,
        size: sizes[index] ?? 0,
      })
    }
    return items
  }, [getOffsets, stableGetScroll])

  // Stable API: methods read live refs, so consumers don't re-render or re-run
  // effects on every scroll frame.
  const apiRef = useRef<Virtualizer | null>(null)
  if (!apiRef.current) {
    apiRef.current = {
      getTotalSize,
      getVirtualItems,
      measureElement,
      scrollToOffset,
      scrollToBottom,
      getRowStart,
      getVersion: () => measureVersionRef.current,
    }
  }
  return apiRef.current
}
