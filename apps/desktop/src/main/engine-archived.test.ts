// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { JournalEvent } from '@ari/contracts/events'
import type { Session } from '@ari/contracts/session'
import { SessionStore } from '@ari/engine/session-store'
import { DriverRegistry } from '@ari/providers/registry'
import type { AdapterSession } from '@ari/providers/driver'
import { Engine, type EngineDeps } from './engine'

let dir: string
let store: SessionStore
let stores: SessionStore[]
let engine: Engine
let published: JournalEvent[]
let providers: AdapterSession[]
let environmentSessions: Session[]
let release: () => void

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ari-archived-'))
  store = new SessionStore({ rootDir: join(dir, 'sessions') })
  stores = [store]
  published = []
  providers = []
  environmentSessions = []
  release = () => undefined
})

afterEach(async () => {
  release()
  if (engine) await engine.quiesce('target')
  for (const opened of stores) {
    for (const id of ['target', 'root', 'descendant']) await opened.closeJournal(id)
  }
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

function makeEngine(authorizeTurn?: EngineDeps['authorizeTurn'], firstTurnGate?: Promise<void>) {
  const registry = new DriverRegistry()
  registry.register({
    kind: 'claude',
    create: async (session) => {
      providers.push(session)
      const first = providers.length === 1
      return {
        start: () => ({
          async *[Symbol.asyncIterator]() {
            if (first) await firstTurnGate
            yield { type: 'text-delta' as const, text: 'Resumed work' }
            yield { type: 'done' as const }
          },
        }),
        interrupt: () => release(),
        dispose: async () => undefined,
      }
    },
  })
  engine = new Engine({
    store,
    registry,
    publish: (_id, event) => published.push(event),
    resolveWorkspace: async () => dir,
    runtimeEnvironment: async (session) => {
      environmentSessions.push(session)
      return { ARCHIVED_AT_START: String(session.archived) }
    },
    git: { captureCheckpoint: async () => ({ ok: true, value: null }) },
    authorizeTurn,
  })
  return engine
}

async function seed(child = false, archived = true) {
  if (child) {
    await store.append('root', {
      type: 'session.created',
      session: {
        id: 'root',
        projectId: 'project',
        title: 'Root',
        driverKind: 'claude',
        modelId: null,
        permissionMode: 'ask',
        status: 'idle',
        createdAt: 1,
        updatedAt: 1,
      },
    })
  }
  await store.append('target', {
    type: 'session.created',
    session: {
      id: 'target',
      projectId: 'project',
      title: 'Keep this title',
      driverKind: 'claude',
      modelId: null,
      permissionMode: 'ask',
      status: 'idle',
      createdAt: 1,
      updatedAt: 1,
      archived,
      pinned: true,
      ...(child ? { parentSessionId: 'root', rootSessionId: 'root' } : {}),
    },
  })
}

describe('archived session reprompts', () => {
  for (const child of [false, true]) {
    it.each(['turn.start', 'message.enqueue'] as const)(
      `restores an archived ${child ? 'child' : 'root'} through %s durably and publishes the change`,
      async (type) => {
        const authorized: Session[] = []
        makeEngine(async (session) => {
          authorized.push(session)
          expect((await store.load('target')).session?.archived).toBe(true)
          return session.parentSessionId && session.archived ? 'Child is archived.' : null
        })
        await seed(child)
        const initial = (await store.load('target')).session!
        await store.append('descendant', {
          type: 'session.created',
          session: {
            ...initial,
            id: 'descendant',
            parentSessionId: 'target',
            rootSessionId: 'target',
          },
        })

        expect(
          await engine.dispatch({
            type,
            sessionId: 'target',
            text: 'Continue the work',
            attachments: [],
          }),
        ).toEqual({ accepted: true })
        await engine.quiesce('target')

        expect(authorized).toMatchObject([
          { archived: false, pinned: true, title: 'Keep this title' },
        ])
        expect(environmentSessions).toMatchObject([{ archived: false, status: 'running' }])
        expect(providers[0]?.runtimeEnv?.['ARCHIVED_AT_START']).toBe('false')
        const restoration = published.findIndex(
          (event) => event.type === 'session.updated' && event.archived === false,
        )
        expect(restoration).toBe(0)
        expect(published[restoration + 1]?.type).toBe('turn.started')

        await store.closeJournal('target')
        const reloaded = new SessionStore({ rootDir: join(dir, 'sessions') })
        stores.push(reloaded)
        expect((await reloaded.load('target')).session).toMatchObject({
          archived: false,
          pinned: true,
          title: 'Keep this title',
          status: 'idle',
        })
        expect((await reloaded.listSessions()).find((row) => row.id === 'target')).toMatchObject({
          archived: false,
          pinned: true,
          title: 'Keep this title',
          messageCount: 2,
        })
        expect((await reloaded.load('descendant')).session?.archived).toBe(true)
      },
    )
  }

  for (const reason of [
    'Maximum concurrent child sessions reached.',
    'Delegation tree token cap reached.',
  ]) {
    it.each(['turn.start', 'message.enqueue'] as const)(
      `leaves a rejected archived child unchanged through %s when ${reason}`,
      async (type) => {
        makeEngine(async (session) => (session.archived ? 'Child is archived.' : reason))
        await seed(true)
        const before = await store.load('target')
        expect(
          await engine.dispatch({ type, sessionId: 'target', text: 'Continue', attachments: [] }),
        ).toEqual({ accepted: false, reason })
        expect(await store.load('target')).toEqual(before)
        expect((await store.listSessions()).find((row) => row.id === 'target')).toMatchObject({
          archived: true,
          pinned: true,
          title: 'Keep this title',
          messageCount: 0,
        })
        expect(published).toEqual([])
        expect(providers).toEqual([])
        await store.closeJournal('target')
        const reloaded = new SessionStore({ rootDir: join(dir, 'sessions') })
        stores.push(reloaded)
        expect(await reloaded.load('target')).toEqual(before)
      },
    )
  }

  it('restores a running archived child when a human follow-up is accepted and then drains it', async () => {
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    makeEngine(async (session) => (session.archived ? 'Child is archived.' : null), gate)
    await seed(true, false)
    await engine.dispatch({
      type: 'turn.start',
      sessionId: 'target',
      text: 'First',
      attachments: [],
    })
    await expect.poll(() => providers.length).toBe(1)
    await engine.dispatch({ type: 'session.update', sessionId: 'target', archived: true })
    const result = await engine.dispatch({
      type: 'message.enqueue',
      sessionId: 'target',
      text: 'Follow-up',
      attachments: [],
    })
    const queued = await store.load('target')
    release()
    await engine.quiesce('target')

    expect(result).toEqual({ accepted: true })
    expect(queued.session).toMatchObject({
      archived: false,
      pinned: true,
      title: 'Keep this title',
    })
    expect(queued.queuedMessages).toEqual([{ text: 'Follow-up', attachments: [] }])
    await expect
      .poll(
        async () => (await store.load('target')).messages.filter((m) => m.role === 'user').length,
      )
      .toBe(2)
    await engine.quiesce('target')
    expect((await store.load('target')).queuedMessages).toEqual([])
    expect(providers).toHaveLength(2)
    expect(providers[1]?.runtimeEnv?.['ARCHIVED_AT_START']).toBe('false')
  })

  it.each([false, true])(
    'keeps held archived work queued across an automatic drain, child %s',
    async (child) => {
      makeEngine(async (session) =>
        session.parentSessionId && session.archived ? 'Child is archived.' : null,
      )
      await seed(child)
      expect((await engine.replaySession('target')).length).toBe(1)
      expect((await store.listSessions()).find((row) => row.id === 'target')?.archived).toBe(true)
      expect(
        await engine.dispatch({ type: 'session.update', sessionId: 'target', title: 'Renamed' }),
      ).toEqual({ accepted: true })
      expect(
        await engine.dispatch(
          {
            type: 'message.enqueue',
            sessionId: 'target',
            text: 'Delegated work',
            attachments: [],
            hold: true,
          },
          { kind: 'session', sessionId: 'root' },
        ),
      ).toEqual({ accepted: true })
      await engine.drainHeld()
      await engine.dispatch({ type: 'session.update', sessionId: 'target', pinned: true })
      expect(await store.load('target')).toMatchObject({
        activeTurnId: null,
        session: { archived: true, pinned: true, title: 'Renamed' },
        queuedMessages: [
          {
            text: 'Delegated work',
            attachments: [],
            held: true,
            origin: { kind: 'session', sessionId: 'root' },
          },
        ],
      })
      expect(providers).toEqual([])
    },
  )
})
