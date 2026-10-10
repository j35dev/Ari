// @vitest-environment node
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { Command } from '@ari/contracts/commands'
import { SessionStore } from '@ari/engine/session-store'
import { RESUME_PROMPT, ResumeSchedule } from './resume-schedule'

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
  expect(schedule.get('s')).toBe(5_000)
  await schedule.sweep()
  expect(sent).toEqual([])

  now = 5_000
  await schedule.sweep()
  await schedule.sweep()
  expect(sent).toEqual([
    { type: 'turn.start', sessionId: 's', text: RESUME_PROMPT, attachments: [] },
  ])
  expect(schedule.get('s')).toBeNull()
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

it('keeps a pending resume across a restart and survives a damaged file', async () => {
  await runTurn('error')
  await schedule.schedule('s', 5_000)
  const restarted = make()
  await restarted.load()
  expect(restarted.get('s')).toBe(5_000)

  await writeFile(join(dir, 'resume.json'), '{not json', 'utf8')
  await restarted.load()
  expect(restarted.get('s')).toBeNull()
})
