import { describe, expect, it } from 'vitest'
import {
  ROOM_LOG_MESSAGES,
  ROOM_MAX_FOLLOW_UPS,
  ROOM_MAX_MESSAGES,
  ROOM_MAX_ROUNDS,
  ROOM_PASS,
  ROOM_WINDOW_MESSAGES,
  applyBotReply,
  createRoomState,
  isRoomPass,
  mentionedBotIds,
  mentionsUser,
  roomPrompt,
  routeHumanMessage,
  type RoomBot,
  type RoomReply,
  type RoomState,
  type RoomStamp,
} from './room'

const bots: RoomBot[] = [
  { botId: 'bot_a', name: 'Ada', sessionId: 'sess_a' },
  { botId: 'bot_b', name: 'Bea', sessionId: 'sess_b' },
  { botId: 'bot_c', name: 'Cid', sessionId: 'sess_c' },
]

const room = (leadBotId: string | null = null): RoomState =>
  createRoomState('War room', bots, leadBotId)

let clock = 0
const stamp = (): RoomStamp => ({ id: `entry_${String(++clock)}`, at: clock })

const human = (state: RoomState, text: string, botId: string | null = null) =>
  routeHumanMessage(state, text, stamp(), botId)

const reply = (state: RoomState, botId: string, text: string): RoomReply =>
  applyBotReply(state, botId, text, stamp())

describe('routeHumanMessage', () => {
  it('sends an unaddressed message to the active bot, not the whole team', () => {
    const first = human(room(), '@Ada can you look?')
    expect(first.targets).toEqual(['bot_a'])
    const settled = reply(first.state, 'bot_a', 'Done.')
    expect(settled.state.activeBotId).toBe('bot_a')

    const again = human(settled.state, 'One more thing')
    expect(again.targets).toEqual(['bot_a'])
  })

  it('falls back to the lead, then to a pick prompt', () => {
    const lead = human(room('bot_b'), 'status?')
    expect(lead.targets).toEqual(['bot_b'])

    const pick = human(room(), 'status?')
    expect(pick).toMatchObject({ targets: [], pick: true, queued: false })
  })

  it('makes a mentioned bot the active bot', () => {
    const first = human(room(), 'hi @Bea')
    expect(first.state.activeBotId).toBe('bot_b')
    const settled = reply(first.state, 'bot_b', ROOM_PASS)
    const next = human(settled.state, 'again')
    expect(next.targets).toEqual(['bot_b'])
  })

  it('lets a human mention win over the active bot', () => {
    const first = human(room('bot_a'), 'hello')
    const settled = reply(first.state, 'bot_a', 'Hi.')
    const second = human(settled.state, 'note for @Cid')
    expect(second.targets).toEqual(['bot_c'])
  })

  it('addresses a picked bot directly, whatever the text mentions', () => {
    const pick = human(room(), 'who can take this?')
    expect(pick.pick).toBe(true)
    const picked = human(pick.state, 'ask @Bea too', 'bot_c')
    expect(picked).toMatchObject({ targets: ['bot_c'], pick: false, queued: false })
    expect(picked.state.activeBotId).toBe('bot_c')
  })

  it('queues a message sent during a live round and starts it once the room settles', () => {
    const start = human(room(), '@Ada plan it')
    const queued = human(start.state, '@Bea check the schema')
    expect(queued).toMatchObject({ targets: [], pick: false, queued: true })
    expect(queued.state.pending).toEqual([{ text: '@Bea check the schema', botId: null }])
    expect(queued.state.round?.awaiting).toEqual(['bot_a'])
    expect(queued.state.window.at(-1)).toEqual({ botId: null, text: '@Bea check the schema' })

    const settled = reply(queued.state, 'bot_a', 'Plan is ready.')
    expect(settled.settled).toBe(true)
    expect(settled.next).toBe('bot_b')
    expect(settled.state.pending).toEqual([])
    expect(settled.state.round).toMatchObject({ rounds: 1, messages: 0, awaiting: ['bot_b'] })
    expect(settled.state.activeBotId).toBe('bot_b')
  })

  it('keeps a queued direct address', () => {
    const start = human(room(), '@Ada go')
    const queued = human(start.state, 'your turn', 'bot_c')
    const settled = reply(queued.state, 'bot_a', ROOM_PASS)
    expect(settled.next).toBe('bot_c')
  })

  it('clears needs-you when the person answers', () => {
    const start = human(room(), '@Ada check')
    const asked = reply(start.state, 'bot_a', '@user which branch?')
    expect(asked.state.needsUser).toBe(true)
    expect(human(asked.state, 'main').state.needsUser).toBe(false)
  })
})

describe('applyBotReply', () => {
  it('settles a two-bot room after both pass', () => {
    const start = human(room(), '@Ada @Bea quick check')
    const ada = reply(start.state, 'bot_a', ROOM_PASS)
    expect(ada.next).toBe('bot_b')
    expect(ada.settled).toBe(false)
    const bea = reply(ada.state, 'bot_b', ROOM_PASS)
    expect(bea.settled).toBe(true)
    expect(bea.next).toBeNull()
    expect(bea.state.round).toBeNull()
  })

  it('queues a mentioned bot and stops at the follow-up cap', () => {
    let state = human(room(), '@Ada start').state
    let step = reply(state, 'bot_a', 'Over to @Bea')
    expect(step.next).toBe('bot_b')
    let followUps = 1
    let speaker = 'bot_b'
    let other = 'bot_a'
    while (step.next !== null) {
      state = step.state
      step = reply(state, speaker, `Over to @${other === 'bot_a' ? 'Ada' : 'Bea'}`)
      followUps += 1
      ;[speaker, other] = [other, speaker]
      expect(followUps).toBeLessThanOrEqual(ROOM_MAX_FOLLOW_UPS + 1)
    }
    expect(step.settled).toBe(true)
    expect(step.state.round).toBeNull()
  })

  it('stops a mutual-mention loop at the round cap', () => {
    const route = human(room(), '@Ada loop')
    let state = route.state
    let next: string | null = route.targets[0] ?? null
    let wakes = 0
    while (next !== null) {
      wakes += 1
      const target = next === 'bot_a' ? 'Bea' : 'Ada'
      const step = reply(state, next, `Over to @${target}`)
      expect(step.state.round?.rounds ?? 0).toBeLessThanOrEqual(ROOM_MAX_ROUNDS)
      state = step.state
      next = step.next
    }
    expect(wakes).toBe(Math.min(ROOM_MAX_ROUNDS, ROOM_MAX_FOLLOW_UPS + 1))
    expect(state.round).toBeNull()
  })

  it('never lets one human message produce more than the message cap', () => {
    const team: RoomBot[] = Array.from({ length: 12 }, (_, index) => ({
      botId: `bot_${String(index)}`,
      name: `Bot${String(index)}`,
      sessionId: `sess_${String(index)}`,
    }))
    const everyone = team.map((bot) => `@${bot.name}`).join(' ')
    for (const size of [8, 12]) {
      const members = team.slice(0, size)
      const mentions = members.map((bot) => `@${bot.name}`).join(' ')
      const route = routeHumanMessage(createRoomState('Crowd', members), mentions, stamp())
      let next = route.targets[0] ?? null
      let state = route.state
      let runs = 0
      while (next !== null) {
        runs += 1
        const step = reply(state, next, `Thoughts, ${everyone}?`)
        state = step.state
        next = step.next
      }
      expect(runs).toBe(ROOM_MAX_MESSAGES)
      expect(state.round).toBeNull()
    }
  })

  it('collects mentions from every reply in a wave, not just the last', () => {
    const start = human(room(), '@Ada @Bea weigh in')
    const ada = reply(start.state, 'bot_a', '@Cid should see this')
    expect(ada.state.round?.mentioned).toEqual(['bot_c'])
    const bea = reply(ada.state, 'bot_b', 'Agreed.')
    expect(bea).toMatchObject({ next: 'bot_c', settled: false })
    expect(bea.state.round).toMatchObject({ rounds: 2, followUps: 1, awaiting: ['bot_c'] })
  })

  it('hands the next wave every unique teammate the wave mentioned, in order', () => {
    const start = human(room(), '@Ada @Bea weigh in')
    const ada = reply(start.state, 'bot_a', '@Cid and @Bea, thoughts?')
    const bea = reply(ada.state, 'bot_b', '@Cid, and @Ada too')
    expect(bea.state.round?.awaiting).toEqual(['bot_c', 'bot_a'])
  })

  it('does not hand the next wave a bot that is still due in this one', () => {
    const start = human(room(), '@Ada @Bea weigh in')
    const ada = reply(start.state, 'bot_a', '@Bea what do you think?')
    expect(ada.state.round?.mentioned).toEqual([])
    const bea = reply(ada.state, 'bot_b', 'Looks fine.')
    expect(bea).toMatchObject({ next: null, settled: true })
  })

  it('tracks passes per wave, so a bot that passed can be handed a later wave', () => {
    const start = human(room(), '@Ada @Bea weigh in')
    const ada = reply(start.state, 'bot_a', ROOM_PASS)
    expect(ada.state.round?.passed).toEqual(['bot_a'])
    const bea = reply(ada.state, 'bot_b', '@Ada can you take the tests?')
    expect(bea.next).toBe('bot_a')
    expect(bea.state.round?.passed).toEqual([])
  })

  it('adds a mention past the cap to the window without starting a turn', () => {
    const route = human(room(), '@Ada loop')
    let state = route.state
    let next: string | null = route.targets[0] ?? null
    let last: RoomReply | null = null
    while (next !== null) {
      const text = next === 'bot_a' ? 'Over to @Bea' : 'Over to @Ada'
      last = reply(state, next, state.round?.followUps === ROOM_MAX_FOLLOW_UPS ? '@Cid FYI' : text)
      state = last.state
      next = last.next
    }
    expect(last).toMatchObject({ next: null, settled: true })
    expect(state.round).toBeNull()
    expect(state.window.at(-1)?.text).toBe('@Cid FYI')
    expect(roomPrompt(state, 'bot_c')).toContain('@Cid FYI')
  })

  it('treats a loosely written pass as a pass', () => {
    const start = human(room(), '@Ada check')
    const step = reply(start.state, 'bot_a', ' (Pass). ')
    expect(step.settled).toBe(true)
    expect(step.state.window).toEqual(start.state.window)
    expect(step.state.log).toEqual(start.state.log)
    expect(step.state.activeBotId).toBe('bot_a')
  })

  it('marks needs-you when a bot addresses the user', () => {
    const start = human(room(), '@Ada check')
    const step = reply(start.state, 'bot_a', '@user I need the API key.')
    expect(step.state.needsUser).toBe(true)
    expect(mentionsUser('mail me at a@user.com')).toBe(false)
  })

  it('ignores a reply from a bot the room did not wake', () => {
    const start = human(room(), '@Ada check')
    const step = reply(start.state, 'bot_b', 'butting in')
    expect(step.state).toBe(start.state)
    expect(step.next).toBeNull()
    expect(step.settled).toBe(false)
  })
})

describe('transcript', () => {
  it('logs every human and non-pass bot message with its stamp', () => {
    const start = routeHumanMessage(room(), '@Ada @Bea go', { id: 'h1', at: 100 })
    const ada = applyBotReply(start.state, 'bot_a', 'On it.', { id: 'r1', at: 200 })
    const bea = applyBotReply(ada.state, 'bot_b', 'pass', { id: 'r2', at: 300 })
    expect(bea.state.log).toEqual([
      { id: 'h1', botId: null, text: '@Ada @Bea go', at: 100 },
      { id: 'r1', botId: 'bot_a', text: 'On it.', at: 200 },
    ])
  })

  it('caps the log and the window at their newest entries', () => {
    let state = room()
    for (let index = 0; index < ROOM_LOG_MESSAGES + 100; index++) {
      state = routeHumanMessage(state, `message ${String(index)}`, {
        id: `m${String(index)}`,
        at: index,
      }).state
    }
    expect(state.log).toHaveLength(ROOM_LOG_MESSAGES)
    expect(state.log[0]?.id).toBe('m100')
    expect(state.window).toHaveLength(ROOM_WINDOW_MESSAGES)
    expect(state.window.at(-1)?.text).toBe(`message ${String(ROOM_LOG_MESSAGES + 99)}`)
  })
})

it('feeds the room window and the pass rule to the bot prompt', () => {
  const start = human(room(), '@Ada plan the migration')
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
  expect(mentionedBotIds('mail ada@Ada.dev', [{ id: 'bot_a', name: 'Ada' }])).toEqual([])
})

it('never reads an overlapping longer name as the shorter one', () => {
  const team = [
    { id: 'bot_short', name: 'Ada' },
    { id: 'bot_long', name: 'Ada Lovelace' },
  ]
  expect(mentionedBotIds('@Ada Lovelace, please review', team)).toEqual(['bot_long'])
  expect(mentionedBotIds('@Ada then @Ada Lovelace', team)).toEqual(['bot_short', 'bot_long'])
  expect(mentionedBotIds('@Ada Lovelace then @Ada', team)).toEqual(['bot_long', 'bot_short'])
})

it('recognizes a pass however it is punctuated', () => {
  for (const text of ['(pass)', 'pass', '(pass).', '(Pass)', 'PASS!', ' ( pass ) ']) {
    expect(isRoomPass(text)).toBe(true)
  }
  for (const text of ['passing to @Bea', 'I pass', '(pass) but also @Bea', '']) {
    expect(isRoomPass(text)).toBe(false)
  }
})
