/**
 * A maximized window on Windows extends past the visible display edge by its
 * frame thickness, and the native titlebar-overlay caption buttons are pinned
 * to that display edge, not to the window's bounds. The renderer's titlebar
 * reserves the buttons' own width flush with the window edge; this helper
 * measures the extra distance the window's right edge runs past the display
 * so the reservation can cover the gap.
 */

/** The fields of a bounds rectangle that the overflow depends on. */
export interface CaptionBounds {
  x: number
  width: number
}

/**
 * How far the window's right edge extends past the display's right edge,
 * clamped at zero. Zero when the window sits inside the display (or when the
 * taskbar already keeps the maximized window short of the display edge).
 */
export function captionOverflow(
  windowBounds: CaptionBounds,
  displayBounds: CaptionBounds,
): number {
  return Math.max(0, windowBounds.x + windowBounds.width - displayBounds.x - displayBounds.width)
}
