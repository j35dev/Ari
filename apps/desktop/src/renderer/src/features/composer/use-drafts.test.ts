import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DRAFTS_STORAGE_KEY, dropDraftTextMemory, useDrafts } from './use-drafts'

function stored(): Record<string, string> {
  return JSON.parse(localStorage.getItem(DRAFTS_STORAGE_KEY) ?? '{}') as Record<string, string>
}

describe('useDrafts', () => {
  beforeEach(() => {
    dropDraftTextMemory()
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

  it('shares the latest text across two mounted copies without an older unmount overwriting it', () => {
    const first = renderHook(() => useDrafts('s1'))
    act(() => first.result.current.setDraft('first edit'))
    const second = renderHook(() => useDrafts('s1'))
    expect(second.result.current.draft).toBe('first edit')
    act(() => second.result.current.setDraft('newer edit'))
    expect(first.result.current.draft).toBe('newer edit')
    first.unmount()
    second.unmount()
    expect(stored()).toEqual({ s1: 'newer edit' })
  })

  it('keeps the live text through unavailable storage and remount', () => {
    const read = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('unavailable')
    })
    const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('unavailable')
    })
    try {
      const first = renderHook(() => useDrafts('s1'))
      act(() => first.result.current.setDraft('keep me'))
      first.unmount()
      const second = renderHook(() => useDrafts('s1'))
      expect(second.result.current.draft).toBe('keep me')
      expect(second.result.current.storageIssue).toBe(true)
    } finally {
      read.mockRestore()
      write.mockRestore()
    }
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

  it('does not replace other saved drafts when reading fails but writing is available', () => {
    vi.useFakeTimers()
    localStorage.setItem(DRAFTS_STORAGE_KEY, JSON.stringify({ s2: 'other work' }))
    const { result } = renderHook(() => useDrafts('s1'))
    const read = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('temporary read failure')
    })
    try {
      act(() => result.current.setDraft('keep mine too'))
      act(() => vi.advanceTimersByTime(300))
      expect(result.current.draft).toBe('keep mine too')
      expect(result.current.storageIssue).toBe(true)
    } finally {
      read.mockRestore()
    }
    expect(stored()).toEqual({ s2: 'other work' })
  })

  it('does not replace an oversized stored draft collection with an incomplete map', () => {
    vi.useFakeTimers()
    const original = JSON.stringify({ s2: 'x'.repeat(2 * 1024 * 1024) })
    localStorage.setItem(DRAFTS_STORAGE_KEY, original)
    const { result } = renderHook(() => useDrafts('s1'))
    act(() => result.current.setDraft('keep mine too'))
    act(() => vi.advanceTimersByTime(300))
    expect(result.current.draft).toBe('keep mine too')
    expect(result.current.storageIssue).toBe(true)
    expect(localStorage.getItem(DRAFTS_STORAGE_KEY)).toBe(original)
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

  it('flushes edits and clears before renderer page exit', () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => useDrafts('s1'))
    act(() => result.current.setDraft('before reload'))
    act(() => window.dispatchEvent(new Event('pagehide')))
    expect(stored()).toEqual({ s1: 'before reload' })
    act(() => result.current.setDraft(''))
    act(() => window.dispatchEvent(new Event('beforeunload')))
    expect(stored()).toEqual({})
  })

  it.each(['pagehide', 'beforeunload'])(
    'flushes the latest edit on %s before React unmounts',
    (event) => {
      vi.useFakeTimers()
      const { result, unmount } = renderHook(() => useDrafts('s1'))
      act(() => result.current.setDraft('latest edit'))
      act(() => vi.advanceTimersByTime(299))
      expect(localStorage.getItem(DRAFTS_STORAGE_KEY)).toBeNull()

      act(() => window.dispatchEvent(new Event(event)))

      expect(stored()).toEqual({ s1: 'latest edit' })
      unmount()
      expect(renderHook(() => useDrafts('s1')).result.current.draft).toBe('latest edit')
    },
  )

  it('flushes a pending clear on pagehide so a sent draft does not return after reload', () => {
    vi.useFakeTimers()
    localStorage.setItem(DRAFTS_STORAGE_KEY, JSON.stringify({ s1: 'sent', s2: 'other draft' }))
    const { result } = renderHook(() => useDrafts('s1'))
    act(() => result.current.setDraft(''))

    act(() => window.dispatchEvent(new Event('pagehide')))

    expect(stored()).toEqual({ s2: 'other draft' })
  })

  it('ignores corrupt stored payloads', () => {
    localStorage.setItem(DRAFTS_STORAGE_KEY, '{not json')
    const { result } = renderHook(() => useDrafts('s1'))
    expect(result.current.draft).toBe('')
  })

  it('applies a functional updater against the latest draft', () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => useDrafts('s1'))
    act(() => result.current.setDraft('see '))
    act(() => result.current.setDraft((prev) => `${prev}@src/app.ts `))
    expect(result.current.draft).toBe('see @src/app.ts ')
    act(() => {
      vi.advanceTimersByTime(300)
    })
    expect(stored()).toEqual({ s1: 'see @src/app.ts ' })
  })

  it('does not write when the session id is empty', () => {
    vi.useFakeTimers()
    const { result, unmount } = renderHook(() => useDrafts(''))
    act(() => result.current.setDraft('ephemeral'))
    act(() => {
      vi.advanceTimersByTime(300)
    })
    expect(localStorage.getItem(DRAFTS_STORAGE_KEY)).toBeNull()
    unmount()
    expect(localStorage.getItem(DRAFTS_STORAGE_KEY)).toBeNull()
  })
})
