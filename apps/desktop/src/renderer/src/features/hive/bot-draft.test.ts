import { describe, expect, it } from 'vitest'
import type { Bot } from '@ari/contracts/bot'
import { characterFromSeed } from '@ari/ui/bot-character'
import { blankDraft, createFieldsOf, draftFromBot, draftFromStarter, patchOf } from './bot-draft'
import { STARTER_CAST } from './starter-cast'

const BOT: Bot = {
  id: 'bot_1',
  name: 'Pixel',
  emoji: '🎨',
  personaMd: '# Pixel',
  driverKind: 'ari-core',
  modelId: null,
  projectId: 'proj_1',
}

describe('bot drafts', () => {
  it('starts blank with a look from the random source', () => {
    expect(blankDraft(() => 0)).toEqual({
      name: '',
      title: '',
      tagline: '',
      personaMd: '',
      character: { shape: 'drop', palette: 0 },
    })
  })

  it('fills every field from a starter', () => {
    const forge = STARTER_CAST[0]!
    expect(draftFromStarter(forge)).toEqual({
      name: 'Forge',
      title: 'Builder',
      tagline: forge.tagline,
      personaMd: forge.personaMd,
      character: { shape: 'drop', palette: 6 },
    })
  })

  it('opens an old bot with its derived look and an empty title and tagline', () => {
    expect(draftFromBot(BOT)).toEqual({
      name: 'Pixel',
      title: '',
      tagline: '',
      personaMd: '# Pixel',
      character: characterFromSeed('bot_1'),
    })
  })

  it('sends a trimmed name, and a title and tagline only when set', () => {
    const draft = { ...blankDraft(() => 0), name: '  Rover ', title: '  ', tagline: ' Hi. ' }
    expect(createFieldsOf(draft)).toEqual({
      name: 'Rover',
      character: { shape: 'drop', palette: 0 },
      personaMd: '',
      tagline: 'Hi.',
    })
  })
})

describe('patchOf', () => {
  it('is empty for an untouched bot, so an old bot keeps its derived look', () => {
    expect(patchOf(BOT, draftFromBot(BOT))).toEqual({})
  })

  it('carries only what changed', () => {
    const draft = {
      ...draftFromBot(BOT),
      name: ' Pixie ',
      character: { shape: 'wisp', palette: 3 },
    } as const
    expect(patchOf(BOT, draft)).toEqual({ name: 'Pixie', character: { shape: 'wisp', palette: 3 } })
  })

  it('clears a title and tagline with an empty string', () => {
    const titled: Bot = { ...BOT, title: 'Designer', tagline: 'Hello.' }
    expect(patchOf(titled, { ...draftFromBot(titled), title: ' ', tagline: '' })).toEqual({
      title: '',
      tagline: '',
    })
  })
})
