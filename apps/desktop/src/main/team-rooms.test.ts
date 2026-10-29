// @vitest-environment node
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Bot } from '@ari/contracts/bot'
import type { Command } from '@ari/contracts/commands'
import type { MessageOrigin } from '@ari/contracts/message'
import type { TeamRoomFrame, TeamRoomSummary } from '@ari/contracts/rpc'
import { SessionStore } from '@ari/engine/session-store'
import { TeamRoomService, type RoomThreadInput, type TeamRoomDeps } from './team-rooms'

let dir: string
let store: SessionStore
let service: TeamRoomService
let sent: { command: Command; origin: MessageOrigin | undefined }[]
let threads: RoomThreadInput[]
let archived: string[]
let frames: TeamRoomFrame[]
let bots: Bot[]
let sessions: string[]
let turn = 0
let clock = 1_000

const seedSession = async (sessionId: string, title: string, projectId = 'p'): Promise<void> => {
  sessions.push(sessionId)
  await store.append(sessionId, {
    type: 'session.created',
    session: {
      id: sessionId,
      projectId,
      title,
      driverKind: 'claude',
      modelId: null,
      permissionMode: 'ask',
      status: 'idle',
      createdAt: 1,
      updatedAt: 1,
    },
  })
}

const deps = (overrides: Partial<TeamRoomDeps> = {}): TeamRoomDeps => ({
  path: join(dir, 'team-rooms.json'),
  bots: { get: async (id) => bots.find((bot) => bot.id === id) ?? null },
  store,
  dispatch: async (command, origin) => {
    sent.push({ command, origin })
    return { accepted: true }
  },
  createThread: async (input) => {
    threads.push(input)
    const sessionId = `sess_thread_${String(threads.length)}`
    await seedSession(sessionId, input.title, input.projectId)
    return sessionId
  },
  archiveThread: async (sessionId) => {
    archived.push(sessionId)
  },
  publish: (frame) => frames.push(frame),
  now: () => ++clock,
  ...overrides,
})

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ari-team-room-'))
  store = new SessionStore({ rootDir: join(dir, 'sessions') })
  sessions = []
  bots = [
    {
      id: 'bot_ada',
      name: 'Ada',
      emoji: '🧭',
      personaMd: '',
      driverKind: 'claude',
      modelId: 'opus',
      projectId: 'proj_ada',
      mainSessionId: 'sess_ada',
    },
    {
      // A bot saved before bots carried a project: its main session has one.
      id: 'bot_bea',
      name: 'Bea',
      emoji: '🛠️',
      personaMd: '',
      driverKind: 'codex',
      modelId: null,
      mainSessionId: 'sess_bea',
    },
  ]
  await seedSession('sess_ada', 'Ada', 'proj_ada')
  await seedSession('sess_bea', 'Bea', 'proj_bea')
  sent = []
  threads = []
  archived = []
  frames = []
  service = new TeamRoomService(deps())
  await service.load()
})

afterEach(async () => {
  for (const sessionId of sessions) await store.closeJournal(sessionId)
  await rm(dir, { recursive: true, force: true })
})

const threadOf = (room: TeamRoomSummary, botId: string): string =>
  room.bots.find((bot) => bot.botId === botId)?.sessionId ?? ''

/** Appends one complete room turn ending with `text`, and returns its turn id. */
async function appendRoomTurn(
  sessionId: string,
  roomId: string,
  botId: string,
  text: string,
): Promise<string> {
  const turnId = `turn_${String(++turn)}`
  await store.append(sessionId, { type: 'turn.started', turnId })
  await store.append(sessionId, {
    type: 'user.message.added',
    message: {
      id: `m${String(turn)}`,
      sessionId,
      turnId,
      role: 'user',
      origin: { kind: 'room', roomId, botId },
      parts: [{ type: 'text', text: 'room turn' }],
      createdAt: turn + 1,
    },
  })
  await store.append(sessionId, {
    type: 'assistant.parts.appended',
    messageId: `a${String(turn)}`,
    parts: [{ type: 'text', text }],
  })
  await store.append(sessionId, {
    type: 'turn.settled',
    turnId,
    stopReason: 'completed',
    errorMessage: null,
  })
  return turnId
}

/** Appends one complete room turn for the bot's room thread and settles it. */
async function settleRoomTurn(room: TeamRoomSummary, botId: string, text: string) {
  const sessionId = threadOf(room, botId)
  await service.onSettled(sessionId, await appendRoomTurn(sessionId, room.id, botId, text))
}

it('starts exactly one run for an unaddressed message, and follows it after a mention', async () => {
  const room = await service.create({
    title: 'War room',
    botIds: ['bot_ada', 'bot_bea'],
    leadBotId: 'bot_ada',
  })
  const first = await service.send(room.id, 'status?')
  expect(first).toEqual({ targets: ['bot_ada'], pick: false, queued: false })
  expect(sent).toHaveLength(1)
  expect(sent[0]?.origin).toEqual({ kind: 'room', roomId: room.id, botId: 'bot_ada' })
  expect(sent[0]?.command).toMatchObject({
    type: 'message.enqueue',
    sessionId: threadOf(room, 'bot_ada'),
    hold: true,
    priority: 'room',
  })

  await settleRoomTurn(room, 'bot_ada', 'Over to @Bea for the schema')
  expect(sent).toHaveLength(2)
  expect(sent[1]?.origin).toEqual({ kind: 'room', roomId: room.id, botId: 'bot_bea' })
  expect(sent[1]?.command).toMatchObject({ sessionId: threadOf(room, 'bot_bea') })

  await settleRoomTurn(room, 'bot_bea', '(pass)')
  const [stored] = await service.list()
  expect(stored?.round).toBeNull()
  expect(stored?.activeBotId).toBe('bot_ada')
})

it('gives each bot its own room thread, kept across a restart', async () => {
  const room = await service.create({ title: 'War room', botIds: ['bot_ada', 'bot_bea'] })
  expect(threads).toEqual([
    {
      projectId: 'proj_ada',
      title: 'War room',
      driverKind: 'claude',
      modelId: 'opus',
      botId: 'bot_ada',
    },
    {
      projectId: 'proj_bea',
      title: 'War room',
      driverKind: 'codex',
      modelId: null,
      botId: 'bot_bea',
    },
  ])
  expect(room.bots).toEqual([
    { botId: 'bot_ada', name: 'Ada', emoji: '🧭', sessionId: 'sess_thread_1' },
    { botId: 'bot_bea', name: 'Bea', emoji: '🛠️', sessionId: 'sess_thread_2' },
  ])

  const reloaded = new TeamRoomService(deps())
  await reloaded.load()
  expect((await reloaded.list())[0]?.bots.map((bot) => bot.sessionId)).toEqual([
    'sess_thread_1',
    'sess_thread_2',
  ])
  expect(threads).toHaveLength(2)
})

it('archives the threads already made when a later one cannot be created', async () => {
  let made = 0
  const failing = new TeamRoomService(
    deps({
      createThread: async () => {
        made += 1
        if (made === 2) throw new Error('project is gone')
        return 'sess_thread_partial'
      },
    }),
  )
  await failing.load()
  await expect(failing.create({ title: 'Doomed', botIds: ['bot_ada', 'bot_bea'] })).rejects.toThrow(
    'project is gone',
  )
  expect(archived).toEqual(['sess_thread_partial'])
  expect(await failing.list()).toEqual([])
})

it('creates the thread on first wake for a room saved before threads existed', async () => {
  const path = join(dir, 'old-rooms.json')
  await writeFile(
    path,
    JSON.stringify([
      {
        id: 'room_old',
        botIds: ['bot_ada'],
        state: {
          title: 'Old room',
          bots: [{ botId: 'bot_ada', name: 'Ada', sessionId: 'sess_ada' }],
          leadBotId: 'bot_ada',
          activeBotId: null,
          needsUser: false,
          window: [{ botId: null, text: 'earlier' }],
          round: null,
        },
      },
    ]),
    'utf8',
  )
  const old = new TeamRoomService(deps({ path }))
  await old.load()
  const [loaded] = await old.list()
  expect(loaded).toMatchObject({ log: [], pending: 0, window: [{ botId: null, text: 'earlier' }] })
  expect(loaded?.bots[0]?.sessionId).toBe('')

  await old.send('room_old', 'still there?')
  expect(threads).toEqual([expect.objectContaining({ botId: 'bot_ada', title: 'Old room' })])
  expect(sent[0]?.command).toMatchObject({ sessionId: 'sess_thread_1' })
  const saved = JSON.parse(await readFile(path, 'utf8')) as { threads: Record<string, string> }[]
  expect(saved[0]?.threads).toEqual({ bot_ada: 'sess_thread_1' })
})

it('asks for a pick when there is no active bot and no lead', async () => {
  const room = await service.create({ title: 'Flat room', botIds: ['bot_ada', 'bot_bea'] })
  expect(await service.send(room.id, 'hello')).toEqual({ targets: [], pick: true, queued: false })
  expect(sent).toEqual([])
})

it('addresses a picked bot directly and rejects a bot outside the room', async () => {
  const room = await service.create({ title: 'Flat room', botIds: ['bot_ada', 'bot_bea'] })
  await service.send(room.id, 'hello')
  const picked = await service.send(room.id, 'hello, @Ada', 'bot_bea')
  expect(picked).toEqual({ targets: ['bot_bea'], pick: false, queued: false })
  expect(sent[0]?.origin).toMatchObject({ botId: 'bot_bea' })
  expect((await service.list())[0]?.activeBotId).toBe('bot_bea')

  await expect(service.send(room.id, 'hi', 'bot_zed')).rejects.toThrow('unknown bot')
})

it('queues a human message sent during a live round and wakes it once the room settles', async () => {
  const room = await service.create({
    title: 'War room',
    botIds: ['bot_ada', 'bot_bea'],
    leadBotId: 'bot_ada',
  })
  await service.send(room.id, 'start')
  const queued = await service.send(room.id, '@Bea and the schema?')
  expect(queued).toEqual({ targets: [], pick: false, queued: true })
  expect(sent).toHaveLength(1)
  expect((await service.list())[0]).toMatchObject({ pending: 1 })

  await settleRoomTurn(room, 'bot_ada', 'Started.')
  expect(sent).toHaveLength(2)
  expect(sent[1]?.origin).toMatchObject({ botId: 'bot_bea' })
  const [stored] = await service.list()
  expect(stored).toMatchObject({ pending: 0, activeBotId: 'bot_bea' })
  expect(stored?.round?.awaiting).toEqual(['bot_bea'])
})

it('makes a human mention the active bot and carries a needs-you badge', async () => {
  const room = await service.create({ title: 'War room', botIds: ['bot_ada', 'bot_bea'] })
  await service.send(room.id, 'hey @Bea')
  expect(sent[0]?.origin).toMatchObject({ kind: 'room', botId: 'bot_bea' })
  await settleRoomTurn(room, 'bot_bea', '@user I need the token')

  const [stored] = await service.list()
  expect(stored).toMatchObject({ activeBotId: 'bot_bea', needsUser: true, round: null })

  await service.send(room.id, 'here it is')
  expect(sent[1]?.origin).toMatchObject({ kind: 'room', botId: 'bot_bea' })
  expect((await service.list())[0]?.needsUser).toBe(false)
})

it('keeps a transcript and publishes every change', async () => {
  const room = await service.create({
    title: 'War room',
    botIds: ['bot_ada'],
    leadBotId: 'bot_ada',
  })
  expect(frames.at(-1)).toEqual({ roomId: room.id, room })
  await service.send(room.id, 'status?')
  await settleRoomTurn(room, 'bot_ada', 'All green.')

  const [stored] = await service.list()
  expect(stored?.log.map(({ botId, text }) => ({ botId, text }))).toEqual([
    { botId: null, text: 'status?' },
    { botId: 'bot_ada', text: 'All green.' },
  ])
  expect(new Set(stored?.log.map((entry) => entry.id)).size).toBe(2)
  expect(frames.at(-1)).toEqual({ roomId: room.id, room: stored })
  const stamps = frames.map((frame) => frame.room?.updatedAt ?? 0)
  expect(stamps).toEqual([...stamps].sort((a, b) => a - b))
  expect(new Set(stamps).size).toBe(frames.length)
})

it('carries a bot character into its rooms, and leaves it off for a bot without one', async () => {
  const character = {
    body: 'bean',
    eyes: 'spark',
    mouth: 'smirk',
    top: 'leaf',
    accessory: 'scarf',
    palette: 2,
  } as const
  bots[0] = { ...bots[0]!, character }
  const room = await service.create({ title: 'War room', botIds: ['bot_ada', 'bot_bea'] })
  expect(room.bots[0]?.character).toEqual(character)
  expect(room.bots[1] && 'character' in room.bots[1]).toBe(false)

  const reloaded = new TeamRoomService(deps())
  await reloaded.load()
  expect((await reloaded.list())[0]?.bots[0]?.character).toEqual(character)
})

it('renames a bot in its rooms, so mentions route by the new name', async () => {
  const room = await service.create({ title: 'War room', botIds: ['bot_ada', 'bot_bea'] })
  const other = await service.create({ title: 'Solo', botIds: ['bot_ada'] })
  const character = {
    body: 'square',
    eyes: 'dot',
    mouth: 'o',
    top: 'cap',
    accessory: 'bowtie',
    palette: 7,
  } as const
  bots[1] = { ...bots[1]!, name: 'Bex', emoji: '🐝', character }
  frames = []

  await service.refreshBot(bots[1])

  const renamed = (await service.list()).find((entry) => entry.id === room.id)
  expect(renamed?.bots[1]).toEqual({
    botId: 'bot_bea',
    name: 'Bex',
    emoji: '🐝',
    character,
    sessionId: threadOf(room, 'bot_bea'),
  })
  expect(renamed?.updatedAt).toBe(room.updatedAt)
  expect(frames).toEqual([{ roomId: room.id, room: renamed }])
  expect((await service.list()).find((entry) => entry.id === other.id)).toEqual(other)

  await service.refreshBot(bots[1])
  expect(frames).toHaveLength(1)

  expect(await service.send(room.id, 'hey @Bea')).toMatchObject({ targets: [], pick: true })
  expect(await service.send(room.id, 'hey @Bex')).toMatchObject({ targets: ['bot_bea'] })
  expect(sent[0]?.origin).toMatchObject({ kind: 'room', botId: 'bot_bea' })

  const saved = JSON.parse(await readFile(join(dir, 'team-rooms.json'), 'utf8')) as {
    id: string
    state: { bots: { name: string }[] }
  }[]
  expect(saved.find((entry) => entry.id === room.id)?.state.bots[1]?.name).toBe('Bex')
})

it('removes a room, archives its threads, and publishes the removal', async () => {
  const room = await service.create({ title: 'War room', botIds: ['bot_ada', 'bot_bea'] })
  expect(await service.remove(room.id)).toEqual({ removed: true })
  expect(archived).toEqual([threadOf(room, 'bot_ada'), threadOf(room, 'bot_bea')])
  expect(frames.at(-1)).toEqual({ roomId: room.id, room: null })
  expect(await service.list()).toEqual([])
  expect(await service.remove(room.id)).toEqual({ removed: false })

  const reloaded = new TeamRoomService(deps())
  await reloaded.load()
  expect(await reloaded.list()).toEqual([])
})

it('lets a bot whose thread refuses or throws pass, so the room settles', async () => {
  const failing = new TeamRoomService(
    deps({
      path: join(dir, 'failing-rooms.json'),
      dispatch: async (command, origin) => {
        sent.push({ command, origin })
        if (origin?.kind === 'room' && origin.botId === 'bot_ada') {
          return { accepted: false, reason: 'session destroyed' }
        }
        throw new Error('archived thread')
      },
    }),
  )
  await failing.load()
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  try {
    const room = await failing.create({ title: 'War room', botIds: ['bot_ada', 'bot_bea'] })
    await failing.send(room.id, '@Ada @Bea anyone?')
    expect(sent.map((entry) => entry.origin)).toMatchObject([
      { botId: 'bot_ada' },
      { botId: 'bot_bea' },
    ])
    expect((await failing.list())[0]?.round).toBeNull()
    const reasons = warn.mock.calls
      .filter(([message]) => String(message).includes('team room wake was refused'))
      .map(([, context]) => (context as { reason?: string }).reason)
    expect(reasons).toEqual(['session destroyed', 'Error: archived thread'])
  } finally {
    warn.mockRestore()
  }
})

it('ignores a human turn typed into a room thread', async () => {
  const room = await service.create({
    title: 'War room',
    botIds: ['bot_ada'],
    leadBotId: 'bot_ada',
  })
  await service.send(room.id, 'start')
  const sessionId = threadOf(room, 'bot_ada')
  const turnId = 'turn_human'
  await store.append(sessionId, { type: 'turn.started', turnId })
  await store.append(sessionId, {
    type: 'user.message.added',
    message: {
      id: 'm_human',
      sessionId,
      turnId,
      role: 'user',
      parts: [{ type: 'text', text: 'just talking to Ada' }],
      createdAt: 2,
    },
  })
  await store.append(sessionId, {
    type: 'turn.settled',
    turnId,
    stopReason: 'completed',
    errorMessage: null,
  })
  await service.onSettled(sessionId, turnId)
  expect(sent).toHaveLength(1)
  expect((await service.list())[0]?.round?.awaiting).toEqual(['bot_ada'])
})

it('records a room reply even when a human turn starts before the settle is read', async () => {
  const room = await service.create({
    title: 'War room',
    botIds: ['bot_ada', 'bot_bea'],
    leadBotId: 'bot_ada',
  })
  await service.send(room.id, 'start')
  const sessionId = threadOf(room, 'bot_ada')
  const roomTurnId = await appendRoomTurn(sessionId, room.id, 'bot_ada', 'Over to @Bea')
  await store.append(sessionId, { type: 'turn.started', turnId: 'turn_human' })
  await store.append(sessionId, {
    type: 'user.message.added',
    message: {
      id: 'm_human',
      sessionId,
      turnId: 'turn_human',
      role: 'user',
      parts: [{ type: 'text', text: 'queued while Ada worked' }],
      createdAt: 50,
    },
  })
  await service.onSettled(sessionId, roomTurnId)
  expect(sent).toHaveLength(2)
  expect(sent[1]?.origin).toEqual({ kind: 'room', roomId: room.id, botId: 'bot_bea' })
})

it('logs a corrupt rooms file instead of dropping it silently', async () => {
  const path = join(dir, 'corrupt-rooms.json')
  await writeFile(path, '{not json', 'utf8')
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  try {
    const corrupt = new TeamRoomService(deps({ path, bots: { get: async () => null } }))
    await corrupt.load()
    expect(await corrupt.list()).toEqual([])
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('team rooms file unreadable'),
      expect.objectContaining({ path }),
    )

    warn.mockClear()
    const missing = new TeamRoomService(
      deps({ path: join(dir, 'missing-rooms.json'), bots: { get: async () => null } }),
    )
    await missing.load()
    expect(warn).not.toHaveBeenCalled()
  } finally {
    warn.mockRestore()
  }
})
