import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  BOT_PALETTE_NAMES,
  BOT_SHAPES,
  BOT_SHAPE_DEFS,
  characterFromSeed,
  characterOf,
  paletteHasDarkEyes,
  randomCharacter,
  seedFraction,
} from './bot-character'

const tokensCss = readFileSync(join(import.meta.dirname, 'tokens.css'), 'utf8')

describe('characterFromSeed', () => {
  it('draws the same bot for the same seed', () => {
    expect(characterFromSeed('bot_1')).toEqual(characterFromSeed('bot_1'))
    expect(characterFromSeed('')).toEqual(characterFromSeed(''))
  })

  it('spreads neighbouring ids across every shape and colour', () => {
    const seen = new Set<string>()
    const shapes = new Map<string, number>()
    const palettes = new Map<number, number>()
    for (let index = 0; index < 1200; index += 1) {
      const look = characterFromSeed(`bot_${index}`)
      seen.add(`${look.shape}/${look.palette}`)
      shapes.set(look.shape, (shapes.get(look.shape) ?? 0) + 1)
      palettes.set(look.palette, (palettes.get(look.palette) ?? 0) + 1)
    }
    expect(seen.size).toBe(BOT_SHAPES.length * BOT_PALETTE_NAMES.length)
    // 200 expected per shape and 120 per palette; none should be starved or crowded.
    for (const count of shapes.values()) expect(count).toBeGreaterThan(150)
    for (const count of palettes.values()) expect(count).toBeGreaterThan(80)
  })

  it('gives consecutive ids different looks', () => {
    const a = characterFromSeed('bot_a')
    const b = characterFromSeed('bot_b')
    expect(`${a.shape}/${a.palette}`).not.toBe(`${b.shape}/${b.palette}`)
  })
})

describe('seedFraction', () => {
  it('is stable and stays in [0, 1)', () => {
    for (const seed of ['', 'r1', '«r2»', 'bot_99']) {
      const value = seedFraction(seed)
      expect(value).toBe(seedFraction(seed))
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThan(1)
    }
  })
})

describe('randomCharacter', () => {
  it('maps the random source onto a shape and a palette', () => {
    const rolls = [0, 0.999]
    expect(randomCharacter(() => rolls.shift() ?? 0)).toEqual({ shape: 'drop', palette: 9 })
    const high = [0.999, 0]
    expect(randomCharacter(() => high.shift() ?? 0)).toEqual({ shape: 'pebble', palette: 0 })
  })

  it('stays valid for any source, including one that returns 1', () => {
    const look = randomCharacter(() => 1)
    expect(BOT_SHAPES).toContain(look.shape)
    expect(look.palette).toBeGreaterThanOrEqual(0)
    expect(look.palette).toBeLessThan(BOT_PALETTE_NAMES.length)
  })
})

describe('characterOf', () => {
  it('uses the saved character when there is one', () => {
    expect(characterOf({ id: 'bot_1', character: { shape: 'wisp', palette: 3 } })).toEqual({
      shape: 'wisp',
      palette: 3,
    })
  })

  it('falls back to the id-derived look for bots made before characters', () => {
    expect(characterOf({ id: 'bot_1' })).toEqual(characterFromSeed('bot_1'))
  })
})

describe('shape and palette tables', () => {
  it('defines every shape with eyes inside the view box', () => {
    for (const shape of BOT_SHAPES) {
      const def = BOT_SHAPE_DEFS[shape]
      expect(def.d !== undefined || def.circles !== undefined, shape).toBe(true)
      for (const value of def.eyes) {
        expect(value).toBeGreaterThan(0)
        expect(value).toBeLessThan(100)
      }
    }
  })

  it('gives only the pale palettes dark eyes', () => {
    const dark = BOT_PALETTE_NAMES.filter((_, index) => paletteHasDarkEyes(index))
    expect(dark).toEqual(['sand', 'mint'])
  })

  it.each(BOT_PALETTE_NAMES.map((name, index) => [name, index] as const))(
    '%s has every colour token the avatar paints',
    (_name, index) => {
      for (const layer of [
        'top',
        'base',
        'shade',
        'line',
        'light',
        'inner-shadow',
        'inner-glow',
        'bounce',
        'eye',
        'eye-low',
        'floor',
      ]) {
        expect(tokensCss).toMatch(new RegExp(`--ari-bot-${index}-${layer}: oklch\\(`))
      }
    },
  )
})
