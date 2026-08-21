import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DRAFTS_STORAGE_KEY, useDrafts } from './use-drafts'

function stored(): Record<string, string> {
  return JSON.parse(localStorage.getItem(DRAFTS_STORAGE_KEY) ?? '{}') as Record<string, string>
}

describe('useDrafts', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('loads a previously stored draft for the session', () => {
    localStorage.setItem(DRAFTS_STORAGE_KEY, JSON.stringify({ s1: 'hello world' }))
    const { result } = renderHook(() => useDrafts('s1'))
    expect(result.current.draft).toBe('hello world')
  })

  it('starts empty when nothing is stored', () => {
    const { result } = renderHook(() => useDrafts('s1'))
    expect(result.current.draft).toBe('')
  })

  it('writes after the 300ms debounce, not before', () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => useDrafts('s1'))
    act(() => result.current.setDraft('in progress'))
    expect(localStorage.getItem(DRAFTS_STORAGE_KEY)).toBeNull()
    act(() => {
      vi.advanceTimersByTime(300)
    })
    expect(stored()).toEqual({ s1: 'in progress' })
  })

  it('coalesces rapid edits into a single final write', () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => useDrafts('s1'))
    act(() => result.current.setDraft('a'))
    act(() => {
      vi.advanceTimersByTime(299)
    })
    act(() => result.current.setDraft('ab'))
    act(() => {
      vi.advanceTimersByTime(299)
    })
    expect(localStorage.getItem(DRAFTS_STORAGE_KEY)).toBeNull()
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(stored()).toEqual({ s1: 'ab' })
  })

  it('preserves drafts belonging to other sessions', () => {
    vi.useFakeTimers()
    localStorage.setItem(DRAFTS_STORAGE_KEY, JSON.stringify({ s2: 'other' }))
    const { result } = renderHook(() => useDrafts('s1'))
    act(() => result.current.setDraft('mine'))
    act(() => {
      vi.advanceTimersByTime(300)
    })
    expect(stored()).toEqual({ s1: 'mine', s2: 'other' })
  })

  it('clears the stored entry when the draft becomes empty', () => {
    vi.useFakeTimers()
    localStorage.setItem(DRAFTS_STORAGE_KEY, JSON.stringify({ s1: 'old' }))
    const { result } = renderHook(() => useDrafts('s1'))
    act(() => result.current.setDraft(''))
    act(() => {
      vi.advanceTimersByTime(300)
    })
    expect(stored()).toEqual({})
  })

  it('restores the other session draft when the session id changes', () => {
    vi.useFakeTimers()
    localStorage.setItem(DRAFTS_STORAGE_KEY, JSON.stringify({ s2: 'session two' }))
    const { result, rerender } = renderHook(({ id }) => useDrafts(id), {
      initialProps: { id: 's1' },
    })
    act(() => result.current.setDraft('session one'))
    rerender({ id: 's2' })
    expect(result.current.draft).toBe('session two')
    expect(stored()).toEqual({ s1: 'session one', s2: 'session two' })
  })

  it('flushes a pending edit on unmount', () => {
    vi.useFakeTimers()
    const { result, unmount } = renderHook(() => useDrafts('s1'))
    act(() => result.current.setDraft('unsaved'))
    unmount()
    expect(stored()).toEqual({ s1: 'unsaved' })
  })

  it('ignores corrupt stored payloads', () => {
    localStorage.setItem(DRAFTS_STORAGE_KEY, '{not json')
    const { result } = renderHook(() => useDrafts('s1'))
    expect(result.current.draft).toBe('')
  })
})
