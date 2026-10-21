import { describe, expect, it } from 'vitest'
import { AT_BOTTOM_PX, REENGAGE_BAND_PX, pinnedAfterScroll } from './transcript-pin'

describe('pinnedAfterScroll', () => {
  it('stays pinned through content growth that is not an upward scroll', () => {
    expect(
      pinnedAfterScroll({
        wasPinned: true,
        distanceFromBottom: 0,
        scrolledDown: false,
        scrolledUp: false,
      }),
    ).toBe(true)
    expect(
      pinnedAfterScroll({
        wasPinned: true,
        distanceFromBottom: 4000,
        scrolledDown: false,
        scrolledUp: false,
      }),
    ).toBe(true)
  })

  it('unpins when the reader scrolls up away from the tail', () => {
    expect(
      pinnedAfterScroll({
        wasPinned: true,
        distanceFromBottom: AT_BOTTOM_PX,
        scrolledDown: false,
        scrolledUp: true,
      }),
    ).toBe(true)
    expect(
      pinnedAfterScroll({
        wasPinned: true,
        distanceFromBottom: 8,
        scrolledDown: false,
        scrolledUp: true,
      }),
    ).toBe(false)
  })

  it('does not re-pin a wheel-up that is still inside the re-engage band', () => {
    expect(
      pinnedAfterScroll({
        wasPinned: false,
        distanceFromBottom: 20,
        scrolledDown: false,
        scrolledUp: true,
      }),
    ).toBe(false)
    expect(
      pinnedAfterScroll({
        wasPinned: false,
        distanceFromBottom: REENGAGE_BAND_PX,
        scrolledDown: false,
        scrolledUp: true,
      }),
    ).toBe(false)
  })

  it('re-engages when scrolling down into the band', () => {
    expect(
      pinnedAfterScroll({
        wasPinned: false,
        distanceFromBottom: 40,
        scrolledDown: true,
        scrolledUp: false,
      }),
    ).toBe(true)
    expect(
      pinnedAfterScroll({
        wasPinned: false,
        distanceFromBottom: REENGAGE_BAND_PX + 1,
        scrolledDown: true,
        scrolledUp: false,
      }),
    ).toBe(false)
  })
})
