import { describe, expect, it } from 'vitest'
import { AT_BOTTOM_PX, REENGAGE_BAND_PX, pinnedAfterScroll } from './transcript-pin'

describe('pinnedAfterScroll', () => {
  it('stays pinned only while still on the painted tail', () => {
    expect(
      pinnedAfterScroll({ wasPinned: true, distanceFromBottom: 0, scrolledDown: false }),
    ).toBe(true)
    expect(
      pinnedAfterScroll({
        wasPinned: true,
        distanceFromBottom: AT_BOTTOM_PX,
        scrolledDown: false,
      }),
    ).toBe(true)
    expect(
      pinnedAfterScroll({ wasPinned: true, distanceFromBottom: 8, scrolledDown: false }),
    ).toBe(false)
  })

  it('does not re-pin a wheel-up that is still inside the re-engage band', () => {
    expect(
      pinnedAfterScroll({
        wasPinned: false,
        distanceFromBottom: 20,
        scrolledDown: false,
      }),
    ).toBe(false)
    expect(
      pinnedAfterScroll({
        wasPinned: false,
        distanceFromBottom: REENGAGE_BAND_PX,
        scrolledDown: false,
      }),
    ).toBe(false)
  })

  it('re-engages when scrolling down into the band', () => {
    expect(
      pinnedAfterScroll({
        wasPinned: false,
        distanceFromBottom: 40,
        scrolledDown: true,
      }),
    ).toBe(true)
    expect(
      pinnedAfterScroll({
        wasPinned: false,
        distanceFromBottom: REENGAGE_BAND_PX + 1,
        scrolledDown: true,
      }),
    ).toBe(false)
  })
})
