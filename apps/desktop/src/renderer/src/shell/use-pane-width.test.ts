import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  DOCK_WIDTH_BOUNDS,
  SIDEBAR_WIDTH_BOUNDS,
  useDockWidth,
  useSidebarWidth,
} from './use-pane-width'

/** Arrow keys are the headless stand-in for a drag on the resize handle. */
function press(result: { current: ReturnType<typeof useSidebarWidth> }, key: string): void {
  act(() => {
    result.current.handleProps.onKeyDown({
      key,
      preventDefault: () => undefined,
    } as unknown as React.KeyboardEvent<HTMLElement>)
  })
}

describe('useSidebarWidth', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('starts at the default width', () => {
    const { result } = renderHook(() => useSidebarWidth())
    expect(result.current.width).toBe(SIDEBAR_WIDTH_BOUNDS.default)
  })

  it('persists the width and restores it on remount', () => {
    const { result, unmount } = renderHook(() => useSidebarWidth())
    press(result, 'ArrowRight')
    const widened = result.current.width
    expect(widened).toBeGreaterThan(SIDEBAR_WIDTH_BOUNDS.default)
    unmount()

    const second = renderHook(() => useSidebarWidth())
    expect(second.result.current.width).toBe(widened)
  })

  it('clamps to the bounds instead of collapsing or swallowing the chat', () => {
    localStorage.setItem('ari.sidebar.width', '9999')
    const wide = renderHook(() => useSidebarWidth())
    expect(wide.result.current.width).toBe(SIDEBAR_WIDTH_BOUNDS.max)

    localStorage.setItem('ari.sidebar.width', '10')
    const narrow = renderHook(() => useSidebarWidth())
    expect(narrow.result.current.width).toBe(SIDEBAR_WIDTH_BOUNDS.min)
  })

  it('resets to the default on double-click', () => {
    localStorage.setItem('ari.sidebar.width', '420')
    const { result } = renderHook(() => useSidebarWidth())
    expect(result.current.width).toBe(420)
    act(() => {
      result.current.handleProps.onDoubleClick()
    })
    expect(result.current.width).toBe(SIDEBAR_WIDTH_BOUNDS.default)
  })
})

describe('useDockWidth', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('starts wide enough for a shell and keeps its own stored width', () => {
    const { result } = renderHook(() => useDockWidth())
    expect(result.current.width).toBe(DOCK_WIDTH_BOUNDS.default)

    press(result, 'ArrowLeft')
    expect(localStorage.getItem('ari.dock.width')).toBe(String(result.current.width))
    // The sidebar must not follow the rail around.
    expect(localStorage.getItem('ari.sidebar.width')).toBeNull()
  })

  it('grows leftward, because the rail is docked to the trailing edge', () => {
    const { result } = renderHook(() => useDockWidth())

    press(result, 'ArrowLeft')
    expect(result.current.width).toBeGreaterThan(DOCK_WIDTH_BOUNDS.default)

    press(result, 'ArrowRight')
    expect(result.current.width).toBe(DOCK_WIDTH_BOUNDS.default)
  })

  it('clamps to its own bounds', () => {
    localStorage.setItem('ari.dock.width', '9999')
    expect(renderHook(() => useDockWidth()).result.current.width).toBe(DOCK_WIDTH_BOUNDS.max)

    localStorage.setItem('ari.dock.width', '10')
    expect(renderHook(() => useDockWidth()).result.current.width).toBe(DOCK_WIDTH_BOUNDS.min)
  })
})
