import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clockRunning, subscribeTick, TICK_MS, useTickingText } from './shared-clock'

describe('subscribeTick', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('drives every subscriber from one interval and stops when the last leaves', () => {
    const setInterval = vi.spyOn(globalThis, 'setInterval')
    const a = vi.fn()
    const b = vi.fn()
    expect(clockRunning()).toBe(false)

    const stopA = subscribeTick(a)
    const stopB = subscribeTick(b)
    expect(setInterval).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(TICK_MS * 2)
    expect(a).toHaveBeenCalledTimes(2)
    expect(b).toHaveBeenCalledTimes(2)

    stopA()
    expect(clockRunning()).toBe(true)
    vi.advanceTimersByTime(TICK_MS)
    expect(a).toHaveBeenCalledTimes(2)
    expect(b).toHaveBeenCalledTimes(3)

    stopB()
    expect(clockRunning()).toBe(false)
    setInterval.mockRestore()
  })
})

function Readout({ startedAt, onRender }: { startedAt: number; onRender: () => void }) {
  onRender()
  const ref = useTickingText<HTMLSpanElement>(
    (now) => `${Math.floor((now - startedAt) / 1000)}s`,
    startedAt,
  )
  return <span ref={ref}>0s</span>
}

describe('useTickingText', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('repaints its text on each tick without re-rendering', () => {
    const renders = vi.fn()
    const { unmount } = render(<Readout startedAt={Date.now() - 3000} onRender={renders} />)
    expect(screen.getByText('3s')).toBeInTheDocument()

    act(() => {
      vi.advanceTimersByTime(TICK_MS * 2)
    })

    expect(screen.getByText('5s')).toBeInTheDocument()
    expect(renders).toHaveBeenCalledTimes(1)
    unmount()
    expect(clockRunning()).toBe(false)
  })
})
