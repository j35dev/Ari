// @vitest-environment node
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SessionStore } from '@ari/engine/session-store'
import { DriverRegistry } from '@ari/providers/registry'
import type { AdapterSession } from '@ari/providers/driver'
import type { JournalEvent } from '@ari/contracts/events'
import { Engine } from './engine'

let repo: string
let store: SessionStore
const git = (...args: string[]): string =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf8' })
beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'ari-no-checkpoints-'))
  store = new SessionStore({ rootDir: join(repo, '.conversations') })
  git('init', '-q')
  git('config', 'core.autocrlf', 'false')
  await writeFile(join(repo, '.gitignore'), '.conversations/\n')
  await writeFile(join(repo, 'file.txt'), 'User staged work\n')
  git('add', '.')
  await writeFile(join(repo, 'file.txt'), 'User uncommitted work\n')
  await store.append('s', {
    type: 'session.created',
    session: {
      id: 's',
      projectId: repo,
      title: 'Fast conversation',
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
  await store.close()
  await rm(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

it('starts and completes a conversation without calling Git capture, baseline or pruning', async () => {
  const index = git('write-tree')
  const captures = {
    captureCheckpoint: vi.fn(() => new Promise<never>(() => {})),
    captureTurnEnd: vi.fn(() => new Promise<never>(() => {})),
    pinSessionBaseline: vi.fn(() => new Promise<never>(() => {})),
    pruneCheckpoints: vi.fn(() => new Promise<never>(() => {})),
  }
  const registry = new DriverRegistry()
  registry.register({
    kind: 'claude',
    create: async () => ({
      start: async function* () {
        yield { type: 'text-delta' as const, text: 'Immediate provider reply' }
        yield { type: 'session-ref' as const, ref: 'native-thread' }
        yield { type: 'done' as const }
      },
      dispose: async () => {
        await writeFile(join(repo, 'new.txt'), 'Provider edit\n')
      },
      interrupt: () => {},
    }),
  })
  const host = new Engine({ store, registry, git: captures, publish: () => {} })
  expect(
    (await host.dispatch({ type: 'turn.start', sessionId: 's', text: 'Hello', attachments: [] }))
      .accepted,
  ).toBe(true)
  await host.quiesce('s')
  for (const capture of Object.values(captures)) expect(capture).not.toHaveBeenCalled()
  expect((await store.load('s')).checkpoints).toEqual([])
  expect(
    git(
      'for-each-ref',
      '--format=%(refname)',
      'refs/ari',
      'refs/ari-baselines',
      'refs/ari-turn-ends',
    ),
  ).toBe('')
  expect(git('write-tree')).toBe(index)
  expect(await readFile(join(repo, 'file.txt'), 'utf8')).toBe('User uncommitted work\n')
  await store.closeJournal('s')
  const reopened = await store.load('s')
  expect(reopened.providerSessionId).toBe('native-thread')
  expect(reopened.messages.at(-1)?.parts).toEqual([
    { type: 'text', text: 'Immediate provider reply' },
  ])
  const resumed: JournalEvent[] = []
  const outcome = await host.replaySessionRangeChunks(
    's',
    { afterSeq: 2, throughSeq: reopened.lastSeq },
    async (events) => {
      resumed.push(...events)
    },
  )
  expect(outcome.outcome).toBe('complete')
  expect(resumed.map((event) => event.seq)).toEqual(
    Array.from({ length: reopened.lastSeq - 2 }, (_, index) => index + 3),
  )
})

it('refuses an old undo command without changing any workspace files', async () => {
  await store.append('s', {
    type: 'checkpoint.captured',
    turnId: 'legacy',
    gitRef: 'refs/ari/s/legacy',
  })
  const host = new Engine({ store, registry: new DriverRegistry(), publish: () => {} })
  const result = await host.dispatch({
    type: 'checkpoint.revert',
    sessionId: 's',
    turnId: 'legacy',
  })
  expect(result.accepted).toBe(false)
  expect(result.reason).toContain('removed')
  expect(await readFile(join(repo, 'file.txt'), 'utf8')).toBe('User uncommitted work\n')
})

it('continues a reopened conversation on its original native provider thread', async () => {
  const received: AdapterSession[] = []
  const registry = new DriverRegistry()
  registry.register({
    kind: 'claude',
    create: async (session) => {
      received.push(session)
      return {
        start: async function* () {
          yield { type: 'session-ref' as const, ref: 'persistent-native-thread' }
          yield { type: 'text-delta' as const, text: 'Saved reply' }
          yield { type: 'done' as const }
        },
        dispose: async () => {},
        interrupt: () => {},
      }
    },
  })
  const first = new Engine({ store, registry, publish: () => {} })
  await first.dispatch({
    type: 'turn.start',
    sessionId: 's',
    text: 'First message',
    attachments: [],
  })
  await first.quiesce('s')
  await store.close()
  store = new SessionStore({ rootDir: join(repo, '.conversations') })
  const second = new Engine({ store, registry, publish: () => {} })
  await second.dispatch({
    type: 'turn.start',
    sessionId: 's',
    text: 'Continue our conversation',
    attachments: [],
  })
  await second.quiesce('s')
  expect(received).toHaveLength(2)
  expect(received[1]?.resumeOf).toBe('persistent-native-thread')
  expect(received[1]?.permissionMode).toBe('ask')
  expect(
    (await store.load('s')).messages.filter((message) => message.role === 'user'),
  ).toHaveLength(2)
})
