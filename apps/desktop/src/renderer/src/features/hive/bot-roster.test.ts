import { describe, expect, it } from 'vitest'
import type { Bot } from '@ari/contracts/bot'
import type { SessionSummary } from '@ari/contracts/rpc'
import { botSubtitle, isBotSession, mainSessionOf, previewOf, rosterOf } from './bot-roster'

const bot = (overrides: Partial<Bot> = {}): Bot => ({
  id: 'bot_1',
  name: 'Pixel',
  emoji: '🎨',
  personaMd: '# Pixel',
  driverKind: 'ari-core',
  modelId: null,
  projectId: 'proj_1',
  ...overrides,
})

const session = (overrides: Partial<SessionSummary> = {}): SessionSummary => ({
  id: 'sess_1',
  projectId: 'proj_1',
  title: 'Pixel',
  updatedAt: 2000,
  messageCount: 2,
  ...overrides,
})

describe('rosterOf', () => {
  it('drops hidden bots but keeps the rest in store order', () => {
    const listed = rosterOf([
      bot({ id: 'bot_1', name: 'Pixel' }),
      bot({ id: 'bot_2', name: 'Scout', hidden: true }),
      bot({ id: 'bot_3', name: 'Forge' }),
    ])
    expect(listed.map((entry) => entry.name)).toEqual(['Pixel', 'Forge'])
  })
})

describe('mainSessionOf', () => {
  it('resolves the session the row opens', () => {
    const found = mainSessionOf(bot({ mainSessionId: 'sess_1' }), [session()])
    expect(found?.id).toBe('sess_1')
  })

  it('reports nothing for a bot whose pointer or session is missing', () => {
    expect(mainSessionOf(bot(), [session()])).toBeUndefined()
    expect(mainSessionOf(bot({ mainSessionId: 'sess_gone' }), [session()])).toBeUndefined()
  })
})

describe('previewOf', () => {
  it('collapses a multi-line preview onto one line', () => {
    expect(previewOf(session({ lastMessagePreview: 'Read  the file\nand fixed it.' }))).toBe(
      'Read the file and fixed it.',
    )
  })

  it('treats a missing, empty or blank preview as nothing to show', () => {
    expect(previewOf(undefined)).toBeNull()
    expect(previewOf(session())).toBeNull()
    expect(previewOf(session({ lastMessagePreview: '   ' }))).toBeNull()
  })
})

describe('botSubtitle', () => {
  it('prefers what the bot said', () => {
    expect(
      botSubtitle(bot({ mainSessionId: 'sess_1' }), session({ lastMessagePreview: 'Done' })),
    ).toBe('Done')
  })

  it('distinguishes a session with no messages from a bot with no session', () => {
    expect(botSubtitle(bot({ mainSessionId: 'sess_1' }), session())).toBe('No messages yet')
    expect(botSubtitle(bot(), undefined)).toBe('No session yet')
  })
})

describe('isBotSession', () => {
  it('tells a bot-owned session from an ordinary one', () => {
    expect(isBotSession({ id: 'sess_1', botId: 'bot_1' })).toBe(true)
    expect(isBotSession({ id: 'sess_1' })).toBe(false)
    expect(isBotSession({ id: 'sess_1', botId: null })).toBe(false)
  })
})
