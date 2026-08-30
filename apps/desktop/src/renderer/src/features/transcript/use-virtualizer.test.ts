// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { useVirtualizer } from './use-virtualizer'

afterEach(cleanup)

function stubScrollElement(height: number): HTMLDivElement {
  const el = document.createElement('div')
  Object.defineProperty(el, 'clientHeight', { configurable: true, value: height })
  // jsdom does no layout, so its scrollTop setter is a no-op; back it with a
  // field so anchoring corrections are observable.
  let scrollTop = 0
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => scrollTop,
    set: (value: number) => {
      scrollTop = value
    },
  })
  return el
}

interface HarnessProps {
  count: number
  scrollEl: HTMLDivElement
  estimate: number
  onReady: (v: ReturnType<typeof useVirtualizer>) => void
}

function Harness(props: HarnessProps) {
  ;(globalThis as Record<string, unknown>).__ariRenders = ((globalThis as Record<string, unknown>).__ariRenders as number ?? 0) + 1
  const virtualizer = useVirtualizer({
    count: props.count,
    estimateSize: () => props.estimate,
    getScrollElement: () => props.scrollEl,
    overscan: 1,
  })
  props.onReady(virtualizer)
  return createElement('div')
}

function renderHarness(count: number, viewport: number, estimate = 50) {
  const scrollEl = stubScrollElement(viewport)
  // Boxed so TypeScript keeps the assigned type across the callback boundary.
  const box: { v: ReturnType<typeof useVirtualizer> | null } = { v: null }
  render(
    createElement(Harness, {
      count,
      scrollEl,
      estimate,
      onReady: (v: ReturnType<typeof useVirtualizer>) => {
        box.v = v
      },
    }),
  )
  if (!box.v) throw new Error('virtualizer not initialized')
  // Getter so assertions always see the latest post-re-render instance.
  return {
    get api() {
      if (!box.v) throw new Error('virtualizer not initialized')
      return box.v
    },
    scrollEl,
  }
}

describe('useVirtualizer', () => {
  it('windows items to the viewport plus overscan', () => {
    const { api } = renderHarness(100, 500)
    const items = api.getVirtualItems()
    // 10 visible rows (500/50) + 1 overscan beyond the last, clamped at top.
    expect(items).toHaveLength(11)
    expect(items[0]?.index).toBe(0)
    expect(items.at(-1)?.index).toBe(10)
    expect(api.getTotalSize()).toBe(100 * 50)
  })

  it('measureElement replaces estimates with measured heights', () => {
    const { api } = renderHarness(3, 500)
    const node = document.createElement('div')
    node.dataset['index'] = '1'
    node.getBoundingClientRect = () => ({ height: 120 }) as DOMRect
    act(() => {
      api.measureElement(node)
    })
    expect(api.getTotalSize()).toBe(50 + 120 + 50)
    const item = api.getVirtualItems().find((i) => i.index === 1)
    expect(item?.size).toBe(120)
  })

  it('ignores nodes without a valid data-index', () => {
    const { api } = renderHarness(2, 500)
    const node = document.createElement('div')
    node.getBoundingClientRect = () => ({ height: 999 }) as DOMRect
    expect(() => api.measureElement(node)).not.toThrow()
    expect(api.getTotalSize()).toBe(100)
  })

  it('handles empty lists', () => {
    const { api } = renderHarness(0, 500)
    expect(api.getVirtualItems()).toEqual([])
    expect(api.getTotalSize()).toBe(0)
  })

  it('scrollToBottom targets total size', () => {
    const { api, scrollEl } = renderHarness(4, 100)
    let target: ScrollToOptions | null = null
    scrollEl.scrollTo = ((options?: ScrollToOptions) => {
      target = options ?? null
    }) as typeof scrollEl.scrollTo
    api.scrollToBottom('smooth')
    expect(target).toMatchObject({ top: 200, behavior: 'smooth' })
  })

  it('bumps version when a measurement changes', () => {
    const { api } = renderHarness(3, 500)
    expect(api.getVersion()).toBe(0)
    const node = document.createElement('div')
    node.dataset['index'] = '1'
    node.getBoundingClientRect = () => ({ height: 120 }) as DOMRect
    act(() => {
      api.measureElement(node)
    })
    expect(api.getVersion()).toBeGreaterThan(0)
  })

  /**
   * Regression: rows entered the window at their estimate, were measured for
   * real, and shoved everything below them down — so scrolling back through a
   * long transcript stuck and jumped at every block boundary.
   */
  it('anchors the viewport when a row above the fold is re-measured', () => {
    const { api, scrollEl } = renderHarness(20, 200, 50)
    scrollEl.scrollTop = 300
    const node = document.createElement('div')
    node.dataset['index'] = '2' // occupies 100..150, entirely above the fold
    node.getBoundingClientRect = () => ({ height: 250 }) as DOMRect
    act(() => {
      api.measureElement(node)
    })
    expect(scrollEl.scrollTop).toBe(500)
  })

  it('leaves the scroll position alone when the re-measured row is on screen', () => {
    const { api, scrollEl } = renderHarness(20, 200, 50)
    scrollEl.scrollTop = 300
    const node = document.createElement('div')
    node.dataset['index'] = '8' // occupies 400..450, below the fold
    node.getBoundingClientRect = () => ({ height: 250 }) as DOMRect
    act(() => {
      api.measureElement(node)
    })
    expect(scrollEl.scrollTop).toBe(300)
  })

  it('shrinking a row above the fold pulls the viewport back up', () => {
    const { api, scrollEl } = renderHarness(20, 200, 50)
    scrollEl.scrollTop = 300
    const node = document.createElement('div')
    node.dataset['index'] = '1'
    node.getBoundingClientRect = () => ({ height: 20 }) as DOMRect
    act(() => {
      api.measureElement(node)
    })
    expect(scrollEl.scrollTop).toBe(270)
  })
})
