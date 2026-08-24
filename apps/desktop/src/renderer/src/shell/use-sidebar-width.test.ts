import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { SIDEBAR_WIDTH_BOUNDS, useSidebarWidth } from './use-sidebar-width'

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
    act(() => {
      result.current.handleProps.onKeyDown({
        key: 'ArrowRight',
        preventDefault: () => undefined,
      } as unknown as React.KeyboardEvent<HTMLElement>)
    })
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
