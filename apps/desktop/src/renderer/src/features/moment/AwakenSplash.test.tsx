import { render, screen, act } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AwakenSplash, AWAKEN_MAX_MS, AWAKEN_MIN_MS, AWAKEN_OUTRO_MS } from './AwakenSplash'

vi.mock('./awaken-sound', () => ({ playAwakenSound: () => () => undefined }))

const splash = () => screen.getByTestId('awaken-splash')

describe('AwakenSplash', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('renders the brand sequence in the window, not a separate surface', () => {
    render(<AwakenSplash ready={false} onDone={() => undefined} />)
    expect(splash()).toHaveAttribute('aria-label', 'Ari is starting')
    expect(screen.getByText('ARI')).toBeInTheDocument()
    expect(screen.getByText('Agent Development Environment')).toBeInTheDocument()
    // Covers the whole window; the shell mounts underneath it.
    expect(splash()).toHaveClass('ari-awaken')
    expect(splash()).toHaveAttribute('data-outro', 'off')
  })

  it('holds the floor so a fast boot never truncates the animation', () => {
    const onDone = vi.fn()
    render(<AwakenSplash ready={true} onDone={onDone} />)

    act(() => {
      vi.advanceTimersByTime(AWAKEN_MIN_MS - 100)
    })
    expect(onDone).not.toHaveBeenCalled()
    expect(splash()).toHaveAttribute('data-outro', 'off')

    act(() => {
      vi.advanceTimersByTime(100)
    })
    expect(splash()).toHaveAttribute('data-outro', 'on')
    expect(onDone).not.toHaveBeenCalled()

    act(() => {
      vi.advanceTimersByTime(AWAKEN_OUTRO_MS)
    })
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it('waits for the engine past the floor, then hands over once ready', () => {
    const onDone = vi.fn()
    const { rerender } = render(<AwakenSplash ready={false} onDone={onDone} />)

    act(() => {
      vi.advanceTimersByTime(AWAKEN_MIN_MS + 500)
    })
    expect(splash()).toHaveAttribute('data-outro', 'off')
    expect(onDone).not.toHaveBeenCalled()

    rerender(<AwakenSplash ready={true} onDone={onDone} />)
    expect(splash()).toHaveAttribute('data-outro', 'on')

    act(() => {
      vi.advanceTimersByTime(AWAKEN_OUTRO_MS)
    })
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it('lifts at the ceiling so a wedged boot cannot trap the user', () => {
    const onDone = vi.fn()
    render(<AwakenSplash ready={false} onDone={onDone} />)

    // The outro is only scheduled once React commits the expiry, so the
    // handover timer starts after this advance, not during it.
    act(() => {
      vi.advanceTimersByTime(AWAKEN_MAX_MS)
    })
    expect(splash()).toHaveAttribute('data-outro', 'on')
    expect(onDone).not.toHaveBeenCalled()

    act(() => {
      vi.advanceTimersByTime(AWAKEN_OUTRO_MS)
    })
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it('hands over exactly once', () => {
    const onDone = vi.fn()
    const { rerender } = render(<AwakenSplash ready={true} onDone={onDone} />)

    act(() => {
      vi.advanceTimersByTime(AWAKEN_MIN_MS)
    })
    act(() => {
      vi.advanceTimersByTime(AWAKEN_OUTRO_MS)
    })
    expect(onDone).toHaveBeenCalledTimes(1)

    // A later re-render and the ceiling must not fire a second handover.
    rerender(<AwakenSplash ready={true} onDone={onDone} />)
    act(() => {
      vi.advanceTimersByTime(AWAKEN_MAX_MS)
    })
    expect(onDone).toHaveBeenCalledTimes(1)
  })
})
