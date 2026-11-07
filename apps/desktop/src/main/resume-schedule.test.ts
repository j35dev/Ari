// @vitest-environment node
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import type * as fsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Command } from '@ari/contracts/commands'
import { SessionStore } from '@ari/engine/session-store'
import { MIN_EVERY_MS, RESUME_PROMPT, ResumeSchedule } from './resume-schedule'
import type { ResumeScheduleOptions, RoutineEntry } from './resume-schedule'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fsPromises>()
  const patched = {
    ...actual,
    mkdir: vi.fn(actual.mkdir),
    readFile: vi.fn(actual.readFile),
    writeFile: vi.fn(actual.writeFile),
    rename: vi.fn(actual.rename),
  }
  return { ...patched, default: patched }
})

const disk = await vi.importActual<typeof fsPromises>('node:fs/promises')

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function failNext(stage: 'write' | 'rename'): Error {
  const error = new Error(`injected ${stage} failure`)
  if (stage === 'write') vi.mocked(writeFile).mockRejectedValueOnce(error)
  else vi.mocked(rename).mockRejectedValueOnce(error)
  return error
}

/** Hold one scheduler write without sleeps; all later writes still use real disk. */
function holdNextWrite(): { entered: Promise<void>; release: () => void } {
  const entered = deferred()
  const released = deferred()
  vi.mocked(writeFile).mockImplementationOnce(async (...args) => {
    entered.resolve()
    await released.promise
    await disk.writeFile(...args)
  })
  return { entered: entered.promise, release: released.resolve }
}

async function persisted(): Promise<RoutineEntry[]> {
  return JSON.parse(await disk.readFile(join(dir, 'resume.json'), 'utf8')) as RoutineEntry[]
}

let dir: string
let store: SessionStore
let schedule: ResumeSchedule
let now: number
let sent: Command[]
let turn = 0

const make = (options: Partial<ResumeScheduleOptions> = {}): ResumeSchedule =>
  new ResumeSchedule({
    path: join(dir, 'resume.json'),
    store,
    now: () => now,
    dispatch: async (command) => {
      sent.push(command)
      return { accepted: true }
    },
    ...options,
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
  vi.useRealTimers()
  vi.mocked(mkdir).mockReset()
  vi.mocked(readFile).mockReset()
  vi.mocked(writeFile).mockReset()
  vi.mocked(rename).mockReset()
  vi.restoreAllMocks()
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

it.each(['write', 'rename'] as const)(
  'does not fire a rejected resume after a %s failure',
  async (stage) => {
    await runTurn('error')
    const error = failNext(stage)
    await expect(schedule.schedule('s', 5_000)).rejects.toBe(error)
    expect(await schedule.get('s')).toBeNull()
    const restarted = make()
    await restarted.load()
    expect(await restarted.get('s')).toBeNull()
    now = 5_000
    await schedule.sweep()
    await restarted.sweep()
    expect(sent).toEqual([])
  },
)

it.each(['write', 'rename'] as const)(
  'keeps the acknowledged resume when replacement %s fails',
  async (stage) => {
    await runTurn('error')
    const original = await schedule.schedule('s', 5_000)
    const error = failNext(stage)
    await expect(schedule.schedule('s', 6_000)).rejects.toBe(error)
    expect(await schedule.get('s')).toBe(5_000)
    expect(await persisted()).toEqual([original])
    const restarted = make()
    await restarted.load()
    expect(await restarted.get('s')).toBe(5_000)
    now = 6_000
    await schedule.sweep()
    await schedule.sweep()
    expect(sent).toHaveLength(1)
  },
)

it.each(['write', 'rename'] as const)(
  'excludes a rejected add and retains an acknowledged add after %s failure',
  async (stage) => {
    const original = await schedule.add({ sessionId: 's', prompt: 'accepted', at: 5_000 })
    const error = failNext(stage)
    await expect(schedule.add({ sessionId: 's', prompt: 'rejected', at: 5_000 })).rejects.toBe(
      error,
    )
    expect(schedule.list()).toEqual([original])
    expect(await persisted()).toEqual([original])
    const restarted = make()
    await restarted.load()
    expect(restarted.list()).toEqual([original])
    now = 5_000
    await schedule.sweep()
    expect(sent).toEqual([
      { type: 'turn.start', sessionId: 's', text: 'accepted', attachments: [] },
    ])
  },
)

it.each(['write', 'rename'] as const)(
  'retains a rejected removal, then durably removes it after %s failure',
  async (stage) => {
    const original = await schedule.add({ sessionId: 's', prompt: 'retained', at: 5_000 })
    const error = failNext(stage)
    await expect(schedule.remove(original.id)).rejects.toBe(error)
    expect(schedule.list()).toEqual([original])
    const restarted = make()
    await restarted.load()
    expect(restarted.list()).toEqual([original])
    expect(await schedule.remove(original.id)).toBe(true)
    await restarted.load()
    expect(restarted.list()).toEqual([])
    now = 5_000
    await schedule.sweep()
    await restarted.sweep()
    expect(sent).toEqual([])
  },
)

it.each(['write', 'rename'] as const)(
  'retains a rejected cancellation, then durably cancels after %s failure',
  async (stage) => {
    await runTurn('error')
    await schedule.schedule('s', 5_000)
    const error = failNext(stage)
    await expect(schedule.cancel('s')).rejects.toBe(error)
    expect(await schedule.get('s')).toBe(5_000)
    const restarted = make()
    await restarted.load()
    expect(await restarted.get('s')).toBe(5_000)
    expect(await schedule.cancel('s')).toBe(true)
    await restarted.load()
    expect(await restarted.get('s')).toBeNull()
  },
)

it.each(['write', 'rename'] as const)(
  'retains stale resumes when the get purge %s fails',
  async (stage) => {
    await runTurn('error')
    const original = await schedule.schedule('s', 5_000)
    await runTurn('error')
    const error = failNext(stage)
    await expect(schedule.get('s')).rejects.toBe(error)
    expect(await persisted()).toEqual([original])
    // A second purge must still find the retained entry, including after restart.
    const restarted = make()
    await restarted.load()
    const retryError = failNext(stage)
    await expect(schedule.get('s')).rejects.toBe(retryError)
    expect(await restarted.get('s')).toBeNull()
    await schedule.load()
    expect(await schedule.get('s')).toBeNull()
    expect(await persisted()).toEqual([])
  },
)

it.each(['write', 'rename'] as const)(
  'retains due entries without dispatch when sweep %s fails',
  async (stage) => {
    const once = await schedule.add({ sessionId: 's', prompt: 'once', at: 5_000 })
    const repeating = await schedule.add({
      sessionId: 's',
      prompt: 'repeat',
      at: 5_000,
      every: MIN_EVERY_MS,
    })
    now = 5_000_000
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    failNext(stage)
    await schedule.sweep()
    expect(warning).toHaveBeenCalledWith(
      '[ari:desktop:resume] resume sweep failed',
      expect.objectContaining({ error: `Error: injected ${stage} failure` }),
    )
    expect(sent).toEqual([])
    expect(schedule.list()).toEqual([once, repeating])
    const restarted = make()
    await restarted.load()
    expect(restarted.list()).toEqual([once, repeating])
    await Promise.all([schedule.sweep(), schedule.sweep(), schedule.sweep()])
    expect(sent).toHaveLength(2)
    expect(schedule.list()).toEqual([{ ...repeating, at: 5_105_000 }])
    await restarted.load()
    await restarted.sweep()
    expect(sent).toHaveLength(2)
    now = 5_105_000
    await schedule.sweep()
    expect(sent).toHaveLength(3)
  },
)

it('serializes overlapping add, schedule, remove, cancel, get, and sweep against one durable snapshot', async () => {
  await runTurn('error')
  const removed = await schedule.add({ sessionId: 's', prompt: 'remove me', at: 10_000 })
  const resume = await schedule.schedule('s', 10_000)
  const held = holdNextWrite()
  const adding = schedule.add({ sessionId: 's', prompt: 'due', at: now })
  await held.entered
  const visibleDuringWrite = schedule.list()
  const diskDuringWrite = await persisted()
  const results = Promise.allSettled([
    adding,
    schedule.schedule('s', now),
    schedule.remove(removed.id),
    schedule.cancel('s'),
    schedule.get('s'),
    schedule.sweep(),
  ])
  held.release()
  const outcomes = await results
  expect(visibleDuringWrite).toEqual([removed])
  expect(diskDuringWrite).toEqual([removed, resume])
  expect(outcomes.map((outcome) => outcome.status)).toEqual(
    Array.from({ length: 6 }, () => 'fulfilled'),
  )
  expect(outcomes[2]).toMatchObject({ value: true })
  expect(outcomes[3]).toMatchObject({ value: true })
  expect(outcomes[4]).toMatchObject({ value: null })
  expect(sent).toEqual([{ type: 'turn.start', sessionId: 's', text: 'due', attachments: [] }])
  expect(schedule.list()).toEqual([])
  expect(await schedule.get('s')).toBeNull()
  expect(await persisted()).toEqual([])
  const restarted = make()
  await restarted.load()
  await restarted.sweep()
  expect(sent).toHaveLength(1)
})

it('continues the transaction queue after an overlapping write rejects', async () => {
  const entered = deferred()
  const released = deferred()
  const error = new Error('blocked write failed')
  vi.mocked(writeFile).mockImplementationOnce(async () => {
    entered.resolve()
    await released.promise
    throw error
  })
  const rejected = schedule.add({ sessionId: 's', prompt: 'rejected', at: now })
  await entered.promise
  const results = Promise.allSettled([
    rejected,
    schedule.add({ sessionId: 's', prompt: 'accepted', at: 5_000 }),
    schedule.sweep(),
  ])
  released.resolve()
  const outcomes = await results
  expect(outcomes[0]).toMatchObject({ status: 'rejected', reason: error })
  expect(outcomes[1]).toMatchObject({ status: 'fulfilled', value: { prompt: 'accepted' } })
  expect(outcomes[2]).toMatchObject({ status: 'fulfilled' })
  expect(schedule.list()).toMatchObject([{ prompt: 'accepted' }])
  expect(await persisted()).toEqual(schedule.list())
  expect(sent).toEqual([])
})

it('orders a stale get purge before a concurrently scheduled replacement', async () => {
  await runTurn('error')
  await schedule.schedule('s', 5_000)
  await runTurn('error')
  const entered = deferred()
  const released = deferred()
  const loadSession = store.load.bind(store)
  vi.spyOn(store, 'load').mockImplementationOnce(async (sessionId) => {
    const model = await loadSession(sessionId)
    entered.resolve()
    await released.promise
    return model
  })
  const getting = schedule.get('s')
  await entered.promise
  const results = Promise.allSettled([getting, schedule.schedule('s', 6_000)])
  const readsWhileGetting = vi.mocked(store.load).mock.calls.length
  released.resolve()
  expect((await results).map((outcome) => outcome.status)).toEqual(['fulfilled', 'fulfilled'])
  expect(readsWhileGetting).toBe(1)
  expect(await schedule.get('s')).toBe(6_000)
  const restarted = make()
  await restarted.load()
  expect(await restarted.get('s')).toBe(6_000)
})

it('orders load after a pending mutation instead of replacing it with the old disk state', async () => {
  const original = await schedule.add({ sessionId: 's', prompt: 'original', at: 5_000 })
  const held = holdNextWrite()
  const adding = schedule.add({ sessionId: 's', prompt: 'new', at: 6_000 })
  await held.entered
  const results = Promise.allSettled([adding, schedule.load()])
  held.release()
  const outcomes = await results
  expect(outcomes.map((outcome) => outcome.status)).toEqual(['fulfilled', 'fulfilled'])
  expect(schedule.list()).toMatchObject([original, { prompt: 'new', at: 6_000 }])
  expect(await persisted()).toEqual(schedule.list())
})

it.each(['EACCES', 'EIO', 'EISDIR'])(
  'rejects %s reads and retains the last loaded state',
  async (code) => {
    const original = await schedule.add({ sessionId: 's', prompt: 'retained', at: 5_000 })
    const error = Object.assign(new Error('cannot read schedule'), { code })
    vi.mocked(readFile).mockRejectedValueOnce(error)
    await expect(schedule.load()).rejects.toBe(error)
    expect(schedule.list()).toEqual([original])
    expect(await persisted()).toEqual([original])
    await schedule.load()
    expect(schedule.list()).toEqual([original])
  },
)

it('loads a genuinely missing file as empty without replaying an orphan temporary file', async () => {
  await disk.writeFile(
    join(dir, 'resume.json.tmp'),
    JSON.stringify([{ id: 'orphan', sessionId: 's', prompt: 'unacknowledged', at: now }]),
    'utf8',
  )
  await schedule.load()
  expect(schedule.list()).toEqual([])
  await schedule.sweep()
  expect(sent).toEqual([])
})

it('never lets a concurrent remove write to the temporary file owned by a blocked add', async () => {
  const removed = await schedule.add({ sessionId: 's', prompt: 'removed', at: 5_000 })
  // The directory already exists. An immediately resolved mkdir makes the next
  // microtask a deterministic boundary for an unqueued remove to enter writeFile.
  vi.mocked(mkdir).mockResolvedValue(undefined)
  vi.mocked(writeFile).mockClear()
  const held = holdNextWrite()
  const adding = schedule.add({ sessionId: 's', prompt: 'kept', at: 6_000 })
  await held.entered
  const removing = schedule.remove(removed.id)
  const results = Promise.allSettled([adding, removing])
  await Promise.resolve()
  const writesWhileOwned = vi.mocked(writeFile).mock.calls.length
  held.release()
  const outcomes = await results
  expect(writesWhileOwned).toBe(1)
  expect(outcomes.map((outcome) => outcome.status)).toEqual(['fulfilled', 'fulfilled'])
  expect(outcomes[1]).toMatchObject({ value: true })
  expect(await persisted()).toEqual(schedule.list())
  expect(schedule.list()).toMatchObject([{ prompt: 'kept' }])
})

it('releases state ownership before dispatch reenters every scheduler API', async () => {
  await runTurn('error')
  let reentered = false
  let reported: number | null = null
  let removed = false
  let cancelled = false
  schedule = make({
    dispatch: async (command) => {
      sent.push(command)
      await schedule.schedule('s', 5_000)
      reported = await schedule.get('s')
      const routine = await schedule.add({ sessionId: 's', prompt: 'temporary', at: 6_000 })
      removed = await schedule.remove(routine.id)
      cancelled = await schedule.cancel('s')
      await schedule.load()
      await schedule.sweep()
      reentered = true
      return { accepted: true }
    },
  })
  await schedule.add({ sessionId: 's', prompt: 'trigger', at: now })
  await schedule.sweep()
  expect(reentered).toBe(true)
  expect(reported).toBe(5_000)
  expect(removed).toBe(true)
  expect(cancelled).toBe(true)
  expect(sent).toHaveLength(1)
  expect(await persisted()).toEqual([])
})

it('persists consumption before acceptance and never replays that crash window after restart', async () => {
  const entered = deferred()
  const released = deferred()
  schedule = make({
    dispatch: async (command) => {
      entered.resolve()
      await released.promise
      sent.push(command)
      return { accepted: true }
    },
  })
  await schedule.add({ sessionId: 's', prompt: 'claimed', at: now })
  const sweeping = schedule.sweep()
  await entered.promise
  let snapshot: RoutineEntry[]
  try {
    snapshot = await persisted()
    const restarted = make()
    await restarted.load()
    await restarted.sweep()
  } finally {
    released.resolve()
    await sweeping
  }
  // If the process dies in the blocked dispatch, this occurrence is lost by
  // design. Retrying an uncertain dispatch would violate at-most-once semantics.
  expect(snapshot).toEqual([])
  expect(sent).toHaveLength(1)
  await schedule.sweep()
  expect(sent).toHaveLength(1)
})

it.each(['refused', 'threw'] as const)(
  'never blindly retries a dispatch that %s',
  async (outcome) => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    let attempts = 0
    schedule = make({
      dispatch: async (command) => {
        attempts++
        if (outcome === 'threw') {
          sent.push(command)
          throw new Error('uncertain delivery after acceptance')
        }
        return { accepted: false, reason: 'busy' }
      },
    })
    await schedule.add({ sessionId: 's', prompt: 'claimed', at: now })
    await schedule.sweep()
    await schedule.sweep()
    const restarted = make()
    await restarted.load()
    await restarted.sweep()
    expect(attempts).toBe(1)
    expect(sent).toHaveLength(outcome === 'threw' ? 1 : 0)
    expect(await persisted()).toEqual([])
  },
)

it('coalesces timer ticks during slow dispatch without queuing a catch-up burst', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  const entered = deferred()
  const released = deferred()
  schedule = make({
    dispatch: async (command) => {
      sent.push(command)
      entered.resolve()
      await released.promise
      return { accepted: true }
    },
  })
  const repeating = await schedule.add({
    sessionId: 's',
    prompt: 'repeat',
    at: now,
    every: MIN_EVERY_MS,
  })
  schedule.start()
  const sweeping = schedule.sweep()
  await entered.promise
  try {
    now = 5_000_000
    await vi.advanceTimersByTimeAsync(20_000 * 20)
  } finally {
    schedule.close()
    released.resolve()
    await sweeping
  }
  expect(sent).toHaveLength(1)
  expect(schedule.list()).toEqual([{ ...repeating, at: 1_000 + MIN_EVERY_MS }])
  // The next actual sweep skips every missed slot, and fires only once.
  await schedule.sweep()
  expect(sent).toHaveLength(2)
  expect(schedule.list()[0]?.at).toBeGreaterThan(now)
  await schedule.sweep()
  expect(sent).toHaveLength(2)
})

it('returns snapshots so callers cannot mutate the committed schedule without persistence', async () => {
  await runTurn('error')
  const routine = await schedule.add({ sessionId: 's', prompt: 'original', at: 5_000 })
  const resume = await schedule.schedule('s', 5_000)
  const expected = [{ ...routine }, { ...resume }]
  routine.at = now
  routine.prompt = 'modified'
  resume.at = now
  const listed = schedule.list()[0]!
  listed.at = now
  listed.prompt = 'modified again'
  expect(schedule.list()).toEqual([expected[0]])
  expect(await schedule.get('s')).toBe(5_000)
  expect(await persisted()).toEqual(expected)
  await schedule.sweep()
  expect(sent).toEqual([])
})
