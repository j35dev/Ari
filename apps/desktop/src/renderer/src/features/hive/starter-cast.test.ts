import { describe, expect, it } from 'vitest'
import {
  BOT_CHARACTER_PALETTES,
  botCharacterSchema,
  botCreateParamsSchema,
} from '@ari/contracts/bot'
import { BOT_PALETTE_NAMES, BOT_SHAPES } from '@ari/ui/bot-character'
import { STARTER_CAST, starterById } from './starter-cast'

describe('STARTER_CAST', () => {
  it('is the eight starters, each with its hand-picked look', () => {
    expect(
      STARTER_CAST.map((starter) => [
        starter.name,
        starter.title,
        starter.character.shape,
        BOT_PALETTE_NAMES[starter.character.palette],
      ]),
    ).toEqual([
      ['Forge', 'Builder', 'drop', 'coral'],
      ['Lint', 'Reviewer', 'pill', 'sage'],
      ['Scout', 'Researcher', 'cloud', 'apricot'],
      ['Pixel', 'Designer', 'pebble', 'rose'],
      ['Sift', 'Triage', 'wisp', 'lavender'],
      ['Watch', 'Ops', 'gumdrop', 'sand'],
      ['Scribe', 'Writer', 'drop', 'sky'],
      ['Gist', 'Curator', 'cloud', 'mint'],
    ])
  })

  it.each(STARTER_CAST)('$name is a bot the host accepts', (starter) => {
    const parsed = botCreateParamsSchema.safeParse({
      name: starter.name,
      emoji: '🤖',
      character: starter.character,
      title: starter.title,
      tagline: starter.tagline,
      personaMd: starter.personaMd,
      driverKind: 'ari-core',
      modelId: null,
      projectId: 'proj_1',
    })
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true)
  })

  it.each(STARTER_CAST)(
    '$name has a persona of two to five paragraphs in its own name',
    (starter) => {
      const paragraphs = starter.personaMd.split(/\n\s*\n/).filter((part) => part.trim().length > 0)
      expect(paragraphs.length).toBeGreaterThanOrEqual(2)
      expect(paragraphs.length).toBeLessThanOrEqual(5)
      expect(starter.personaMd).toContain(`You are ${starter.name}`)
    },
  )

  it('gives every starter its own id and look', () => {
    expect(new Set(STARTER_CAST.map((starter) => starter.id)).size).toBe(STARTER_CAST.length)
    // More starters than shapes, so a look is the shape and palette pair:
    // no two cast members share one.
    expect(
      new Set(
        STARTER_CAST.map((starter) => `${starter.character.shape}:${starter.character.palette}`),
      ).size,
    ).toBe(STARTER_CAST.length)
    expect(starterById('lint')?.name).toBe('Lint')
    expect(starterById('nobody')).toBeUndefined()
  })
})

describe('bot looks across the contract and the UI kit', () => {
  it('names the same shapes and palette count on both sides', () => {
    expect(botCharacterSchema.shape.shape.options).toEqual([...BOT_SHAPES])
    expect(BOT_PALETTE_NAMES).toHaveLength(BOT_CHARACTER_PALETTES)
  })
})
