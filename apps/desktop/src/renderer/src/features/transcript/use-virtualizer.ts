import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Minimal windowing hook mirroring the `@tanstack/react-virtual` API subset the
 * transcript needs (dynamic measured rows, overscan, absolute-positioned items,
 * programmatic scrolling). Implemented in-tree because the dependency is not
 * provisioned yet; swapping to the real package is a drop-in import change.
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
}

function computeOffsets(sizes: number[]): number[] {
  const offsets = new Array<number>(sizes.length + 1)
  offsets[0] = 0
  for (let i = 0; i < sizes.length; i++) {
    offsets[i + 1] = (offsets[i] ?? 0) + (sizes[i] ?? 0)
  }
  return offsets
}

export function useVirtualizer(options: UseVirtualizerOptions): Virtualizer {
  const { count, estimateSize, getScrollElement, overscan = 4 } = options

  const sizesRef = useRef<number[]>([])
  const nodesRef = useRef(new Map<number, HTMLElement>())
  const observerRef = useRef<ResizeObserver | null>(null)
  const [scrollOffset, setScrollOffset] = useState(0)
  // Bumped whenever a measurement changes so consumers re-render.
  const [measureVersion, setMeasureVersion] = useState(0)

  if (sizesRef.current.length !== count) {
    const next = new Array<number>(count)
    for (let i = 0; i < count; i++) {
      next[i] = sizesRef.current[i] ?? estimateSize(i)
    }
    sizesRef.current = next
  }

  useEffect(() => {
    const element = getScrollElement()
    if (!element) return
    const onScroll = (): void => {
      setScrollOffset(element.scrollTop)
    }
    onScroll()
    element.addEventListener('scroll', onScroll, { passive: true })
    ;(globalThis as Record<string, unknown>).__ariScrollAttached = true
    return () => {
      element.removeEventListener('scroll', onScroll)
    }
  }, [getScrollElement])

  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      setMeasureVersion((v) => v + 1)
    })
    const element = getScrollElement()
    if (element) observer.observe(element)
    observerRef.current = observer
    return () => {
      observer.disconnect()
      observerRef.current = null
    }
  }, [getScrollElement])

  const measureElement = useCallback((node: HTMLElement | null): void => {
    if (!node) return
    const index = Number(node.dataset['index'] ?? -1)
    if (index < 0 || index >= sizesRef.current.length) return
    nodesRef.current.set(index, node)
    const measured = node.getBoundingClientRect().height
    const previous = sizesRef.current[index] ?? 0
    if (Math.abs(measured - previous) > 0.5) {
      sizesRef.current[index] = measured
      setMeasureVersion((v) => v + 1)
    }
  }, [])

  const scrollToOffset = useCallback(
    (offset: number, behavior?: ScrollBehavior): void => {
      getScrollElement()?.scrollTo({ top: offset, left: 0, behavior })
    },
    [getScrollElement],
  )

  const scrollToBottom = useCallback(
    (behavior?: ScrollBehavior): void => {
      const offsets = computeOffsets(sizesRef.current)
      scrollToOffset(offsets[offsets.length - 1] ?? 0, behavior)
    },
    [scrollToOffset],
  )

  const getTotalSize = useCallback((): number => {
    const offsets = computeOffsets(sizesRef.current)
    return offsets[offsets.length - 1] ?? 0
  }, [])

  const getVirtualItems = useCallback((): VirtualItem[] => {
    void measureVersion
    const sizes = sizesRef.current
    const offsets = computeOffsets(sizes)
    const total = offsets[offsets.length - 1] ?? 0
    const viewport = getScrollElement()?.clientHeight ?? 0

    void total
    let firstVisible = 0
    while (firstVisible < count - 1 && (offsets[firstVisible + 1] ?? 0) <= scrollOffset) {
      firstVisible++
    }
    let lastVisible = firstVisible
    while (
      lastVisible < count - 1 &&
      (offsets[lastVisible + 1] ?? 0) < scrollOffset + viewport
    ) {
      lastVisible++
    }

    const start = Math.max(0, firstVisible - overscan)
    const end = Math.min(count - 1, lastVisible + overscan)

    const items: VirtualItem[] = []
    for (let index = start; index <= end; index++) {
      items.push({
        index,
        key: String(index),
        start: offsets[index] ?? 0,
        size: sizes[index] ?? 0,
      })
    }
    return items
  }, [count, getScrollElement, overscan, scrollOffset, measureVersion])

  const getRowStart = useCallback((index: number): number => {
    const offsets = computeOffsets(sizesRef.current)
    return offsets[index] ?? 0
  }, [])

  return { getTotalSize, getVirtualItems, measureElement, scrollToOffset, scrollToBottom, getRowStart }
}
