import type { TeamRoomSummary } from '@ari/contracts/rpc'

/** A settled two-bot room for tests; override whatever the case is about. */
export function roomFixture(overrides: Partial<TeamRoomSummary> = {}): TeamRoomSummary {
  return {
    id: 'room_1',
    title: 'Launch',
    bots: [
      { botId: 'bot_a', name: 'Pixel', emoji: '🎨', sessionId: 'thread_a' },
      { botId: 'bot_b', name: 'Rover', emoji: '🛰️', sessionId: 'thread_b' },
    ],
    leadBotId: null,
    activeBotId: null,
    needsUser: false,
    window: [],
    log: [],
    pending: 0,
    round: null,
    updatedAt: 1,
    ...overrides,
  }
}
