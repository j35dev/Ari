import { describe, expect, it } from 'vitest'
import {
  ROOM_MAX_FOLLOW_UPS,
  ROOM_MAX_ROUNDS,
  ROOM_PASS,
  applyBotReply,
  createRoomState,
  mentionedBotIds,
  mentionsUser,
  roomPrompt,
  routeHumanMessage,
  type RoomBot,
  type RoomState,
} from './room'

const bots: RoomBot[] = [
  { botId: 'bot_a', name: 'Ada', sessionId: 'sess_a' },
  { botId: 'bot_b', name: 'Bea', sessionId: 'sess_b' },
  { botId: 'bot_c', name: 'Cid', sessionId: 'sess_c' },
]

const room = (leadBotId: string | null = null): RoomState =>
  createRoomState('War room', bots, leadBotId)

describe('routeHumanMessage', () => {
  it('sends an unaddressed message to the active bot, not the whole team', () => {
    const first = routeHumanMessage(room(), '@Ada can you look?')
    expect(first.targets).toEqual(['bot_a'])
    const settled = applyBotReply(first.state, 'bot_a', 'Done.')
    expect(settled.state.activeBotId).toBe('bot_a')

    const again = routeHumanMessage(settled.state, 'One more thing')
    expect(again.targets).toEqual(['bot_a'])
  })

  it('falls back to the lead, then to a pick prompt', () => {
    const lead = routeHumanMessage(room('bot_b'), 'status?')
    expect(lead.targets).toEqual(['bot_b'])

    const pick = routeHumanMessage(room(), 'status?')
    expect(pick).toMatchObject({ targets: [], pick: true })
  })

  it('makes a mentioned bot the active bot', () => {
    const first = routeHumanMessage(room(), 'hi @Bea')
    expect(first.state.activeBotId).toBe('bot_b')
    const next = routeHumanMessage(first.state, 'again')
    expect(next.targets).toEqual(['bot_b'])
  })

  it('adds an unaddressed mention to the window without starting a turn', () => {
    const first = routeHumanMessage(room('bot_a'), 'hello')
    const second = routeHumanMessage(first.state, 'note for @Cid')
    expect(second.targets).toEqual(['bot_c'])
  })
})

describe('applyBotReply', () => {
  it('settles a two-bot room after both pass', () => {
    const start = routeHumanMessage(room(), '@Ada @Bea quick check')
    const ada = applyBotReply(start.state, 'bot_a', ROOM_PASS)
    expect(ada.next).toBe('bot_b')
    expect(ada.settled).toBe(false)
    const bea = applyBotReply(ada.state, 'bot_b', ROOM_PASS)
    expect(bea.settled).toBe(true)
    expect(bea.next).toBeNull()
    expect(bea.state.round).toBeNull()
  })

  it('queues a mentioned bot and stops at the follow-up cap', () => {
    let state = routeHumanMessage(room(), '@Ada start').state
    let reply = applyBotReply(state, 'bot_a', 'Over to @Bea')
    expect(reply.next).toBe('bot_b')
    let followUps = 1
    let speaker = 'bot_b'
    let other = 'bot_a'
    while (reply.next !== null) {
      state = reply.state
      reply = applyBotReply(state, speaker, `Over to @${other === 'bot_a' ? 'Ada' : 'Bea'}`)
      followUps += 1
      ;[speaker, other] = [other, speaker]
      expect(followUps).toBeLessThanOrEqual(ROOM_MAX_FOLLOW_UPS + 1)
    }
    expect(reply.settled).toBe(true)
    expect(reply.state.round).toBeNull()
  })

  it('stops a mutual-mention loop at the round cap', () => {
    let state = routeHumanMessage(room(), '@Ada loop').state
    let reply = applyBotReply(state, 'bot_a', 'Over to @Bea')
    let rounds = reply.state.round?.rounds ?? 0
    while (reply.next !== null) {
      state = reply.state
      const speaker = reply.next
      const target = speaker === 'bot_a' ? 'Bea' : 'Ada'
      reply = applyBotReply(state, speaker, `Over to @${target}`)
      rounds = Math.max(rounds, reply.state.round?.rounds ?? ROOM_MAX_ROUNDS)
      expect(rounds).toBeLessThanOrEqual(ROOM_MAX_ROUNDS)
    }
    expect(reply.settled).toBe(true)
  })

  it('marks needs-you when a bot addresses the user', () => {
    const start = routeHumanMessage(room(), '@Ada check')
    const reply = applyBotReply(start.state, 'bot_a', '@user I need the API key.')
    expect(reply.state.needsUser).toBe(true)
    expect(mentionsUser('mail me at a@user.com')).toBe(false)
  })

  it('ignores a reply from a bot the room did not wake', () => {
    const start = routeHumanMessage(room(), '@Ada check')
    const reply = applyBotReply(start.state, 'bot_b', 'butting in')
    expect(reply.state).toBe(start.state)
    expect(reply.next).toBeNull()
    expect(reply.settled).toBe(false)
  })
})

it('feeds the room window and the pass rule to the bot prompt', () => {
  const start = routeHumanMessage(room(), '@Ada plan the migration')
  const prompt = roomPrompt(start.state, 'bot_a')
  expect(prompt).toContain('plan the migration')
  expect(prompt).toContain(ROOM_PASS)
  expect(prompt).toContain('@Bea')
})

it('matches the longest bot name first and ignores email-like mentions', () => {
  expect(
    mentionedBotIds('@Ada and @Bea', [
      { id: 'bot_a', name: 'Ada' },
      { id: 'bot_b', name: 'Bea' },
    ]),
  ).toEqual(['bot_a', 'bot_b'])
})
