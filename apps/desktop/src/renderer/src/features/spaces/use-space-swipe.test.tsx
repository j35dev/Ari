import { fireEvent, render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import {
  createSwipeDetector,
  hasHorizontalScroller,
  SWIPE_THRESHOLD,
  useSpaceSwipe,
} from './use-space-swipe'

describe('createSwipeDetector', () => {
  it('fires next for a rightward scroll and previous for a leftward one', () => {
    expect(createSwipeDetector().feed({ deltaX: SWIPE_THRESHOLD + 10, deltaY: 0, at: 1000 })).toBe(
      1,
    )
    expect(
      createSwipeDetector().feed({ deltaX: -(SWIPE_THRESHOLD + 10), deltaY: 0, at: 1000 }),
    ).toBe(-1)
  })

  it('accumulates across samples before it fires', () => {
    const detector = createSwipeDetector()
    expect(detector.feed({ deltaX: 60, deltaY: 0, at: 1000 })).toBeNull()
    expect(detector.feed({ deltaX: 60, deltaY: 0, at: 1010 })).toBe(1)
  })

  it('ignores a mostly-vertical gesture', () => {
    const detector = createSwipeDetector()
    expect(detector.feed({ deltaX: 200, deltaY: 400, at: 1000 })).toBeNull()
    expect(detector.feed({ deltaX: 0, deltaY: 400, at: 1010 })).toBeNull()
  })

  it('forgets a gesture once the fingers pause', () => {
    const detector = createSwipeDetector({ idleMs: 100 })
    expect(detector.feed({ deltaX: 80, deltaY: 0, at: 1000 })).toBeNull()
    // A long pause — a new gesture — must not inherit the earlier travel.
    expect(detector.feed({ deltaX: 80, deltaY: 0, at: 1500 })).toBeNull()
  })

  it('swallows the momentum tail after a switch', () => {
    const detector = createSwipeDetector({ threshold: 100, cooldownMs: 400 })
    expect(detector.feed({ deltaX: 150, deltaY: 0, at: 1000 })).toBe(1)
    expect(detector.feed({ deltaX: 300, deltaY: 0, at: 1100 })).toBeNull()
    expect(detector.feed({ deltaX: 300, deltaY: 0, at: 1600 })).toBe(1)
  })

  it('resets on demand', () => {
    const detector = createSwipeDetector()
    detector.feed({ deltaX: 100, deltaY: 0, at: 1000 })
    detector.reset()
    expect(detector.feed({ deltaX: 100, deltaY: 0, at: 1010 })).toBeNull()
  })
})

describe('hasHorizontalScroller', () => {
  it('is false without a sideways-scrollable ancestor', () => {
    const plain = document.createElement('div')
    document.body.append(plain)
    expect(hasHorizontalScroller(plain)).toBe(false)
    plain.remove()
  })

  it('is true inside an element that can scroll sideways', () => {
    const scroller = document.createElement('div')
    scroller.style.overflowX = 'auto'
    const child = document.createElement('span')
    scroller.append(child)
    document.body.append(scroller)
    Object.defineProperty(scroller, 'scrollWidth', { value: 300, configurable: true })
    Object.defineProperty(scroller, 'clientWidth', { value: 100, configurable: true })

    expect(hasHorizontalScroller(child)).toBe(true)
    scroller.remove()
  })
})

describe('useSpaceSwipe', () => {
  it('switches on a horizontal swipe past the threshold', () => {
    const onSwipe = vi.fn()
    render(<Probe onSwipe={onSwipe} />)

    fireEvent.wheel(window, { deltaX: SWIPE_THRESHOLD + 40, deltaY: 0 })
    expect(onSwipe).toHaveBeenCalledWith(1)
  })

  it('does nothing while disabled', () => {
    const onSwipe = vi.fn()
    render(<Probe onSwipe={onSwipe} enabled={false} />)

    fireEvent.wheel(window, { deltaX: SWIPE_THRESHOLD + 40, deltaY: 0 })
    expect(onSwipe).not.toHaveBeenCalled()
  })

  it('leaves a swipe over a horizontal scroller to the scroller', () => {
    const onSwipe = vi.fn()
    render(<Probe onSwipe={onSwipe} />)
    const scroller = document.createElement('div')
    scroller.style.overflowX = 'auto'
    document.body.append(scroller)
    Object.defineProperty(scroller, 'scrollWidth', { value: 400, configurable: true })
    Object.defineProperty(scroller, 'clientWidth', { value: 100, configurable: true })

    fireEvent.wheel(scroller, { deltaX: SWIPE_THRESHOLD + 40, deltaY: 0 })
    expect(onSwipe).not.toHaveBeenCalled()
    scroller.remove()
  })
})

/** The hook attaches to the window, so the probe only has to mount it. */
function Probe({
  onSwipe,
  enabled = true,
}: {
  onSwipe: (direction: -1 | 1) => void
  enabled?: boolean
}) {
  useSpaceSwipe({ onSwipe, enabled })
  return <div />
}
