/** 3×3 iris-tile helpers. Pattern is hashed from a project id; hue from colorIndex. */

/** Perimeter walk of the 3×3; the center cell stays dim while running. */
export const IRIS_RING = [0, 1, 2, 5, 8, 7, 6, 3] as const

export const IRIS_HUE_BASE = 277
export const IRIS_HUE_STEP = 40
export const IRIS_COLOR_SLOTS = 8

const CELL_COUNT = 9
const MIN_LIT = 3
const MAX_LIT = 5

function fnv1a(seed: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

function mix(hash: number): number {
  let next = hash
  next = Math.imul(next ^ (next >>> 16), 0x7feb9d81)
  next = Math.imul(next ^ (next >>> 13), 0x846ca68b)
  return (next ^ (next >>> 16)) >>> 0
}

/** Hue angle in degrees for a `colorIndex` slot (0–7). */
export function irisHue(colorIndex = 0): number {
  const slot = ((Math.trunc(colorIndex) % IRIS_COLOR_SLOTS) + IRIS_COLOR_SLOTS) % IRIS_COLOR_SLOTS
  return IRIS_HUE_BASE + slot * IRIS_HUE_STEP
}

/**
 * Nine-cell constellation for `seed`. Always 3–5 lit cells so an idle tile
 * cannot be mistaken for the running ring (eight perimeter cells). Empty seed
 * yields a dark tile — the letter fallback is the component's job.
 */
export function irisPattern(seed: string): readonly boolean[] {
  const cells = Array.from({ length: CELL_COUNT }, () => false)
  if (seed.length === 0) return cells

  let hash = fnv1a(seed)
  const litCount = MIN_LIT + (hash % (MAX_LIT - MIN_LIT + 1))
  const order = Array.from({ length: CELL_COUNT }, (_, i) => i)
  for (let i = CELL_COUNT - 1; i > 0; i--) {
    hash = mix(hash)
    const j = hash % (i + 1)
    const current = order[i]!
    order[i] = order[j]!
    order[j] = current
  }
  for (let i = 0; i < litCount; i++) cells[order[i]!] = true
  return cells
}

/** Single-character fallback when a seed cannot be derived. */
export function irisLetter(name: string): string {
  const trimmed = name.trim()
  if (trimmed.length === 0) return '?'
  return trimmed[0]!.toLocaleUpperCase()
}
