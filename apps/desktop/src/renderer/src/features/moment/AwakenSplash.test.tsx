import { StrictMode } from 'react'
import { render, screen, act, cleanup } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AwakenSplash, AWAKEN_MAX_MS, AWAKEN_MIN_MS, AWAKEN_OUTRO_MS } from './AwakenSplash'

const splash = () => screen.getByTestId('awaken-splash')

describe('AwakenSplash', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('renders the launch screen in the window, not a separate surface', () => {
    const { rerender } = render(<AwakenSplash ready={false} onDone={() => undefined} />)
    expect(splash()).toHaveAttribute('aria-label', 'Ari is starting')
    expect(screen.getByTestId('awaken-word')).toHaveTextContent('Ari.')
    expect(screen.getByText('starting')).toBeInTheDocument()
    rerender(<AwakenSplash ready={true} onDone={() => undefined} />)
    expect(screen.getByText('ready')).toBeInTheDocument()
    expect(splash()).toHaveAttribute('data-ready', 'on')
    // Covers the whole window; the shell mounts underneath it.
    expect(splash()).toHaveClass('ari-awaken')
    expect(splash()).toHaveAttribute('data-outro', 'off')
  })

  it('holds a short floor so a fast boot does not flash the screen', () => {
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

  it.each([
    ['ready', true, AWAKEN_MIN_MS],
    ['ceiling', false, AWAKEN_MAX_MS],
  ] as const)(
    'uses the latest callback without restarting the %s outro',
    (_trigger, ready, startAt) => {
      const originalDone = vi.fn()
      const latestDone = vi.fn()
      const { rerender } = render(<AwakenSplash ready={ready} onDone={originalDone} />)
      act(() => {
        vi.advanceTimersByTime(startAt)
      })
      expect(splash()).toHaveAttribute('data-outro', 'on')

      act(() => {
        vi.advanceTimersByTime(AWAKEN_OUTRO_MS / 2)
      })
      rerender(<AwakenSplash ready={ready} onDone={latestDone} />)
      act(() => {
        vi.advanceTimersByTime(AWAKEN_OUTRO_MS / 2 - 1)
      })
      expect(originalDone).not.toHaveBeenCalled()
      expect(latestDone).not.toHaveBeenCalled()
      act(() => {
        vi.advanceTimersByTime(1)
      })
      expect(originalDone).not.toHaveBeenCalled()
      expect(latestDone).toHaveBeenCalledTimes(1)
      act(() => {
        vi.advanceTimersByTime(AWAKEN_MAX_MS)
      })
      expect(originalDone).not.toHaveBeenCalled()
      expect(latestDone).toHaveBeenCalledTimes(1)
    },
  )

  it('finishes an outro even if the engine loses readiness during the fade', () => {
    const onDone = vi.fn()
    const { rerender } = render(<AwakenSplash ready={true} onDone={onDone} />)
    act(() => {
      vi.advanceTimersByTime(AWAKEN_MIN_MS)
    })
    act(() => {
      vi.advanceTimersByTime(AWAKEN_OUTRO_MS / 2)
    })

    rerender(<AwakenSplash ready={false} onDone={onDone} />)
    expect(splash()).toHaveAttribute('data-outro', 'on')
    act(() => {
      vi.advanceTimersByTime(AWAKEN_OUTRO_MS / 2)
    })
    expect(onDone).toHaveBeenCalledTimes(1)
    rerender(<AwakenSplash ready={true} onDone={onDone} />)
    act(() => {
      vi.advanceTimersByTime(AWAKEN_MAX_MS)
    })
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it('does not cancel an in-progress outro when the ceiling expires', () => {
    const onDone = vi.fn()
    const { rerender } = render(<AwakenSplash ready={false} onDone={onDone} />)
    act(() => {
      vi.advanceTimersByTime(AWAKEN_MAX_MS - AWAKEN_OUTRO_MS / 2)
    })
    rerender(<AwakenSplash ready={true} onDone={onDone} />)
    expect(splash()).toHaveAttribute('data-outro', 'on')

    act(() => {
      vi.advanceTimersByTime(AWAKEN_OUTRO_MS / 2)
    })
    expect(onDone).not.toHaveBeenCalled()
    act(() => {
      vi.advanceTimersByTime(AWAKEN_OUTRO_MS / 2)
    })
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['before readiness', false, 0],
    ['during the outro', true, AWAKEN_MIN_MS],
  ] as const)('clears all timers on unmount %s', (_phase, ready, elapsed) => {
    const onDone = vi.fn()
    const { unmount } = render(<AwakenSplash ready={ready} onDone={onDone} />)
    act(() => {
      vi.advanceTimersByTime(elapsed)
    })
    expect(vi.getTimerCount()).toBeGreaterThan(0)

    unmount()
    expect(vi.getTimerCount()).toBe(0)
    act(() => {
      vi.advanceTimersByTime(AWAKEN_MAX_MS + AWAKEN_OUTRO_MS)
    })
    expect(onDone).not.toHaveBeenCalled()
  })

  it('preserves the floor and hands over once under StrictMode effect replay', () => {
    const onDone = vi.fn()
    render(
      <StrictMode>
        <AwakenSplash ready={true} onDone={onDone} />
      </StrictMode>,
    )
    act(() => {
      vi.advanceTimersByTime(AWAKEN_MIN_MS - 1)
    })
    expect(splash()).toHaveAttribute('data-outro', 'off')
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(splash()).toHaveAttribute('data-outro', 'on')
    act(() => {
      vi.advanceTimersByTime(AWAKEN_OUTRO_MS)
    })
    expect(onDone).toHaveBeenCalledTimes(1)
    act(() => {
      vi.advanceTimersByTime(AWAKEN_MAX_MS)
    })
    expect(onDone).toHaveBeenCalledTimes(1)
  })
})
