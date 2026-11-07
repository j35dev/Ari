// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SessionStore } from '@ari/engine/session-store'
import { DriverRegistry } from '@ari/providers/registry'
import type { ProviderAdapter } from '@ari/providers/driver'
import { Engine } from './engine'

function gate() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

let directory: string
let store: SessionStore
let registry: DriverRegistry
let engine: Engine
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ari-shutdown-'))
  store = new SessionStore({ rootDir: join(directory, 'sessions') })
  registry = new DriverRegistry()
  engine = new Engine({
    store,
    registry,
    publish: () => undefined,
    resolveWorkspace: async () => directory,
    git: { captureCheckpoint: async () => ({ ok: true, value: null }) },
  })
  await engine.createSession({
    id: 's',
    projectId: 'adhoc',
    title: 'Test',
    driverKind: 'claude',
    modelId: null,
    permissionMode: 'ask',
    status: 'idle',
    createdAt: 1,
    updatedAt: 1,
  })
})
afterEach(async () => {
  await engine.shutdown()
  await store.closeJournal('s')
  await rm(directory, { recursive: true, force: true, maxRetries: 3 })
})

it('interrupts a live provider, awaits disposal, and does not start queued work on quit', async () => {
  const finish = gate()
  const disposed = gate()
  const interrupt = vi.fn() // An unresponsive provider never acknowledges cancel.
  const dispose = vi.fn(() => {
    finish.resolve()
    return disposed.promise
  })
  const started = gate()
  const create = vi.fn(async () => ({
    start: () => ({
      async *[Symbol.asyncIterator]() {
        started.resolve()
        await finish.promise
        yield { type: 'done' as const }
      },
    }),
    interrupt,
    dispose,
  }))
  registry.register({ kind: 'claude', create })
  try {
    await engine.dispatch({ type: 'turn.start', sessionId: 's', text: 'work', attachments: [] })
    await started.promise
    await engine.dispatch({
      type: 'message.enqueue',
      sessionId: 's',
      text: 'next',
      attachments: [],
    })
    const shutdown = engine.shutdown()
    expect(engine.shutdown()).toBe(shutdown)
    let closed = false
    void shutdown.then(() => {
      closed = true
    })
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce())
    expect(interrupt).toHaveBeenCalledOnce()
    expect(closed).toBe(false)
    expect(
      await engine.dispatch({ type: 'turn.start', sessionId: 's', text: 'late', attachments: [] }),
    ).toEqual({ accepted: false, reason: 'Ari is shutting down' })
    disposed.resolve()
    await shutdown
    expect(create).toHaveBeenCalledOnce()
    expect(engine.hasLiveTurn('s')).toBe(false)
    expect((await store.load('s')).lastTurn?.stopReason).toBe('interrupted')
    expect((await store.load('s')).queuedMessages.map((message) => message.text)).toEqual(['next'])
  } finally {
    finish.resolve()
    disposed.resolve()
  }
})

it('disposes a provider whose creation finishes after shutdown without starting its prompt', async () => {
  const creating = gate()
  const created = gate()
  const start = vi.fn(() => ({
    async *[Symbol.asyncIterator]() {
      yield { type: 'done' as const }
    },
  }))
  const interrupt = vi.fn()
  const dispose = vi.fn(async () => undefined)
  registry.register({
    kind: 'claude',
    create: async () => {
      creating.resolve()
      await created.promise
      return { start, interrupt, dispose }
    },
  })
  try {
    await engine.dispatch({ type: 'turn.start', sessionId: 's', text: 'work', attachments: [] })
    await creating.promise
    const shutdown = engine.shutdown()
    created.resolve()
    await shutdown
    expect(start).not.toHaveBeenCalled()
    expect(interrupt).toHaveBeenCalledOnce()
    expect(dispose).toHaveBeenCalledOnce()
    expect((await store.load('s')).activeTurnId).toBeNull()
  } finally {
    created.resolve()
  }
})

it('does not launch a provider after pending runtime initialization completes during shutdown', async () => {
  const initializing = gate()
  const initialized = gate()
  const create = vi.fn<() => Promise<ProviderAdapter>>()
  registry.register({ kind: 'claude', create })
  engine = new Engine({
    store,
    registry,
    publish: () => undefined,
    resolveWorkspace: async () => directory,
    runtimeEnvironment: async () => {
      initializing.resolve()
      await initialized.promise
      return {}
    },
    git: { captureCheckpoint: async () => ({ ok: true, value: null }) },
  })
  try {
    await engine.dispatch({ type: 'turn.start', sessionId: 's', text: 'work', attachments: [] })
    await initializing.promise
    const shutdown = engine.shutdown()
    initialized.resolve()
    await shutdown
    expect(create).not.toHaveBeenCalled()
    expect((await store.load('s')).activeTurnId).toBeNull()
  } finally {
    initialized.resolve()
  }
})

it('disposes a late-starting provider even when its cancellation throws', async () => {
  const creating = gate()
  const created = gate()
  const start = vi.fn(() => ({
    async *[Symbol.asyncIterator]() {
      yield { type: 'done' as const }
    },
  }))
  const dispose = vi.fn(async () => undefined)
  registry.register({
    kind: 'claude',
    create: async () => {
      creating.resolve()
      await created.promise
      return {
        start,
        interrupt: () => {
          throw new Error('late transport cancellation failed')
        },
        dispose,
      }
    },
  })
  try {
    await engine.dispatch({ type: 'turn.start', sessionId: 's', text: 'work', attachments: [] })
    await creating.promise
    const shutdown = engine.shutdown()
    created.resolve()
    await shutdown
    expect(start).not.toHaveBeenCalled()
    expect(dispose).toHaveBeenCalledOnce()
    expect((await store.load('s')).activeTurnId).toBeNull()
  } finally {
    created.resolve()
  }
})

it('closes transports retained by dispose before waiting for the provider stream to end', async () => {
  const started = gate()
  const transportClosed = gate()
  const dispose = vi.fn(async () => undefined) // Like ACP: parks the transport.
  const closeRetained = vi.fn(async () => {
    transportClosed.resolve()
  })
  registry.register({
    kind: 'claude',
    create: async () => ({
      start: () => ({
        async *[Symbol.asyncIterator]() {
          started.resolve()
          await transportClosed.promise
          yield { type: 'done' as const }
        },
      }),
      interrupt: () => undefined,
      dispose,
      keepsBackgroundWork: () => true,
    }),
  })
  try {
    await engine.dispatch({ type: 'turn.start', sessionId: 's', text: 'work', attachments: [] })
    await started.promise
    await engine.shutdown(closeRetained)
    expect(dispose).toHaveBeenCalledOnce()
    expect(closeRetained).toHaveBeenCalled()
    expect(engine.hasLiveTurn('s')).toBe(false)
    expect((await store.load('s')).lastTurn?.stopReason).toBe('interrupted')
  } finally {
    transportClosed.resolve()
  }
})

it('does not start a prompt when shutdown races the final startup model read', async () => {
  const checked = gate()
  const release = gate()
  const start = vi.fn(() => ({
    async *[Symbol.asyncIterator]() {
      yield { type: 'done' as const }
    },
  }))
  const load = store.load.bind(store)
  registry.register({
    kind: 'claude',
    create: async () => {
      vi.spyOn(store, 'load').mockImplementationOnce(async (id) => {
        const snapshot = await load(id)
        checked.resolve()
        await release.promise
        return snapshot
      })
      return { start, interrupt: () => undefined, dispose: async () => undefined }
    },
  })
  try {
    await engine.dispatch({ type: 'turn.start', sessionId: 's', text: 'work', attachments: [] })
    await checked.promise
    const shutdown = engine.shutdown()
    release.resolve()
    await shutdown
    expect(start).not.toHaveBeenCalled()
  } finally {
    release.resolve()
    vi.restoreAllMocks()
  }
})

it('still disposes a provider that throws while being cancelled', async () => {
  const started = gate()
  const finish = gate()
  const dispose = vi.fn(async () => {
    finish.resolve()
  })
  registry.register({
    kind: 'claude',
    create: async () => ({
      start: () => ({
        async *[Symbol.asyncIterator]() {
          started.resolve()
          await finish.promise
          yield { type: 'done' as const }
        },
      }),
      interrupt: () => {
        throw new Error('transport already failed')
      },
      dispose,
    }),
  })
  try {
    await engine.dispatch({ type: 'turn.start', sessionId: 's', text: 'work', attachments: [] })
    await started.promise
    await engine.shutdown()
    expect(dispose).toHaveBeenCalledOnce()
    expect((await store.load('s')).activeTurnId).toBeNull()
  } finally {
    finish.resolve()
  }
})
