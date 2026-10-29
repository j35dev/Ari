/**
 * Hive bot characters: one soft shape in one colour. The shapes and palettes
 * mirror `@ari/contracts/bot` (`botCharacterSchema`), restated here so the UI
 * kit stays free of the contracts package; a desktop test pins the two lists
 * together. Palette colours live in tokens.css as `--ari-bot-<index>-*`.
 */

export const BOT_SHAPES = ['drop', 'cloud', 'pill', 'wisp', 'gumdrop', 'pebble'] as const
export type BotShape = (typeof BOT_SHAPES)[number]

/** Palette names by index, in the order `BotCharacter.palette` counts them. */
export const BOT_PALETTE_NAMES = [
  'slate',
  'apricot',
  'sage',
  'lavender',
  'sand',
  'rose',
  'coral',
  'plum',
  'sky',
  'mint',
] as const

/** A bot's look, structurally identical to the contract's `BotCharacter`. */
export interface BotCharacter {
  shape: BotShape
  palette: number
}

/** How a shape is drawn in the avatar's 100×100 view box. */
export interface BotShapeDef {
  /** The silhouette as one path; absent when `circles` draws it. */
  d?: string
  /** The silhouette as a union of circles `[cx, cy, r]`. */
  circles?: readonly (readonly [number, number, number])[]
  /** Left eye x, right eye x, and the eyes' shared y. */
  eyes: readonly [number, number, number]
  /** Degrees the whole body is turned about (50, 52). */
  rotate?: number
}

export const BOT_SHAPE_DEFS: Readonly<Record<BotShape, BotShapeDef>> = {
  drop: {
    d: 'M58 15C75 19 86 40 84 58C82 76 67 86 50 86C32 86 18 74 18 58C18 41 41 11 58 15Z',
    eyes: [43, 60, 54],
  },
  cloud: {
    circles: [
      [30, 60, 16],
      [46, 45, 19],
      [64, 47, 17],
      [77, 62, 13],
      [52, 66, 19],
      [22, 70, 10],
      [68, 74, 11],
    ],
    eyes: [42, 60, 58],
  },
  pill: { d: 'M30 34H70A18 18 0 0 1 70 70H30A18 18 0 0 1 30 34Z', rotate: -9, eyes: [42, 60, 51] },
  wisp: {
    d: 'M60 22C78 22 87 38 85 55C83 71 71 81 57 81C47 81 41 77 33 79C25 81 17 85 12 79C8 74 15 69 22 67C30 64 34 59 34 49C34 33 44 22 60 22Z',
    eyes: [53, 69, 47],
  },
  gumdrop: {
    d: 'M50 19C61 19 71 35 80 54C88 70 82 84 66 86H34C18 84 12 70 20 54C29 35 39 19 50 19Z',
    eyes: [42, 58, 59],
  },
  pebble: {
    d: 'M31 27C45 20 66 21 76 31C86 41 86 64 78 76C70 86 42 88 30 80C18 72 16 51 20 41C22 33 25 30 31 27Z',
    eyes: [42, 59, 54],
  },
}

/** Pale palettes (sand, mint) wear dark eyes; the glowing white ones would vanish. */
const DARK_EYED = new Set([4, 9])

/** True when the palette's eyes are dark rather than glowing. */
export function paletteHasDarkEyes(palette: number): boolean {
  return DARK_EYED.has(palette)
}

/** Clamps any number onto a valid palette index. */
function paletteIndex(value: number): number {
  const count = BOT_PALETTE_NAMES.length
  return ((Math.trunc(value) % count) + count) % count
}

/** FNV-1a, then a murmur-style finaliser so neighbouring ids land far apart. */
function hash(seed: string): number {
  let h = 0x811c9dc5
  for (let index = 0; index < seed.length; index += 1) {
    h ^= seed.charCodeAt(index)
    h = Math.imul(h, 0x01000193)
  }
  h ^= h >>> 16
  h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  h ^= h >>> 16
  return h >>> 0
}

/** A stable fraction in [0, 1) for a seed; staggers per-avatar animation phases. */
export function seedFraction(seed: string): number {
  return hash(seed) / 0x1_0000_0000
}

/** A stable look for a seed (a bot id): the same seed always draws the same bot. */
export function characterFromSeed(seed: string): BotCharacter {
  const h = hash(seed)
  const combos = BOT_SHAPES.length * BOT_PALETTE_NAMES.length
  const pick = h % combos
  return {
    shape: BOT_SHAPES[pick % BOT_SHAPES.length]!,
    palette: Math.floor(pick / BOT_SHAPES.length),
  }
}

/** A fresh look for the Shuffle button. `random` returns [0, 1), like `Math.random`. */
export function randomCharacter(random: () => number = Math.random): BotCharacter {
  return {
    shape: BOT_SHAPES[Math.floor(random() * BOT_SHAPES.length) % BOT_SHAPES.length]!,
    palette: paletteIndex(Math.floor(random() * BOT_PALETTE_NAMES.length)),
  }
}

/** The look a bot wears: its saved character, else one derived from its id. */
export function characterOf(bot: { id: string; character?: BotCharacter }): BotCharacter {
  if (bot.character === undefined) return characterFromSeed(bot.id)
  return { shape: bot.character.shape, palette: paletteIndex(bot.character.palette) }
}
