import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSmoothText } from './use-smooth-text'

const SLAB =
  'The flicker comes from SessionList re-sorting on every settle, even when the order does not change. Each settle hands the list a new array.'

function stubMotion(reduce: boolean): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: reduce && query.includes('reduce'),
    media: query,
  }))
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance'] })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('useSmoothText', () => {
  it('spreads a slab of text over a fraction of a second, cut on word ends', () => {
    stubMotion(false)
    const { result, rerender } = renderHook(({ text }) => useSmoothText(text, true), {
      initialProps: { text: '' },
    })
    rerender({ text: SLAB })
    expect(result.current).toBe('')

    act(() => vi.advanceTimersByTime(80))
    const early = result.current
    expect(early.length).toBeGreaterThan(0)
    expect(early.length).toBeLessThan(SLAB.length)
    expect(SLAB.startsWith(early)).toBe(true)
    expect(SLAB[early.length]).toMatch(/\s/)

    act(() => vi.advanceTimersByTime(600))
    expect(result.current).toBe(SLAB)
  })

  it('shows text it was not asked to pace at once', () => {
    stubMotion(false)
    const { result, rerender } = renderHook(({ text }) => useSmoothText(text, true, false), {
      initialProps: { text: 'Already here.' },
    })
    expect(result.current).toBe('Already here.')
    rerender({ text: `${SLAB}` })
    expect(result.current).toBe(SLAB)
  })

  it('reveals at once when the reader asked for less motion', () => {
    stubMotion(true)
    const { result, rerender } = renderHook(({ text }) => useSmoothText(text, true), {
      initialProps: { text: '' },
    })
    rerender({ text: SLAB })
    act(() => vi.advanceTimersByTime(0))
    expect(result.current).toBe(SLAB)
  })

  it('drains what is left quickly once streaming stops', () => {
    stubMotion(false)
    const { result, rerender } = renderHook(
      ({ text, streaming }) => useSmoothText(text, streaming),
      { initialProps: { text: '', streaming: true } },
    )
    rerender({ text: SLAB, streaming: true })
    act(() => vi.advanceTimersByTime(32))
    rerender({ text: SLAB, streaming: false })
    act(() => vi.advanceTimersByTime(200))
    expect(result.current).toBe(SLAB)
  })
})
