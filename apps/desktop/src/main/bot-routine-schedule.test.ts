// @vitest-environment node
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Bot } from '@ari/contracts/bot'
import type { Command } from '@ari/contracts/commands'
import type { MessageOrigin } from '@ari/contracts/message'
import {
  BOT_ROUTINE_MAX_ENABLED,
  BOT_ROUTINE_MIN_EVERY_MS,
  type BotRoutine,
} from '@ari/contracts/routine'
import { SessionStore } from '@ari/engine/session-store'
import { BotRoutineSchedule } from './bot-routine-schedule'

let dir: string
let store: SessionStore
let schedule: BotRoutineSchedule
let now: number
let sent: { command: Command; origin: MessageOrigin | undefined }[]
let bot: Bot
let repo: string
let turn = 0

const MINUTE = 60_000
const EVERY = BOT_ROUTINE_MIN_EVERY_MS

const atOf = (routine: BotRoutine | undefined): number => {
  if (routine?.kind !== 'schedule') throw new Error('not a timed routine')
  return routine.at
}

const routineTurn = async (routineId: string): Promise<string> => {
  const turnId = `turn_${String(++turn)}`
  await store.append('sess_bot', { type: 'turn.started', turnId })
  await store.append('sess_bot', {
    type: 'user.message.added',
    message: {
      id: `m${String(turn)}`,
      sessionId: 'sess_bot',
      turnId,
      role: 'user',
      origin: { kind: 'routine', routineId },
      parts: [{ type: 'text', text: 'routine' }],
      createdAt: turn + 1,
    },
  })
  return turnId
}

const make = (): BotRoutineSchedule =>
  new BotRoutineSchedule({
    path: join(dir, 'bot-routines.json'),
    bots: {
      get: async (id) => (id === bot.id ? bot : null),
    },
    store,
    workspace: async () => repo,
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
  repo = join(dir, 'repo')
  now = 1_000
  sent = []
  schedule = make()
})

afterEach(async () => {
  await schedule.close()
  await store.closeJournal('sess_bot')
  await rm(dir, { recursive: true, force: true })
})

it('fires a routine into the bot session as routine-priority held work', async () => {
  const routine = await schedule.add({
    botId: bot.id,
    prompt: 'run the tests',
    at: now + 1_000,
    everyMs: EVERY,
    kind: 'schedule',
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
  expect(atOf(schedule.list()[0])).toBe(atOf(routine))
})

it('skips a fire while the same routine still has work pending', async () => {
  const routine = await schedule.add({
    botId: bot.id,
    prompt: 'nightly sweep',
    at: now + 1_000,
    everyMs: EVERY,
    kind: 'schedule',
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
  expect(atOf(schedule.list()[0])).toBe(atOf(routine))
})

it('still queues behind a turn that belongs to someone else', async () => {
  await schedule.add({
    botId: bot.id,
    prompt: 'nightly sweep',
    at: now + 1_000,
    everyMs: EVERY,
    kind: 'schedule',
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
    kind: 'schedule',
  })
  now = 1_000 + 5 * EVERY + 500
  await schedule.sweep()
  expect(sent).toHaveLength(1)
  expect(atOf(schedule.list()[0])).toBe(atOf(routine))
})

it('enforces the interval floor, the enabled cap, and known bots', async () => {
  await expect(
    schedule.add({
      botId: bot.id,
      prompt: 'too often',
      at: now,
      everyMs: BOT_ROUTINE_MIN_EVERY_MS - 1,
      kind: 'schedule',
    }),
  ).rejects.toThrow('at least 15 minutes')
  await expect(
    schedule.add({
      botId: 'bot_missing',
      prompt: 'run',
      kind: 'schedule',
      at: now,
      everyMs: EVERY,
    }),
  ).rejects.toThrow('unknown bot')

  for (let index = 0; index < BOT_ROUTINE_MAX_ENABLED; index++) {
    await schedule.add({
      botId: bot.id,
      prompt: `routine ${String(index)}`,
      at: now,
      everyMs: EVERY,
      kind: 'schedule',
    })
  }
  await expect(
    schedule.add({ botId: bot.id, prompt: 'one more', kind: 'schedule', at: now, everyMs: EVERY }),
  ).rejects.toThrow(`at most ${String(BOT_ROUTINE_MAX_ENABLED)} routines can be enabled`)
})

it('switches itself off after ten consecutive failed runs', async () => {
  const routine = await schedule.add({
    botId: bot.id,
    prompt: 'flaky job',
    at: 1_000,
    everyMs: EVERY,
    kind: 'schedule',
  })

  for (let index = 0; index < 10; index++) {
    now = atOf(routine) + index * EVERY
    await schedule.sweep()
    const turnId = await routineTurn(routine.id)
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
    kind: 'schedule',
  })
  const restarted = make()
  await restarted.load()
  expect(restarted.list()).toEqual([routine])
  restarted.close()
})

it('loads a routine saved before triggers as a timed routine that still fires', async () => {
  await writeFile(
    join(dir, 'bot-routines.json'),
    JSON.stringify([
      {
        id: 'routine_old',
        botId: bot.id,
        prompt: 'legacy sweep',
        at: 2_000,
        everyMs: EVERY,
        enabled: true,
        consecutiveFailures: 0,
        lastOutcomeTurnId: null,
        disabledReason: null,
      },
    ]),
  )
  await schedule.load()
  expect(schedule.list()[0]).toMatchObject({ id: 'routine_old', kind: 'schedule' })
  now = 2_000
  await schedule.sweep()
  expect(sent).toHaveLength(1)
  expect(sent[0]?.origin).toEqual({ kind: 'routine', routineId: 'routine_old' })
})

describe('commit routines', () => {
  const DEBOUNCE = 150
  const QUIET = DEBOUNCE + 500

  const git = (...args: string[]): string =>
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Ari',
        '-c',
        'user.email=ari@example.com',
        '-c',
        'commit.gpgsign=false',
        ...args,
      ],
      { cwd: repo, encoding: 'utf8' },
    )
  const commit = (message: string): string => git('commit', '--allow-empty', '-qm', message)
  const quiet = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, QUIET))
  const runs = (count: number): Promise<void> =>
    vi.waitFor(() => expect(sent).toHaveLength(count), { timeout: 5_000 })

  const addCommitRoutine = async (): Promise<BotRoutine> => {
    const routine = await schedule.add({
      botId: bot.id,
      prompt: 'playtest the build',
      kind: 'commit',
      branch: 'main',
      debounceMs: DEBOUNCE,
    })
    // Serialized behind the add, so the branch watcher is running once it settles.
    await schedule.sweep()
    return routine
  }

  beforeEach(async () => {
    await mkdir(repo)
    git('init', '-q', '-b', 'main')
    commit('initial')
    schedule.start()
  })

  it('fires once per new commit on its branch, and once for a burst within the debounce', async () => {
    const routine = await addCommitRoutine()
    commit('one')
    await new Promise((resolve) => setTimeout(resolve, DEBOUNCE / 2))
    expect(sent).toHaveLength(0)
    await runs(1)
    await quiet()
    expect(sent).toHaveLength(1)
    expect(sent[0]?.origin).toEqual({ kind: 'routine', routineId: routine.id })
    expect(sent[0]?.command).toMatchObject({
      sessionId: 'sess_bot',
      hold: true,
      priority: 'routine',
    })

    const turnId = await routineTurn(routine.id)
    await store.append('sess_bot', {
      type: 'turn.settled',
      turnId,
      stopReason: 'completed',
      errorMessage: null,
    })
    commit('two')
    commit('three')
    commit('four')
    await runs(2)
    await quiet()
    expect(sent).toHaveLength(2)
  })

  it('adds no run for commits while its previous run is still pending', async () => {
    const routine = await addCommitRoutine()
    commit('one')
    await runs(1)
    const turnId = await routineTurn(routine.id)
    for (const message of ['two', 'three', 'four']) {
      commit(message)
      await quiet()
    }
    expect(sent).toHaveLength(1)

    await store.append('sess_bot', {
      type: 'turn.settled',
      turnId,
      stopReason: 'completed',
      errorMessage: null,
    })
    commit('five')
    await runs(2)
  })

  it('ignores work tree edits, staging, and commits on other branches', async () => {
    await addCommitRoutine()
    await writeFile(join(repo, 'notes.txt'), 'draft')
    git('add', 'notes.txt')
    git('checkout', '-qb', 'other')
    commit('on other')
    await quiet()
    expect(sent).toEqual([])

    git('checkout', '-q', 'main')
    commit('on main')
    await runs(1)
  })

  it('switches itself off after ten failed runs and stops watching', async () => {
    const routine = await addCommitRoutine()
    for (let index = 0; index < 10; index++) {
      const turnId = await routineTurn(routine.id)
      await store.append('sess_bot', {
        type: 'turn.settled',
        turnId,
        stopReason: 'error',
        errorMessage: 'boom',
      })
      await schedule.sweep()
    }
    expect(schedule.list()[0]).toMatchObject({ enabled: false, consecutiveFailures: 10 })
    commit('after')
    await quiet()
    expect(sent).toEqual([])
  })
})
