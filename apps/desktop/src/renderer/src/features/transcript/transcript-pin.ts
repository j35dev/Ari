/** Distance from the painted bottom that re-pins after the reader has left. */
export const REENGAGE_BAND_PX = 70

/** Still treated as the tail while stick-to-bottom is engaged. */
export const AT_BOTTOM_PX = 1

/**
 * Stick-to-bottom pin after a scroll sample.
 *
 * Wheel-up interrupts immediately: once unpinned, staying inside the 70px
 * band must not re-pin or measurement-driven stick-to-bottom yanks the
 * viewport back and eats the rest of the wheel gesture. Re-engage only
 * when the reader scrolls *toward* the tail and lands inside the band
 * (or hits the true bottom).
 *
 * While pinned, content growth and layout resets (session switch, a
 * `display:none` pane coming back) must not unpin — those jump the
 * distance-from-bottom without the reader moving up. Unpin only on an
 * actual upward scroll away from the tail.
 */
export function pinnedAfterScroll(input: {
  wasPinned: boolean
  distanceFromBottom: number
  scrolledDown: boolean
  scrolledUp: boolean
}): boolean {
  if (input.wasPinned) {
    if (!input.scrolledUp) return true
    return input.distanceFromBottom <= AT_BOTTOM_PX
  }
  return input.scrolledDown && input.distanceFromBottom <= REENGAGE_BAND_PX
}
