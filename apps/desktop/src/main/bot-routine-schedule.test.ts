// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { Bot } from '@ari/contracts/bot'
import type { Command } from '@ari/contracts/commands'
import type { MessageOrigin } from '@ari/contracts/message'
import { BOT_ROUTINE_MAX_ENABLED, BOT_ROUTINE_MIN_EVERY_MS } from '@ari/contracts/routine'
import { SessionStore } from '@ari/engine/session-store'
import { BotRoutineSchedule } from './bot-routine-schedule'

let dir: string
let store: SessionStore
let schedule: BotRoutineSchedule
let now: number
let sent: { command: Command; origin: MessageOrigin | undefined }[]
let bot: Bot
let turn = 0

const MINUTE = 60_000
const EVERY = BOT_ROUTINE_MIN_EVERY_MS

const make = (): BotRoutineSchedule =>
  new BotRoutineSchedule({
    path: join(dir, 'bot-routines.json'),
    bots: {
      get: async (id) => (id === bot.id ? bot : null),
    },
    store,
    now: () => now,
    dispatch: async (command, origin) => {
      sent.push({ command, origin })
      return { accepted: true }
    },
  })

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ari-bot-routine-'))
  store = new SessionStore({ rootDir: join(dir, 'sessions') })
  await store.append('sess_bot', {
    type: 'session.created',
    session: {
      id: 'sess_bot',
      projectId: 'p',
      title: 'Scout',
      driverKind: 'claude',
      modelId: null,
      permissionMode: 'ask',
      status: 'idle',
      createdAt: 1,
      updatedAt: 1,
    },
  })
  bot = {
    id: 'bot_scout',
    name: 'Scout',
    emoji: '🔭',
    personaMd: '',
    driverKind: 'claude',
    modelId: null,
    mainSessionId: 'sess_bot',
  }
  now = 1_000
  sent = []
  schedule = make()
})

afterEach(async () => {
  schedule.close()
  await store.closeJournal('sess_bot')
  await rm(dir, { recursive: true, force: true })
})

it('fires a routine into the bot session as routine-priority held work', async () => {
  const routine = await schedule.add({
    botId: bot.id,
    prompt: 'run the tests',
    at: now + 1_000,
    everyMs: EVERY,
  })
  now += 1_000
  await schedule.sweep()

  expect(sent).toHaveLength(1)
  expect(sent[0]?.origin).toEqual({ kind: 'routine', routineId: routine.id })
  expect(sent[0]?.command).toMatchObject({
    type: 'message.enqueue',
    sessionId: 'sess_bot',
    hold: true,
    priority: 'routine',
  })
  const text = sent[0]?.command.type === 'message.enqueue' ? sent[0].command.text : ''
  expect(text).toContain('no user is present')
  expect(text).toContain('run the tests')
  expect(schedule.list()[0]?.at).toBe(routine.at)
})

it('skips a fire while the same routine still has work pending', async () => {
  const routine = await schedule.add({
    botId: bot.id,
    prompt: 'nightly sweep',
    at: now + 1_000,
    everyMs: EVERY,
  })
  await store.append('sess_bot', { type: 'turn.started', turnId: 'turn_1' })
  await store.append('sess_bot', {
    type: 'user.message.added',
    message: {
      id: 'm1',
      sessionId: 'sess_bot',
      turnId: 'turn_1',
      role: 'user',
      origin: { kind: 'routine', routineId: routine.id },
      parts: [{ type: 'text', text: 'nightly sweep' }],
      createdAt: 2,
    },
  })

  now += 1_000
  await schedule.sweep()
  expect(sent).toEqual([])
  expect(schedule.list()[0]?.at).toBe(routine.at)
})

it('still queues behind a turn that belongs to someone else', async () => {
  await schedule.add({
    botId: bot.id,
    prompt: 'nightly sweep',
    at: now + 1_000,
    everyMs: EVERY,
  })
  await store.append('sess_bot', { type: 'turn.started', turnId: 'turn_human' })

  now += 1_000
  await schedule.sweep()
  expect(sent).toHaveLength(1)
  expect(sent[0]?.command).toMatchObject({ hold: true, priority: 'routine' })
})

it('skips missed windows instead of replaying them', async () => {
  const routine = await schedule.add({
    botId: bot.id,
    prompt: 'nightly sweep',
    at: 1_000,
    everyMs: EVERY,
  })
  now = 1_000 + 5 * EVERY + 500
  await schedule.sweep()
  expect(sent).toHaveLength(1)
  expect(schedule.list()[0]?.at).toBe(routine.at)
})

it('enforces the interval floor, the enabled cap, and known bots', async () => {
  await expect(
    schedule.add({
      botId: bot.id,
      prompt: 'too often',
      at: now,
      everyMs: BOT_ROUTINE_MIN_EVERY_MS - 1,
    }),
  ).rejects.toThrow('at least 15 minutes')
  await expect(
    schedule.add({ botId: 'bot_missing', prompt: 'run', at: now, everyMs: EVERY }),
  ).rejects.toThrow('unknown bot')

  for (let index = 0; index < BOT_ROUTINE_MAX_ENABLED; index++) {
    await schedule.add({
      botId: bot.id,
      prompt: `routine ${String(index)}`,
      at: now,
      everyMs: EVERY,
    })
  }
  await expect(
    schedule.add({ botId: bot.id, prompt: 'one more', at: now, everyMs: EVERY }),
  ).rejects.toThrow(`at most ${String(BOT_ROUTINE_MAX_ENABLED)} routines can be enabled`)
})

it('switches itself off after ten consecutive failed runs', async () => {
  const routine = await schedule.add({
    botId: bot.id,
    prompt: 'flaky job',
    at: 1_000,
    everyMs: EVERY,
  })

  for (let index = 0; index < 10; index++) {
    now = routine.at + index * EVERY
    await schedule.sweep()
    const turnId = `turn_${String(++turn)}`
    await store.append('sess_bot', { type: 'turn.started', turnId })
    await store.append('sess_bot', {
      type: 'user.message.added',
      message: {
        id: `m${String(turn)}`,
        sessionId: 'sess_bot',
        turnId,
        role: 'user',
        origin: { kind: 'routine', routineId: routine.id },
        parts: [{ type: 'text', text: 'flaky job' }],
        createdAt: index + 2,
      },
    })
    await store.append('sess_bot', {
      type: 'turn.settled',
      turnId,
      stopReason: 'error',
      errorMessage: 'boom',
    })
    await schedule.sweep()
  }

  const [stored] = schedule.list()
  expect(stored?.enabled).toBe(false)
  expect(stored?.consecutiveFailures).toBe(10)
  expect(stored?.disabledReason).toContain('10 consecutive failed runs')
  expect(await schedule.setEnabled(routine.id, true)).toMatchObject({
    enabled: true,
    consecutiveFailures: 0,
    disabledReason: null,
  })
})

it('persists routines across a restart', async () => {
  const routine = await schedule.add({
    botId: bot.id,
    prompt: 'persist me',
    at: now + 5 * MINUTE,
    everyMs: EVERY,
  })
  const restarted = make()
  await restarted.load()
  expect(restarted.list()).toEqual([routine])
  restarted.close()
})
