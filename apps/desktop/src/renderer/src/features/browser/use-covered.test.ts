import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isCovered, useCovered } from './use-covered'

const RECT = { left: 800, top: 100, right: 1200, bottom: 700 } as DOMRect

/** A sized host: jsdom lays nothing out, so the rect is pinned by hand. */
function mountHost(): HTMLElement {
  const host = document.createElement('div')
  host.getBoundingClientRect = () => RECT
  document.body.append(host)
  return host
}

/** Stand-in for hit-testing: `pick` names what is painted at each point. */
function paint(pick: (x: number, y: number) => Element | null): void {
  document.elementFromPoint = vi.fn(pick)
}

describe('isCovered', () => {
  let host: HTMLElement

  beforeEach(() => {
    host = mountHost()
  })

  afterEach(() => {
    document.body.replaceChildren()
  })

  it('is false when the host and its own children are all that is painted there', () => {
    const child = document.createElement('img')
    host.append(child)
    paint((x) => (x < 1000 ? host : child))
    expect(isCovered(host)).toBe(false)
  })

  it('finds a menu that only reaches over one edge', () => {
    const menu = document.createElement('div')
    document.body.append(menu)
    paint((x, y) => (x < 820 && y > 300 && y < 340 ? menu : host))
    expect(isCovered(host)).toBe(true)
  })

  it('finds a panel floating clear of every edge', () => {
    const panel = document.createElement('div')
    document.body.append(panel)
    paint((x, y) => (x > 850 && x < 1150 && y > 150 && y < 650 ? panel : host))
    expect(isCovered(host)).toBe(true)
  })

  it('does not count a toast', () => {
    const viewport = document.createElement('div')
    viewport.setAttribute('data-toast-viewport', '')
    const toast = document.createElement('p')
    viewport.append(toast)
    document.body.append(viewport)
    paint((_x, y) => (y < 180 ? toast : host))
    expect(isCovered(host)).toBe(false)
  })

  it('only probes the portion of a host inside the viewport', () => {
    host.getBoundingClientRect = () =>
      ({
        left: -100,
        top: -100,
        right: window.innerWidth + 100,
        bottom: window.innerHeight + 100,
      }) as DOMRect
    paint(() => host)

    expect(isCovered(host)).toBe(false)
    for (const [x, y] of vi.mocked(document.elementFromPoint).mock.calls) {
      expect(x).toBeGreaterThanOrEqual(0)
      expect(x).toBeLessThan(window.innerWidth)
      expect(y).toBeGreaterThanOrEqual(0)
      expect(y).toBeLessThan(window.innerHeight)
    }
  })

  it('does not probe a host entirely outside the viewport', () => {
    host.getBoundingClientRect = () =>
      ({ left: -100, top: -100, right: -10, bottom: -10 }) as DOMRect
    paint(() => document.body)

    expect(isCovered(host)).toBe(false)
    expect(document.elementFromPoint).not.toHaveBeenCalled()
  })
})

describe('useCovered', () => {
  afterEach(() => {
    document.body.replaceChildren()
  })

  it('follows an overlay as it mounts and unmounts', async () => {
    const host = mountHost()
    paint(() => document.querySelector('[role="dialog"]') ?? host)
    const ref = { current: host }
    const { result } = renderHook(() => useCovered(ref, true))
    expect(result.current).toBe(false)

    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    document.body.append(dialog)
    await waitFor(() => expect(result.current).toBe(true))

    dialog.remove()
    await waitFor(() => expect(result.current).toBe(false))
  })

  it('stays false while disabled', async () => {
    const host = mountHost()
    const overlay = document.createElement('div')
    document.body.append(overlay)
    paint(() => overlay)
    const ref = { current: host }
    const { result, rerender } = renderHook(({ on }) => useCovered(ref, on), {
      initialProps: { on: true },
    })
    await waitFor(() => expect(result.current).toBe(true))

    rerender({ on: false })
    expect(result.current).toBe(false)
  })

  it.each(['resize', 'scroll'])(
    'rechecks coverage after %s without a DOM mutation',
    async (event) => {
      const host = mountHost()
      const overlay = document.createElement('div')
      document.body.append(overlay)
      let overlapping = true
      paint(() => (overlapping ? overlay : host))
      const ref = { current: host }
      const { result } = renderHook(() => useCovered(ref, true))
      await waitFor(() => expect(result.current).toBe(true))

      overlapping = false
      // Element scroll events do not bubble; the window listener must capture.
      const target = event === 'scroll' ? host : window
      target.dispatchEvent(new Event(event))
      await waitFor(() => expect(result.current).toBe(false))
    },
  )

  it('stops checking resize and scroll events after unmount', async () => {
    const host = mountHost()
    paint(() => host)
    const ref = { current: host }
    const { unmount } = renderHook(() => useCovered(ref, true))
    await waitFor(() => expect(document.elementFromPoint).toHaveBeenCalled())
    unmount()
    vi.mocked(document.elementFromPoint).mockClear()
    vi.useFakeTimers()

    try {
      window.dispatchEvent(new Event('resize'))
      host.dispatchEvent(new Event('scroll'))
      await vi.advanceTimersByTimeAsync(200)
      expect(document.elementFromPoint).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})
