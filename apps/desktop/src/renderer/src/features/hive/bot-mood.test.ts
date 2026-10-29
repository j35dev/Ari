import { describe, expect, it } from 'vitest'
import type { SessionSummary } from '@ari/contracts/rpc'
import { ASLEEP_AFTER_MS, botMoodOf, roomMoodsOf } from './bot-mood'
import { roomFixture } from './room-fixture'

const NOW = 10 * ASLEEP_AFTER_MS

const SESSION: SessionSummary = {
  id: 'sess_1',
  projectId: 'proj_1',
  title: 'Pixel',
  updatedAt: NOW - 1000,
  messageCount: 4,
}

describe('botMoodOf', () => {
  it('works while a turn runs', () => {
    expect(botMoodOf({ phase: 'working', startedAt: 1 }, SESSION, NOW)).toBe('working')
  })

  it('needs the person while a turn waits on an approval or an answer', () => {
    for (const pauseReason of ['approval', 'input'] as const) {
      expect(botMoodOf({ phase: 'paused', startedAt: 1, pauseReason }, SESSION, NOW)).toBe(
        'needs-you',
      )
    }
  })

  it('shows a failed turn', () => {
    expect(botMoodOf({ phase: 'error', startedAt: null, settledAt: 1 }, SESSION, NOW)).toBe('error')
  })

  it('idles once a turn is done, and with no activity at all', () => {
    expect(botMoodOf({ phase: 'done', startedAt: null, settledAt: 1 }, SESSION, NOW)).toBe('idle')
    expect(botMoodOf(undefined, SESSION, NOW)).toBe('idle')
    expect(botMoodOf(undefined, undefined, NOW)).toBe('idle')
  })

  it('falls asleep after hours without a message', () => {
    const quiet = { ...SESSION, updatedAt: NOW - ASLEEP_AFTER_MS - 1 }
    expect(botMoodOf(undefined, quiet, NOW)).toBe('asleep')
    expect(botMoodOf(undefined, { ...quiet, updatedAt: NOW - ASLEEP_AFTER_MS }, NOW)).toBe('idle')
    // A bot that has never spoken is new, not asleep.
    expect(botMoodOf(undefined, { ...quiet, messageCount: 0 }, NOW)).toBe('idle')
    // Live activity wakes it.
    expect(botMoodOf({ phase: 'working', startedAt: 1 }, quiet, NOW)).toBe('working')
  })
})

describe('roomMoodsOf', () => {
  it('idles everyone in a settled room', () => {
    const moodOf = roomMoodsOf(roomFixture())
    expect(moodOf('bot_a')).toBe('idle')
    expect(moodOf('bot_b')).toBe('idle')
  })

  it('shows who the round waits on as replying', () => {
    const moodOf = roomMoodsOf(
      roomFixture({
        round: { rounds: 1, messages: 0, followUps: 0, awaiting: ['bot_b', 'bot_a'], passed: [] },
      }),
    )
    expect(moodOf('bot_b')).toBe('replying')
    expect(moodOf('bot_a')).toBe('idle')
  })

  it('shows the bot that asked for the person', () => {
    const moodOf = roomMoodsOf(
      roomFixture({
        needsUser: true,
        log: [
          { id: 'e1', botId: 'bot_a', text: '@user which one?', at: 1 },
          { id: 'e2', botId: 'bot_b', text: 'Agreed.', at: 2 },
        ],
      }),
    )
    expect(moodOf('bot_a')).toBe('needs-you')
    expect(moodOf('bot_b')).toBe('idle')
  })
})
