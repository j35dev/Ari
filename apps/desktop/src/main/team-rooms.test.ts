// @vitest-environment node
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Bot } from '@ari/contracts/bot'
import type { Command } from '@ari/contracts/commands'
import type { MessageOrigin } from '@ari/contracts/message'
import { SessionStore } from '@ari/engine/session-store'
import { TeamRoomService } from './team-rooms'

let dir: string
let store: SessionStore
let service: TeamRoomService
let sent: { command: Command; origin: MessageOrigin | undefined }[]
let bots: Bot[]
let turn = 0

const seedSession = async (sessionId: string, title: string): Promise<void> => {
  await store.append(sessionId, {
    type: 'session.created',
    session: {
      id: sessionId,
      projectId: 'p',
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

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ari-team-room-'))
  store = new SessionStore({ rootDir: join(dir, 'sessions') })
  bots = [
    {
      id: 'bot_ada',
      name: 'Ada',
      emoji: '🧭',
      personaMd: '',
      driverKind: 'claude',
      modelId: null,
      mainSessionId: 'sess_ada',
    },
    {
      id: 'bot_bea',
      name: 'Bea',
      emoji: '🛠️',
      personaMd: '',
      driverKind: 'claude',
      modelId: null,
      mainSessionId: 'sess_bea',
    },
  ]
  await seedSession('sess_ada', 'Ada')
  await seedSession('sess_bea', 'Bea')
  sent = []
  service = new TeamRoomService({
    path: join(dir, 'team-rooms.json'),
    bots: { get: async (id) => bots.find((bot) => bot.id === id) ?? null },
    store,
    dispatch: async (command, origin) => {
      sent.push({ command, origin })
      return { accepted: true }
    },
  })
  await service.load()
})

afterEach(async () => {
  await store.closeJournal('sess_ada')
  await store.closeJournal('sess_bea')
  await rm(dir, { recursive: true, force: true })
})

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

/** Appends one complete room turn ending with `text` for `sessionId` and settles it. */
async function settleRoomTurn(sessionId: string, roomId: string, botId: string, text: string) {
  await service.onSettled(sessionId, await appendRoomTurn(sessionId, roomId, botId, text))
}

it('starts exactly one run for an unaddressed message, and follows it after a mention', async () => {
  const room = await service.create({
    title: 'War room',
    botIds: ['bot_ada', 'bot_bea'],
    leadBotId: 'bot_ada',
  })
  const first = await service.send(room.id, 'status?')
  expect(first).toEqual({ targets: ['bot_ada'], pick: false })
  expect(sent).toHaveLength(1)
  expect(sent[0]?.origin).toEqual({ kind: 'room', roomId: room.id, botId: 'bot_ada' })
  expect(sent[0]?.command).toMatchObject({
    type: 'message.enqueue',
    sessionId: 'sess_ada',
    hold: true,
    priority: 'room',
  })

  await settleRoomTurn('sess_ada', room.id, 'bot_ada', 'Over to @Bea for the schema')
  expect(sent).toHaveLength(2)
  expect(sent[1]?.origin).toEqual({ kind: 'room', roomId: room.id, botId: 'bot_bea' })

  await settleRoomTurn('sess_bea', room.id, 'bot_bea', '(pass)')
  const [stored] = await service.list()
  expect(stored?.round).toBeNull()
  expect(stored?.activeBotId).toBe('bot_ada')
})

it('asks for a pick when there is no active bot and no lead', async () => {
  const room = await service.create({ title: 'Flat room', botIds: ['bot_ada', 'bot_bea'] })
  expect(await service.send(room.id, 'hello')).toEqual({ targets: [], pick: true })
  expect(sent).toEqual([])
})

it('makes a human mention the active bot and carries a needs-you badge', async () => {
  const room = await service.create({ title: 'War room', botIds: ['bot_ada', 'bot_bea'] })
  await service.send(room.id, 'hey @Bea')
  expect(sent[0]?.origin).toMatchObject({ kind: 'room', botId: 'bot_bea' })
  await settleRoomTurn('sess_bea', room.id, 'bot_bea', '@user I need the token')

  const [stored] = await service.list()
  expect(stored).toMatchObject({ activeBotId: 'bot_bea', needsUser: true, round: null })

  await service.send(room.id, 'here it is')
  expect(sent[1]?.origin).toMatchObject({ kind: 'room', botId: 'bot_bea' })
  expect((await service.list())[0]?.needsUser).toBe(false)
})

it('ignores a settle that belongs to the bot’s own human thread', async () => {
  const room = await service.create({
    title: 'War room',
    botIds: ['bot_ada'],
    leadBotId: 'bot_ada',
  })
  await service.send(room.id, 'start')
  const turnId = 'turn_human'
  await store.append('sess_ada', { type: 'turn.started', turnId })
  await store.append('sess_ada', {
    type: 'user.message.added',
    message: {
      id: 'm_human',
      sessionId: 'sess_ada',
      turnId,
      role: 'user',
      parts: [{ type: 'text', text: 'just talking to Ada' }],
      createdAt: 2,
    },
  })
  await store.append('sess_ada', {
    type: 'turn.settled',
    turnId,
    stopReason: 'completed',
    errorMessage: null,
  })
  await service.onSettled('sess_ada', turnId)
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
  const roomTurnId = await appendRoomTurn('sess_ada', room.id, 'bot_ada', 'Over to @Bea')
  await store.append('sess_ada', { type: 'turn.started', turnId: 'turn_human' })
  await store.append('sess_ada', {
    type: 'user.message.added',
    message: {
      id: 'm_human',
      sessionId: 'sess_ada',
      turnId: 'turn_human',
      role: 'user',
      parts: [{ type: 'text', text: 'queued while Ada worked' }],
      createdAt: 50,
    },
  })
  await service.onSettled('sess_ada', roomTurnId)
  expect(sent).toHaveLength(2)
  expect(sent[1]?.origin).toEqual({ kind: 'room', roomId: room.id, botId: 'bot_bea' })
})

it('logs a corrupt rooms file instead of dropping it silently', async () => {
  const path = join(dir, 'corrupt-rooms.json')
  await writeFile(path, '{not json', 'utf8')
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  try {
    const corrupt = new TeamRoomService({
      path,
      bots: { get: async () => null },
      store,
      dispatch: async () => ({ accepted: true }),
    })
    await corrupt.load()
    expect(await corrupt.list()).toEqual([])
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('team rooms file unreadable'),
      expect.objectContaining({ path }),
    )

    warn.mockClear()
    const missing = new TeamRoomService({
      path: join(dir, 'missing-rooms.json'),
      bots: { get: async () => null },
      store,
      dispatch: async () => ({ accepted: true }),
    })
    await missing.load()
    expect(warn).not.toHaveBeenCalled()
  } finally {
    warn.mockRestore()
  }
})
