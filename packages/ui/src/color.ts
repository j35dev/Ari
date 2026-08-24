/**
 * Minimal oklch color math used by the theme engine and its contrast tests.
 * Only the subset Ari's tokens use is supported: `oklch(L C H)` with an
 * optional `/ <alpha>` (number or percentage). Values are converted through
 * Oklab → linear sRGB so WCAG relative luminance can be computed without a
 * browser.
 */

export interface Oklch {
  /** Perceptual lightness, 0..1. */
  l: number
  /** Chroma, 0..~0.4. */
  c: number
  /** Hue angle in degrees. */
  h: number
  /** Alpha, 0..1 (1 when the literal omits it). */
  alpha: number
}

const OKLCH = /^oklch\(\s*([\d.]+%?)\s+([\d.]+%?)\s+([\d.]+)(?:deg)?\s*(?:\/\s*([\d.]+%?)\s*)?\)$/i

function scalar(raw: string, percentBase: number): number {
  return raw.endsWith('%') ? Number(raw.slice(0, -1)) / 100 * percentBase : Number(raw)
}

/** Parses an `oklch(...)` literal; returns null for anything else. */
export function parseOklch(value: string): Oklch | null {
  const match = OKLCH.exec(value.trim())
  if (!match) return null
  const [, l, c, h, alpha] = match
  if (l === undefined || c === undefined || h === undefined) return null
  return {
    l: scalar(l, 1),
    c: scalar(c, 0.4),
    h: Number(h),
    alpha: alpha === undefined ? 1 : scalar(alpha, 1),
  }
}

function linearFromOklab(l: number, a: number, b: number): [number, number, number] {
  const lp = l + 0.3963377774 * a + 0.2158037573 * b
  const mp = l - 0.1055613458 * a - 0.0638541728 * b
  const sp = l - 0.0894841775 * a - 1.291485548 * b
  const lc = lp * lp * lp
  const mc = mp * mp * mp
  const sc = sp * sp * sp
  return [
    4.0767416621 * lc - 3.3077115913 * mc + 0.2309699292 * sc,
    -1.2684380046 * lc + 2.6097574011 * mc - 0.3413193965 * sc,
    -0.0041960863 * lc - 0.7034186147 * mc + 1.707614701 * sc,
  ]
}

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n)

/** Linear-light sRGB triplet (gamut-clipped) for an oklch color. */
export function toLinearSrgb(color: Oklch): [number, number, number] {
  const hueRad = (color.h * Math.PI) / 180
  const [r, g, b] = linearFromOklab(
    color.l,
    color.c * Math.cos(hueRad),
    color.c * Math.sin(hueRad),
  )
  return [clamp01(r), clamp01(g), clamp01(b)]
}

const HEX = (n: number): string =>
  Math.round(clamp01(n) * 255)
    .toString(16)
    .padStart(2, '0')

/** sRGB gamma transfer (linear → encoded). */
function encodeSrgb(channel: number): number {
  return channel <= 0.0031308 ? channel * 12.92 : 1.055 * Math.pow(channel, 1 / 2.4) - 0.055
}

/**
 * Converts an `oklch(...)` literal to `#rrggbb`. Electron's `backgroundColor`
 * and `titleBarOverlay.symbolColor` only accept hex, so theme colors have to
 * be flattened before they cross into the main process. Alpha is dropped: the
 * window backdrop must be opaque for non-glass themes.
 * Returns null when the literal cannot be parsed.
 */
export function oklchToHex(value: string): string | null {
  const color = parseOklch(value)
  if (!color) return null
  const [r, g, b] = toLinearSrgb(color)
  return `#${HEX(encodeSrgb(r))}${HEX(encodeSrgb(g))}${HEX(encodeSrgb(b))}`
}

/** WCAG 2.x relative luminance of an oklch color (alpha ignored). */
export function relativeLuminance(color: Oklch): number {
  const [r, g, b] = toLinearSrgb(color)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/**
 * WCAG contrast ratio between two opaque oklch literals.
 * Throws on unparseable input so tests fail loudly instead of silently passing.
 */
export function contrastRatio(foreground: string, background: string): number {
  const fg = parseOklch(foreground)
  const bg = parseOklch(background)
  if (!fg || !bg) throw new Error(`contrastRatio: unparseable color (${foreground}, ${background})`)
  const a = relativeLuminance(fg)
  const b = relativeLuminance(bg)
  const lighter = Math.max(a, b)
  const darker = Math.min(a, b)
  return (lighter + 0.05) / (darker + 0.05)
}
