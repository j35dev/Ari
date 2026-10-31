import { beforeEach, describe, expect, it, vi } from 'vitest'
import { botSeenAt, botUnread, forgetSeenBots, markBotSeen, resetSeenBots } from './bot-unread'

beforeEach(() => {
  resetSeenBots()
})

describe('bot unread', () => {
  it('answers no-unread before the first visit', () => {
    expect(botSeenAt('bot_1')).toBeNull()
    expect(botUnread('bot_1', 5_000)).toBe(false)
  })

  it('flags news written after a visit until it is marked seen again', () => {
    markBotSeen('bot_1')
    const visitedAt = botSeenAt('bot_1') as number
    expect(botUnread('bot_1', visitedAt)).toBe(false)
    expect(botUnread('bot_1', visitedAt + 1)).toBe(true)
    vi.useFakeTimers({ now: visitedAt + 10 })
    markBotSeen('bot_1')
    vi.useRealTimers()
    expect(botUnread('bot_1', visitedAt + 9)).toBe(false)
    expect(botUnread('bot_1', visitedAt + 11)).toBe(true)
  })

  it('keeps the visit record across a reload', () => {
    markBotSeen('bot_1')
    const visitedAt = botSeenAt('bot_1') as number
    // A reload drops the in-memory cache; localStorage carries the visit.
    forgetSeenBots()
    expect(botUnread('bot_1', visitedAt + 1)).toBe(true)
    expect(botSeenAt('bot_1')).toBe(visitedAt)
  })

  it('never flags a bot without a session time', () => {
    markBotSeen('bot_1')
    expect(botUnread('bot_1', undefined)).toBe(false)
  })
})
