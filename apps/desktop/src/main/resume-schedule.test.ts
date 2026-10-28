// @vitest-environment node
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { Command } from '@ari/contracts/commands'
import { SessionStore } from '@ari/engine/session-store'
import { MIN_EVERY_MS, RESUME_PROMPT, ResumeSchedule } from './resume-schedule'

let dir: string
let store: SessionStore
let schedule: ResumeSchedule
let now: number
let sent: Command[]
let turn = 0

const make = (): ResumeSchedule =>
  new ResumeSchedule({
    path: join(dir, 'resume.json'),
    store,
    now: () => now,
    dispatch: async (command) => {
      sent.push(command)
      return { accepted: true }
    },
  })

/** Runs one turn on the session that ends the given way. */
async function runTurn(stopReason: 'completed' | 'error'): Promise<string> {
  const turnId = `t${++turn}`
  await store.append('s', { type: 'turn.started', turnId })
  await store.append('s', {
    type: 'turn.settled',
    turnId,
    stopReason,
    errorMessage: stopReason === 'error' ? 'usage limit reached' : null,
  })
  return turnId
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ari-resume-'))
  store = new SessionStore({ rootDir: join(dir, 'sessions') })
  await store.append('s', {
    type: 'session.created',
    session: {
      id: 's',
      projectId: 'p',
      title: 'Limited',
      driverKind: 'claude',
      modelId: null,
      permissionMode: 'ask',
      status: 'idle',
      createdAt: 1,
      updatedAt: 1,
    },
  })
  now = 1_000
  sent = []
  schedule = make()
})
afterEach(async () => {
  schedule.close()
  await store.closeJournal('s')
  await rm(dir, { recursive: true, force: true })
})

it('continues the session once its time comes, and only once', async () => {
  await runTurn('error')
  await schedule.schedule('s', 5_000)
  expect(await schedule.get('s')).toBe(5_000)
  await schedule.sweep()
  expect(sent).toEqual([])

  now = 5_000
  await schedule.sweep()
  await schedule.sweep()
  expect(sent).toEqual([
    { type: 'turn.start', sessionId: 's', text: RESUME_PROMPT, attachments: [] },
  ])
  expect(await schedule.get('s')).toBeNull()
})

it('refuses a session that has nothing failed to resume, and a time too far out', async () => {
  await expect(schedule.schedule('s', 5_000)).rejects.toThrow('last turn failed')
  await runTurn('completed')
  await expect(schedule.schedule('s', 5_000)).rejects.toThrow('last turn failed')
  await runTurn('error')
  await expect(schedule.schedule('s', now + 30 * 24 * 60 * 60 * 1000)).rejects.toThrow(
    'out of range',
  )
  await expect(schedule.schedule('missing', 5_000)).rejects.toThrow('unknown session')
})

it('drops the resume when the conversation moved on or it was cancelled', async () => {
  await runTurn('error')
  await schedule.schedule('s', 5_000)
  await runTurn('error')
  now = 5_000
  await schedule.sweep()
  expect(sent).toEqual([])

  await schedule.schedule('s', 6_000)
  expect(await schedule.cancel('s')).toBe(true)
  expect(await schedule.cancel('s')).toBe(false)
  now = 6_000
  await schedule.sweep()
  expect(sent).toEqual([])
})

it('stops reporting a resume once the session is no longer on that failed turn', async () => {
  await runTurn('error')
  await schedule.schedule('s', 5_000)
  // Retried, and the same limit stopped it again: a new failed turn.
  await runTurn('error')
  expect(await schedule.get('s')).toBeNull()
  now = 5_000
  await schedule.sweep()
  expect(sent).toEqual([])
})

it('fires a custom prompt at its time, once, without a failed turn', async () => {
  await runTurn('completed')
  const routine = await schedule.add({ sessionId: 's', prompt: 'run the tests', at: 5_000 })
  expect(schedule.list()).toEqual([routine])

  await schedule.sweep()
  expect(sent).toEqual([])

  now = 5_000
  await schedule.sweep()
  await schedule.sweep()
  expect(sent).toEqual([
    { type: 'turn.start', sessionId: 's', text: 'run the tests', attachments: [] },
  ])
  expect(schedule.list()).toEqual([])
})

it('re-arms a repeating prompt to the next slot instead of bursting', async () => {
  const routine = await schedule.add({
    sessionId: 's',
    prompt: 'changelog',
    at: 5_000,
    every: MIN_EVERY_MS,
  })
  expect(routine.every).toBe(MIN_EVERY_MS)

  // Woke up after ~1.4 days: 16 slots were missed, none of them may all fire.
  now = 5_000_000
  await schedule.sweep()
  expect(sent).toHaveLength(1)
  expect(schedule.list()[0]?.at).toBe(5_105_000)

  await schedule.sweep()
  expect(sent).toHaveLength(1)

  now = 5_105_000
  await schedule.sweep()
  expect(sent).toHaveLength(2)
  expect(schedule.list()[0]?.at).toBe(5_405_000)
})

it('rejects a repeat interval under the floor, an empty prompt, and an archived session', async () => {
  await expect(
    schedule.add({ sessionId: 's', prompt: 'x', at: 5_000, every: 60_000 }),
  ).rejects.toThrow('at least 5 minutes')
  await expect(
    schedule.add({ sessionId: 's', prompt: '   ', at: 5_000, every: MIN_EVERY_MS }),
  ).rejects.toThrow('prompt is empty')

  await store.append('s', { type: 'session.updated', archived: true })
  await expect(schedule.add({ sessionId: 's', prompt: 'x', at: 5_000 })).rejects.toThrow(
    'session is archived',
  )
  await expect(schedule.add({ sessionId: 'missing', prompt: 'x', at: 5_000 })).rejects.toThrow(
    'unknown session',
  )
})

it('removes one routine by id and leaves the others', async () => {
  const first = await schedule.add({ sessionId: 's', prompt: 'first', at: 5_000 })
  const second = await schedule.add({ sessionId: 's', prompt: 'second', at: 6_000 })

  expect(await schedule.remove(first.id)).toBe(true)
  expect(await schedule.remove(first.id)).toBe(false)
  expect(schedule.list().map((entry) => entry.id)).toEqual([second.id])

  now = 10_000
  await schedule.sweep()
  expect(sent.map((command) => (command.type === 'turn.start' ? command.text : ''))).toEqual([
    'second',
  ])
})

it('migrates entries written before routines existed', async () => {
  const turnId = await runTurn('error')
  await writeFile(
    join(dir, 'resume.json'),
    JSON.stringify([{ sessionId: 's', turnId, at: 5_000 }]),
    'utf8',
  )
  const restarted = make()
  await restarted.load()

  expect(await restarted.get('s')).toBe(5_000)
  expect(restarted.list()).toEqual([])
  now = 5_000
  await restarted.sweep()
  expect(sent).toEqual([
    { type: 'turn.start', sessionId: 's', text: RESUME_PROMPT, attachments: [] },
  ])
})

it('drops a routine whose session was archived, and keeps it out of the file', async () => {
  await schedule.add({ sessionId: 's', prompt: 'stale', at: 5_000 })
  await store.append('s', { type: 'session.updated', archived: true })

  now = 5_000
  await schedule.sweep()
  expect(sent).toEqual([])
  expect(schedule.list()).toEqual([])

  const restarted = make()
  await restarted.load()
  expect(restarted.list()).toEqual([])
})

it('keeps a pending resume across a restart and survives a damaged file', async () => {
  await runTurn('error')
  await schedule.schedule('s', 5_000)
  const restarted = make()
  await restarted.load()
  expect(await restarted.get('s')).toBe(5_000)

  await writeFile(join(dir, 'resume.json'), '{not json', 'utf8')
  await restarted.load()
  expect(await restarted.get('s')).toBeNull()
})
