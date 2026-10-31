// @vitest-environment node
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GitService } from '@ari/engine/git'
import { SessionStore } from '@ari/engine/session-store'
import { DriverRegistry } from '@ari/providers/registry'
import type { AgentEvent } from '@ari/contracts/agent-event'
import type { JournalEvent } from '@ari/contracts/events'
import { Engine } from './engine'
import { queryTurnDiff } from './turn-diff'

let repo: string
let store: SessionStore
const git = new GitService()
const run = (...args: string[]): string =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf8' })

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'ari-turn-snapshots-'))
  store = new SessionStore({ rootDir: join(repo, '.journals') })
  run('init', '-q')
  run('config', 'core.autocrlf', 'false')
  await writeFile(join(repo, '.gitignore'), '.journals/\n')
  await writeFile(join(repo, 'a.txt'), 'before\n')
  run('add', '.')
  run(
    '-c',
    'user.name=test',
    '-c',
    'user.email=test@ari.dev',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-qm',
    'initial',
  )
  await store.append('sess_1', {
    type: 'session.created',
    session: {
      id: 'sess_1',
      projectId: repo,
      title: 'Snapshots',
      driverKind: 'claude',
      modelId: null,
      permissionMode: 'ask',
      status: 'idle',
      createdAt: 1,
      updatedAt: 1,
    },
  })
})

afterEach(async () => {
  await rm(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

function engine(
  start: () => AsyncGenerator<AgentEvent>,
  dispose: () => Promise<void>,
  capturer = git,
) {
  const registry = new DriverRegistry()
  registry.register({
    kind: 'claude',
    create: async () => ({ start, dispose, interrupt: () => undefined }),
  })
  const events: JournalEvent[] = []
  return {
    events,
    engine: new Engine({
      store,
      registry,
      git: capturer,
      publish: (_id, event) => events.push(event),
    }),
  }
}

const done = async function* (): AsyncGenerator<AgentEvent> {
  yield { type: 'done' }
}

describe('immutable turn snapshots', { timeout: 30_000 }, () => {
  it('captures after disposal and before settle, excluding later manual and committed edits', async () => {
    const { engine: host, events } = engine(done, async () => {
      await writeFile(join(repo, 'a.txt'), 'final provider write\n')
      await writeFile(join(repo, 'new.txt'), 'new provider file\n')
    })
    const index = run('write-tree')
    await host.dispatch({ type: 'turn.start', sessionId: 'sess_1', text: 'edit', attachments: [] })
    await host.quiesce('sess_1')
    const model = await store.load('sess_1')
    const checkpoint = model.checkpoints[0]!
    expect(checkpoint.endRef).toMatch(/^refs\/ari-turn-ends\/sess_1\//)
    expect(events.findIndex((event) => event.type === 'checkpoint.completed')).toBeLessThan(
      events.findIndex((event) => event.type === 'turn.settled'),
    )
    expect(run('write-tree')).toBe(index)
    await writeFile(join(repo, 'a.txt'), 'manual after turn\n')
    run('add', '.')
    run(
      '-c',
      'user.name=test',
      '-c',
      'user.email=test@ari.dev',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-qm',
      'later',
    )
    const diff = await queryTurnDiff(git, {
      path: repo,
      turnId: checkpoint.turnId,
      checkpoints: model.checkpoints,
    })
    expect(diff.diffText).toContain('+final provider write')
    expect(diff.diffText).toContain('+new provider file')
    expect(diff.diffText).not.toContain('manual after turn')
    await store.closeJournal('sess_1')
    expect((await store.load('sess_1')).checkpoints).toEqual(model.checkpoints)
  })

  it('waits for interrupted provider disposal and retains a stable endpoint', async () => {
    let release!: () => void
    const waiting = new Promise<void>((resolve) => {
      release = resolve
    })
    let started!: () => void
    const ready = new Promise<void>((resolve) => {
      started = resolve
    })
    const { engine: host } = engine(
      async function* () {
        started()
        await waiting
        yield { type: 'done' }
      },
      async () => {
        await writeFile(join(repo, 'a.txt'), 'interrupted cleanup\n')
      },
    )
    await host.dispatch({ type: 'turn.start', sessionId: 'sess_1', text: 'edit', attachments: [] })
    await ready
    await host.dispatch({ type: 'turn.interrupt', sessionId: 'sess_1' })
    expect(host.hasLiveTurn('sess_1')).toBe(true)
    release()
    await host.quiesce('sess_1')
    const model = await store.load('sess_1')
    expect(model.lastTurn?.stopReason).toBe('interrupted')
    const diff = await queryTurnDiff(git, {
      path: repo,
      turnId: model.checkpoints[0]!.turnId,
      checkpoints: model.checkpoints,
    })
    expect(diff.diffText).toContain('+interrupted cleanup')
    expect(host.hasLiveTurn('sess_1')).toBe(false)
  })

  it('captures error turns and records unavailable end snapshots without a live fallback', async () => {
    const captureEnd = vi.spyOn(git, 'captureTurnEnd').mockResolvedValueOnce({
      ok: false,
      error: { code: 'command_failed', message: 'snapshot failed' },
    })
    const { engine: host } = engine(
      async function* () {
        await writeFile(join(repo, 'a.txt'), 'partial edit\n')
        yield { type: 'error', message: 'provider failed', rawJson: null }
      },
      async () => undefined,
    )
    try {
      await host.dispatch({
        type: 'turn.start',
        sessionId: 'sess_1',
        text: 'edit',
        attachments: [],
      })
      await host.quiesce('sess_1')
      const model = await store.load('sess_1')
      expect(model.lastTurn?.stopReason).toBe('error')
      expect(model.checkpoints[0]?.endError).toBe('snapshot failed')
      expect(
        await queryTurnDiff(git, {
          path: repo,
          turnId: model.checkpoints[0]!.turnId,
          checkpoints: model.checkpoints,
        }),
      ).toEqual({ diffText: null, error: 'snapshot failed' })
    } finally {
      captureEnd.mockRestore()
    }
  })

  it('never repins endpoints or the session baseline and prunes turn pairs without losing the baseline', async () => {
    const before = await git.captureCheckpoint(repo, 'sess_1', 'turn_1')
    if (!before.ok || !before.value) throw new Error('missing checkpoint')
    const baseline = await git.pinSessionBaseline(repo, 'sess_1', before.value)
    if (!baseline.ok) throw new Error('missing baseline')
    const initial = run('rev-parse', baseline.value)
    await writeFile(join(repo, 'a.txt'), 'turn one\n')
    const end = await git.captureTurnEnd(repo, 'sess_1', 'turn_1')
    if (!end.ok || !end.value) throw new Error('missing end')
    const endpoint = run('rev-parse', end.value)
    await writeFile(join(repo, 'a.txt'), 'turn two\n')
    const next = await git.captureCheckpoint(repo, 'sess_1', 'turn_2')
    if (!next.ok || !next.value) throw new Error('missing checkpoint')
    expect(await git.captureTurnEnd(repo, 'sess_1', 'turn_1')).toEqual(end)
    await git.pinSessionBaseline(repo, 'sess_1', next.value)
    expect(run('rev-parse', baseline.value)).toBe(initial)
    expect(run('rev-parse', end.value)).toBe(endpoint)
    await git.pruneCheckpoints(repo, 'sess_1', ['turn_1', 'turn_2'], 1)
    expect(run('for-each-ref', '--format=%(refname)', 'refs/ari-turn-ends/sess_1/')).toBe('')
    expect(run('rev-parse', baseline.value)).toBe(initial)
    expect(await git.captureTurnEnd(repo, '../bad', 'turn')).toMatchObject({
      ok: false,
      error: { code: 'invalid_ref' },
    })
    expect(await git.pinSessionBaseline(repo, 'sess_1', '--all')).toMatchObject({
      ok: false,
      error: { code: 'invalid_ref' },
    })
  })
})
