import { describe, expect, it } from 'vitest'
import { captionOverflow } from './caption-overflow'

describe('captionOverflow', () => {
  it('measures how far the window runs past the display edge when maximized', () => {
    // The live geometry of a maximized window on a 1920px-wide display: the
    // window's bounds extend 9px past the display, and DWM pins the native
    // caption buttons to the display edge.
    expect(captionOverflow({ x: 1911, width: 1938 }, { x: 1920, width: 1920 })).toBe(9)
  })

  it('reports zero when the window sits inside the display', () => {
    expect(captionOverflow({ x: 100, width: 800 }, { x: 0, width: 1920 })).toBe(0)
  })

  it('reports zero when the taskbar already keeps the window short of the display edge', () => {
    // Taskbar docked on the right: the maximized window ends 40px inside the
    // display, so the buttons and the DOM both sit flush with the window edge.
    expect(captionOverflow({ x: 100, width: 800 }, { x: 0, width: 1000 })).toBe(0)
  })

  it('compares the right edges even when the display does not start at x=0', () => {
    // Second monitor at x=1920; a window ending at x=3840 does not overflow.
    expect(captionOverflow({ x: 1920, width: 1920 }, { x: 1920, width: 1920 })).toBe(0)
    // …and the same window grown 30px past the display overflows by 30.
    expect(captionOverflow({ x: 1911, width: 1959 }, { x: 1920, width: 1920 })).toBe(30)
  })
})
