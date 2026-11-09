import { UNKNOWN_PROVIDER_CAPABILITIES } from '@ari/providers/driver'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent } from '@ari/contracts/agent-event'
import type { JournalEvent } from '@ari/contracts/events'
import type { Command } from '@ari/contracts/commands'
import type { Session } from '@ari/contracts/session'
import { DriverRegistry } from '@ari/providers/registry'
import type {
  AdapterApprovalDecision,
  AdapterSession,
  Driver,
  ProviderAdapter,
} from '@ari/providers/driver'
import { SessionStore } from '@ari/engine/session-store'
import {
  deterministicTitleStrategy,
  type TitleRequest,
  type TitleStrategy,
} from '@ari/engine/title'
import { Engine, type EngineDeps } from './engine'

let dir: string
let store: SessionStore
let published: { sessionId: string; event: JournalEvent }[]
/** Extra scratch directories (project folders) created by individual tests. */
let dirs: string[]

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ari-engine-e2e-'))
  store = new SessionStore({ rootDir: dir })
  published = []
  dirs = []
})

afterEach(async () => {
  // Windows keeps a brief handle on journal files after the engine closes, so a
  // plain recursive rm intermittently hits ENOTEMPTY. Retry instead of flaking.
  const wipe = (target: string) =>
    rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  await wipe(dir)
  await Promise.all(dirs.map(wipe))
})

interface Script {
  echo: string
  toolName?: string
}

/** A scripted driver: emits fixture-like events then completes. */
function scriptedDriver(script: Script): Driver {
  function makeAdapter(_session: AdapterSession): ProviderAdapter {
    async function* start(): AsyncGenerator<AgentEvent> {
      yield { type: 'text-delta', text: script.echo }
      if (script.toolName) {
        yield { type: 'tool-started', callId: 'c1', name: script.toolName, argsJson: '{}' }
        yield { type: 'tool-completed', callId: 'c1', resultJson: '"ok"', isError: false }
      }
      yield { type: 'usage', inputTokens: 3, outputTokens: 2, cachedInputTokens: 1, costUsd: null }
      yield { type: 'context-usage', usedTokens: 5, windowTokens: 200 }
      yield { type: 'done' }
    }
    const iterator = start()[Symbol.asyncIterator]()
    return {
      start: () => ({ [Symbol.asyncIterator]: () => iterator }),
      interrupt: () => undefined,
      dispose: () => Promise.resolve(),
    }
  }
  return { kind: 'claude', create: (session) => Promise.resolve(makeAdapter(session)) }
}

async function seedSession(
  store: SessionStore,
  sessionId: string,
  projectId = 'proj_1',
  fields: Partial<Session> = {},
): Promise<void> {
  await store.append(sessionId, {
    type: 'session.created',
    session: {
      id: sessionId,
      projectId,
      title: 'E2E',
      driverKind: 'claude',
      modelId: null,
      permissionMode: 'ask',
      status: 'idle',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ...fields,
    },
  })
}

describe('Aria provider switching', () => {
  it.each([
    { failure: 'throw', hasRef: false },
    { failure: 'error', hasRef: false },
    { failure: 'stop', hasRef: false },
    { failure: 'throw', hasRef: true },
    { failure: 'error', hasRef: true },
    { failure: 'stop', hasRef: true },
  ] as const)(
    'retries the handoff after $failure before delivery (has ref: $hasRef)',
    async ({ failure, hasRef }) => {
      const created: AdapterSession[] = []
      const registry = new DriverRegistry()
      registry.register(recordingDriver('claude', created))
      let retry = false
      let started = false
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      registry.register({
        kind: 'opencode',
        create: async (session) => {
          created.push(session)
          return {
            start: () =>
              (async function* (): AsyncGenerator<AgentEvent> {
                started = true
                if (!retry) {
                  if (hasRef) yield { type: 'session-ref', ref: 'empty-thread' }
                  if (failure === 'throw') throw new Error('Start failed')
                  if (failure === 'error') {
                    yield { type: 'error', message: 'Start failed', rawJson: null }
                    return
                  }
                  await gate
                  return
                }
                yield { type: 'session-ref', ref: 'new-thread' }
                yield { type: 'done' }
              })(),
            interrupt: release,
            dispose: async () => undefined,
          }
        },
      })
      const releaseConnection = vi.fn(async () => undefined)
      const engine = engineWith(registry, { releaseProviderConnection: releaseConnection })
      await seedSession(store, 'aria', 'helm')
      await turn(engine, 'Remember the existing work.')
      await engine.dispatch({
        type: 'session.provider.switch',
        sessionId: 'aria',
        driverKind: 'opencode',
        modelId: 'chosen',
        effort: null,
      })
      await engine.dispatch({
        type: 'turn.start',
        sessionId: 'aria',
        text: 'Continue.',
        attachments: [],
      })
      await expect.poll(() => started).toBe(true)
      if (failure === 'stop') await engine.dispatch({ type: 'turn.interrupt', sessionId: 'aria' })
      await engine.quiesce('aria')
      expect((await store.load('aria')).providerSessionId).toBe(hasRef ? 'empty-thread' : null)
      expect((await store.load('aria')).providerHandoffPending).toBe(true)
      releaseConnection.mockClear()
      retry = true
      await turn(engine, 'Try again.')
      expect(created.at(-1)!.resumeOf).toBeNull()
      expect(created.at(-1)!.prompt).toContain('User: Remember the existing work.')
      expect(releaseConnection).toHaveBeenCalledWith('aria')
      expect((await store.load('aria')).providerHandoffPending).toBe(false)
    },
  )

  it('consumes a ref-less handoff only after a completed turn', async () => {
    const created: AdapterSession[] = []
    const registry = new DriverRegistry()
    registry.register(recordingDriver('claude', created))
    registry.register({
      kind: 'opencode',
      create: async (session) => {
        created.push(session)
        return {
          start: () =>
            (async function* (): AsyncGenerator<AgentEvent> {
              yield { type: 'done' }
            })(),
          interrupt: () => undefined,
          dispose: async () => undefined,
        }
      },
    })
    const engine = engineWith(registry)
    await seedSession(store, 'aria', 'helm')
    await turn(engine, 'Existing conversation.')
    await engine.dispatch({
      type: 'session.provider.switch',
      sessionId: 'aria',
      driverKind: 'opencode',
      modelId: null,
      effort: null,
    })
    await turn(engine, 'Continue.')
    expect((await store.load('aria')).providerHandoffPending).toBe(false)
    await turn(engine, 'Next.')
    expect(created.at(-1)!.prompt).not.toContain('Conversation so far')
  })

  it('serializes a provider switch behind turn authorization and journals the same provider the turn uses', async () => {
    const created: AdapterSession[] = []
    const registry = new DriverRegistry()
    registry.register(recordingDriver('claude', created))
    registry.register(recordingDriver('opencode', created))
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const authorize = vi.fn(async () => {
      await gate
      return null
    })
    const engine = new Engine({
      store,
      registry,
      publish: (sessionId, event) => published.push({ sessionId, event }),
      authorizeTurn: authorize,
      git: { captureCheckpoint: async () => ({ ok: true, value: null }) },
    })
    await seedSession(store, 'aria', 'helm')
    const starting = engine.dispatch({
      type: 'turn.start',
      sessionId: 'aria',
      text: 'First.',
      attachments: [],
    })
    await expect.poll(() => authorize.mock.calls.length).toBe(1)
    const switching = engine.dispatch({
      type: 'session.provider.switch',
      sessionId: 'aria',
      driverKind: 'opencode',
      modelId: 'chosen',
      effort: null,
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(published).toEqual([])
    release()
    expect(await starting).toEqual({ accepted: true })
    expect(await switching).toEqual({ accepted: true })
    await engine.quiesce('aria')
    expect(created[0]!.modelId).toBeNull()
    expect(published.findIndex((entry) => entry.event.type === 'turn.started')).toBeLessThan(
      published.findIndex((entry) => entry.event.type === 'session.provider.switched'),
    )
    await turn(engine, 'Second.')
    expect(created[1]!.modelId).toBe('chosen')
    expect(created[1]!.resumeOf).toBeNull()
  })

  it('releases a parked connection on switching and releases one parked by the finishing old turn', async () => {
    const releasePool = vi.fn(async () => undefined)
    try {
      const created: AdapterSession[] = []
      const registry = new DriverRegistry()
      registry.register(recordingDriver('claude', created))
      registry.register(recordingDriver('opencode', created))
      const engine = engineWith(registry, { releaseProviderConnection: releasePool })
      await seedSession(store, 'aria', 'helm')
      await turn(engine, 'First.')
      await engine.dispatch({
        type: 'session.provider.switch',
        sessionId: 'aria',
        driverKind: 'opencode',
        modelId: null,
        effort: null,
      })
      expect(releasePool).toHaveBeenCalledWith('aria')
      await turn(engine, 'Second.')
      releasePool.mockClear()
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      let started = false
      registry.register({
        kind: 'opencode',
        create: async () => ({
          start: () =>
            (async function* (): AsyncGenerator<AgentEvent> {
              started = true
              await gate
              yield { type: 'done' }
            })(),
          interrupt: release,
          dispose: async () => undefined,
          keepsBackgroundWork: () => true,
        }),
      })
      await engine.dispatch({
        type: 'turn.start',
        sessionId: 'aria',
        text: 'Working.',
        attachments: [],
      })
      await expect.poll(() => started).toBe(true)
      await engine.dispatch({
        type: 'session.provider.switch',
        sessionId: 'aria',
        driverKind: 'claude',
        modelId: null,
        effort: null,
      })
      release()
      await engine.quiesce('aria')
      expect(releasePool).toHaveBeenCalledTimes(2)
    } finally {
      releasePool.mockRestore()
    }
  })

  it('releases the old connection when Stop and a switch arrive during adapter creation', async () => {
    const releasePool = vi.fn(async () => undefined)
    try {
      const registry = new DriverRegistry()
      let creating = false
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const dispose = vi.fn(async () => undefined)
      registry.register({
        kind: 'claude',
        create: async () => {
          creating = true
          await gate
          return {
            start: () => (async function* (): AsyncGenerator<AgentEvent> {})(),
            interrupt: () => undefined,
            dispose,
          }
        },
      })
      const engine = engineWith(registry, { releaseProviderConnection: releasePool })
      await seedSession(store, 'aria', 'helm')
      await engine.dispatch({
        type: 'turn.start',
        sessionId: 'aria',
        text: 'First.',
        attachments: [],
      })
      await expect.poll(() => creating).toBe(true)
      await engine.dispatch({
        type: 'session.provider.switch',
        sessionId: 'aria',
        driverKind: 'opencode',
        modelId: null,
        effort: null,
      })
      await engine.dispatch({ type: 'turn.interrupt', sessionId: 'aria' })
      release()
      await engine.quiesce('aria')
      expect(dispose).toHaveBeenCalledOnce()
      expect(releasePool).toHaveBeenCalledTimes(2)
    } finally {
      releasePool.mockRestore()
    }
  })

  it.each(['text', 'tool'] as const)(
    'acknowledges delivery on the first agent %s despite a later error',
    async (output) => {
      const created: AdapterSession[] = []
      const registry = new DriverRegistry()
      registry.register(recordingDriver('claude', created))
      registry.register({
        kind: 'opencode',
        create: async (session) => {
          created.push(session)
          return {
            start: () =>
              (async function* (): AsyncGenerator<AgentEvent> {
                yield { type: 'session-ref', ref: 'accepted-thread' }
                if (output === 'text') yield { type: 'text-delta', text: 'Working on the request.' }
                else yield { type: 'tool-started', callId: 'work', name: 'Bash', argsJson: '{}' }
                yield { type: 'error', message: 'Later failure', rawJson: null }
              })(),
            interrupt: () => undefined,
            dispose: async () => undefined,
          }
        },
      })
      const engine = engineWith(registry)
      await seedSession(store, 'aria', 'helm')
      await turn(engine, 'Remember the request.')
      await engine.dispatch({
        type: 'session.provider.switch',
        sessionId: 'aria',
        driverKind: 'opencode',
        modelId: null,
        effort: null,
      })
      await turn(engine, 'Continue.')
      expect((await store.load('aria')).providerHandoffPending).toBe(false)
      expect((await store.load('aria')).lastTurn?.stopReason).toBe('error')
      await turn(engine, 'Retry.')
      expect(created.at(-1)!.resumeOf).toBe('accepted-thread')
      expect(created.at(-1)!.prompt).not.toContain('Conversation so far')
    },
  )

  it.each(['output', 'completion'] as const)(
    'settles as an error if delivery acknowledgement cannot be journaled at %s',
    async (at) => {
      const created: AdapterSession[] = []
      const registry = new DriverRegistry()
      registry.register(recordingDriver('claude', created))
      registry.register({
        kind: 'opencode',
        create: async () => ({
          start: () =>
            (async function* (): AsyncGenerator<AgentEvent> {
              if (at === 'output') yield { type: 'text-delta', text: 'Reply' }
              yield { type: 'done' }
            })(),
          interrupt: () => undefined,
          dispose: async () => undefined,
        }),
      })
      const engine = engineWith(registry)
      await seedSession(store, 'aria', 'helm')
      await turn(engine, 'Existing context.')
      await engine.dispatch({
        type: 'session.provider.switch',
        sessionId: 'aria',
        driverKind: 'opencode',
        modelId: null,
        effort: null,
      })
      const originalAppend = store.append.bind(store)
      const appendSpy = vi.spyOn(store, 'append').mockImplementation(async (id, event) => {
        if (event.type === 'session.provider.context.started')
          throw new Error('acknowledgement write failed')
        return originalAppend(id, event)
      })
      try {
        await turn(engine, 'Continue.')
        const model = await store.load('aria')
        expect(model.activeTurnId).toBeNull()
        expect(model.lastTurn).toMatchObject({
          stopReason: 'error',
          errorMessage: expect.stringContaining('acknowledgement write failed'),
        })
        expect(model.providerHandoffPending).toBe(true)
      } finally {
        appendSpy.mockRestore()
      }
    },
  )

  it('keeps root commands responsive during shutdown and fences the next provider turn', async () => {
    const created: AdapterSession[] = []
    const registry = new DriverRegistry()
    registry.register(recordingDriver('claude', created))
    registry.register(recordingDriver('opencode', created))
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const releaseConnection = vi.fn(async () => {
      await gate
      await writeFile(join(dir, 'late-write.txt'), 'Old process finished')
    })
    const captureCheckpoint = vi.fn(async () => {
      if (created.length > 0) {
        expect(await readFile(join(dir, 'late-write.txt'), 'utf8')).toBe('Old process finished')
        expect((await store.load('aria')).backgroundTasks?.[0]?.status).toBe('stopped')
      }
      return { ok: true as const, value: null }
    })
    const engine = engineWith(registry, {
      releaseProviderConnection: releaseConnection,
      git: { captureCheckpoint },
    })
    await seedSession(store, 'aria', 'helm')
    await turn(engine, 'First.')
    await store.append('aria', {
      type: 'background.task.updated',
      taskId: 'old-shell',
      kind: 'shell',
      label: 'Old shell',
      status: 'running',
    })
    expect(
      await engine.dispatch({
        type: 'session.provider.switch',
        sessionId: 'aria',
        driverKind: 'opencode',
        modelId: null,
        effort: null,
      }),
    ).toEqual({ accepted: true })
    expect(releaseConnection).toHaveBeenCalledWith('aria')
    expect(
      await engine.dispatch({
        type: 'turn.start',
        sessionId: 'aria',
        text: 'Next.',
        attachments: [],
      }),
    ).toEqual({ accepted: true })
    expect(
      await engine.dispatch({ type: 'session.update', sessionId: 'aria', title: 'Responsive' }),
    ).toEqual({ accepted: true })
    expect(created).toHaveLength(1)
    expect(captureCheckpoint).toHaveBeenCalledOnce()
    expect((await store.load('aria')).backgroundTasks?.[0]?.status).toBe('running')
    release()
    await engine.quiesce('aria')
    expect(created).toHaveLength(2)
    expect(created[1]!.resumeOf).toBeNull()
    expect(
      published
        .filter(
          ({ event }) => event.type === 'background.task.updated' && event.taskId === 'old-shell',
        )
        .map(({ event }) => event.type === 'background.task.updated' && event.status),
    ).toEqual(['stopped'])
  })

  it('awaits a release queued during prompt preparation before creating the driver', async () => {
    const created: AdapterSession[] = []
    const registry = new DriverRegistry()
    let released = false
    const driver = recordingDriver('claude', created)
    registry.register({
      ...driver,
      create: async (session) => {
        if (created.length > 0) expect(released).toBe(true)
        return driver.create(session)
      },
    })
    registry.register(recordingDriver('opencode', created))
    let prepare!: () => void
    const preparing = new Promise<void>((resolve) => {
      prepare = resolve
    })
    let finishContext!: () => void
    const contextGate = new Promise<void>((resolve) => {
      finishContext = resolve
    })
    let finishRelease!: () => void
    const releaseGate = new Promise<void>((resolve) => {
      finishRelease = resolve
    })
    const releaseConnection = vi.fn(async () => {
      await releaseGate
      released = true
    })
    const engine = engineWith(registry, {
      releaseProviderConnection: releaseConnection,
      turnContext: async () => {
        if (created.length === 1) {
          prepare()
          await contextGate
        }
        return '[Ari now: test]'
      },
    })
    await seedSession(store, 'aria', 'helm')
    await turn(engine, 'First.')
    await engine.dispatch({ type: 'turn.start', sessionId: 'aria', text: 'Next.', attachments: [] })
    await preparing
    await engine.dispatch({
      type: 'session.provider.switch',
      sessionId: 'aria',
      driverKind: 'opencode',
      modelId: null,
      effort: null,
    })
    finishContext()
    await expect.poll(() => releaseConnection.mock.calls.length).toBe(1)
    expect(created).toHaveLength(1)
    finishRelease()
    await engine.quiesce('aria')
    expect(created).toHaveLength(2)
    // The switch affects the following turn; this turn retains its frozen provider.
    expect(created[1]!.resumeOf).toBe('claude-1')
  })

  it('releases a connection parked during pending shutdown before delivering the handoff', async () => {
    const created: AdapterSession[] = []
    const registry = new DriverRegistry()
    registry.register(recordingDriver('claude', created))
    const nextDriver = recordingDriver('opencode', created)
    let parked = false
    registry.register({
      ...nextDriver,
      create: async (session) => {
        expect(parked).toBe(false)
        return nextDriver.create(session)
      },
    })
    let finishRelease!: () => void
    const gate = new Promise<void>((resolve) => {
      finishRelease = resolve
    })
    let releases = 0
    const releaseConnection = vi.fn(async () => {
      if (++releases === 1) {
        await gate
        parked = true
      } else parked = false
    })
    const engine = engineWith(registry, { releaseProviderConnection: releaseConnection })
    await seedSession(store, 'aria', 'helm')
    await turn(engine, 'Remember the work.')
    await engine.dispatch({
      type: 'session.provider.switch',
      sessionId: 'aria',
      driverKind: 'opencode',
      modelId: null,
      effort: null,
    })
    await engine.dispatch({ type: 'turn.start', sessionId: 'aria', text: 'Next.', attachments: [] })
    expect(created).toHaveLength(1)
    finishRelease()
    await engine.quiesce('aria')
    expect(releases).toBeGreaterThanOrEqual(2)
    expect(created).toHaveLength(2)
    expect(created[1]!.resumeOf).toBeNull()
    expect(created[1]!.handoff).toContain('User: Remember the work.')
  })

  it.each([false, true])(
    'continues after a failed release and runs any queued release (queued: %s)',
    async (queued) => {
      const created: AdapterSession[] = []
      const registry = new DriverRegistry()
      registry.register(recordingDriver('claude', created))
      registry.register(recordingDriver('opencode', created))
      let fail!: (reason: Error) => void
      const gate = new Promise<void>((_resolve, reject) => {
        fail = reject
      })
      let releases = 0
      const releaseConnection = vi.fn(() => (++releases === 1 ? gate : Promise.resolve()))
      const engine = engineWith(registry, { releaseProviderConnection: releaseConnection })
      await seedSession(store, 'aria', 'helm')
      await turn(engine, 'Remember this work.')
      await engine.dispatch({
        type: 'session.provider.switch',
        sessionId: 'aria',
        driverKind: 'opencode',
        modelId: null,
        effort: null,
      })
      if (queued)
        await engine.dispatch({
          type: 'session.provider.switch',
          sessionId: 'aria',
          driverKind: 'claude',
          modelId: null,
          effort: null,
        })
      await engine.dispatch({
        type: 'turn.start',
        sessionId: 'aria',
        text: 'Continue.',
        attachments: [],
      })
      fail(new Error('Release failed'))
      await engine.quiesce('aria')
      expect((await store.load('aria')).lastTurn?.stopReason).toBe('completed')
      expect(created).toHaveLength(2)
      expect(created[1]!.resumeOf).toBeNull()
      expect(created[1]!.prompt).toContain('User: Remember this work.')
      if (queued) expect(releaseConnection.mock.calls.length).toBeGreaterThanOrEqual(2)
    },
  )

  it.each(['running', 'idle'] as const)(
    'ends background tasks when switching away from a %s parked-capable provider',
    async (state) => {
      const registry = new DriverRegistry()
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      registry.register({
        kind: 'claude',
        create: async () => ({
          start: () =>
            (async function* (): AsyncGenerator<AgentEvent> {
              yield { type: 'session-ref', ref: 'old-thread' }
              yield {
                type: 'background-task',
                id: 'shell',
                kind: 'shell',
                label: 'Old shell',
                status: 'running',
              }
              if (state === 'running') await gate
              yield { type: 'done' }
            })(),
          interrupt: release,
          dispose: async () => undefined,
          keepsBackgroundWork: () => true,
        }),
      })
      const releaseConnection = vi.fn(async () => {
        await engine.releaseBackgroundTasks('aria', 'Process ended')
      })
      const engine = engineWith(registry, { releaseProviderConnection: releaseConnection })
      await seedSession(store, 'aria', 'helm')
      await engine.dispatch({
        type: 'turn.start',
        sessionId: 'aria',
        text: 'Work.',
        attachments: [],
      })
      await expect
        .poll(async () => (await store.load('aria')).backgroundTasks?.[0]?.status)
        .toBe('running')
      if (state === 'idle') await engine.quiesce('aria')
      await engine.dispatch({
        type: 'session.provider.switch',
        sessionId: 'aria',
        driverKind: 'opencode',
        modelId: null,
        effort: null,
      })
      if (state === 'running') {
        expect((await store.load('aria')).backgroundTasks?.[0]?.status).toBe('running')
        release()
        await engine.quiesce('aria')
      }
      await expect
        .poll(async () => (await store.load('aria')).backgroundTasks?.[0]?.status)
        .toBe('stopped')
    },
  )

  function recordingDriver(
    kind: 'claude' | 'opencode',
    created: AdapterSession[],
    systemInstructions = false,
  ): Driver {
    return {
      kind,
      systemInstructions,
      create: async (session) => {
        created.push(session)
        const ref = `${kind}-${created.length}`
        return {
          start: () =>
            (async function* (): AsyncGenerator<AgentEvent> {
              yield { type: 'session-ref', ref }
              yield { type: 'text-delta', text: `Aria replied on ${ref}.` }
              yield { type: 'done' }
            })(),
          interrupt: () => undefined,
          dispose: async () => undefined,
        }
      },
    }
  }

  function engineWith(registry: DriverRegistry, deps: Partial<EngineDeps> = {}): Engine {
    return new Engine({
      store,
      registry,
      publish: (sessionId, event) => published.push({ sessionId, event }),
      git: { captureCheckpoint: async () => ({ ok: true, value: null }) },
      runtimeEnvironment: async () => ({ ARI_ENV: '1' }),
      turnContext: async () => '[Ari now: test]',
      ...deps,
    })
  }

  async function turn(engine: Engine, text: string): Promise<void> {
    expect(
      await engine.dispatch({ type: 'turn.start', sessionId: 'aria', text, attachments: [] }),
    ).toEqual({ accepted: true })
    await engine.quiesce('aria')
  }

  it.each([false, true])(
    'starts a fresh context with hidden history and the preamble (system channel: %s)',
    async (systemInstructions) => {
      const created: AdapterSession[] = []
      const registry = new DriverRegistry()
      registry.register(recordingDriver('claude', created))
      registry.register(recordingDriver('opencode', created, systemInstructions))
      const engine = engineWith(registry)
      await seedSession(store, 'aria', 'helm')
      await turn(engine, 'Please fix the redirect.')
      expect(
        await engine.dispatch({
          type: 'session.provider.switch',
          sessionId: 'aria',
          driverKind: 'opencode',
          modelId: 'opus',
          effort: 'high',
        }),
      ).toEqual({ accepted: true })
      await turn(engine, 'Continue the work.')
      const fresh = created[1]!
      expect(fresh).toMatchObject({ resumeOf: null, modelId: 'opus', effort: 'high' })
      expect(fresh.prompt).toContain('Conversation so far')
      expect(fresh.prompt).toContain('User: Please fix the redirect.')
      expect(fresh.prompt).toContain('Aria: Aria replied on claude-1.')
      expect(fresh.prompt).toContain('[Ari now: test]\n\nContinue the work.')
      expect(systemInstructions ? fresh.instructions : fresh.prompt).toContain('You are Aria')
      if (systemInstructions) expect(fresh.prompt).not.toContain('You are Aria')
      const model = await store.load('aria')
      expect(
        model.messages.filter((message) => message.role === 'user').map((message) => message.parts),
      ).toEqual([
        [{ type: 'text', text: 'Please fix the redirect.' }],
        [{ type: 'text', text: 'Continue the work.' }],
      ])
      expect(JSON.stringify(model.messages)).not.toContain('Conversation so far')
      expect(JSON.stringify(model.messages)).not.toContain('[Ari now:')
      expect(JSON.stringify(model.messages)).not.toContain('You are Aria')
      await turn(engine, 'One more detail.')
      expect(created[2]!.resumeOf).toBe('opencode-2')
      expect(created[2]!.prompt).not.toContain('Conversation so far')
      if (!systemInstructions) expect(created[2]!.prompt).not.toContain('You are Aria')
    },
  )

  it('lets the running turn finish and switches its queued follow-up, ignoring late refs', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const created: AdapterSession[] = []
    const interrupt = vi.fn()
    const registry = new DriverRegistry()
    registry.register({
      kind: 'claude',
      create: async (session) => {
        created.push(session)
        return {
          start: () =>
            (async function* (): AsyncGenerator<AgentEvent> {
              yield { type: 'text-delta', text: 'Working. ' }
              await gate
              yield { type: 'session-ref', ref: 'late-claude-thread' }
              yield { type: 'text-delta', text: 'Finished the old turn.' }
              yield { type: 'done' }
            })(),
          interrupt,
          dispose: async () => undefined,
        }
      },
    })
    registry.register(recordingDriver('opencode', created))
    const engine = engineWith(registry)
    await seedSession(store, 'aria', 'helm')
    await engine.dispatch({
      type: 'turn.start',
      sessionId: 'aria',
      text: 'Start work.',
      attachments: [],
    })
    await expect.poll(() => created.length).toBe(1)
    const running = (await store.load('aria')).activeTurnId
    await engine.dispatch({
      type: 'session.provider.switch',
      sessionId: 'aria',
      driverKind: 'opencode',
      modelId: 'next-model',
      effort: null,
    })
    expect((await store.load('aria')).activeTurnId).toBe(running)
    expect(interrupt).not.toHaveBeenCalled()
    await engine.dispatch({
      type: 'message.enqueue',
      sessionId: 'aria',
      text: 'Next turn.',
      attachments: [],
    })
    release()
    await expect.poll(() => created.length, { timeout: 5_000 }).toBe(2)
    await engine.quiesce('aria')
    expect(created[1]!).toMatchObject({ resumeOf: null, modelId: 'next-model' })
    expect(created[1]!.prompt).toContain('Finished the old turn.')
    expect(created[1]!.prompt).toContain('User: Start work.')
    expect(created[1]!.prompt).toContain('[Ari now: test]\n\nNext turn.')
    expect((await store.load('aria')).providerSessionId).toBe('opencode-2')
  })

  it('starts fresh each time Aria switches back and forth, even when returning to a known provider', async () => {
    const created: AdapterSession[] = []
    const registry = new DriverRegistry()
    registry.register(recordingDriver('claude', created, true))
    registry.register(recordingDriver('opencode', created))
    const engine = engineWith(registry)
    await seedSession(store, 'aria', 'helm')
    await turn(engine, 'First.')
    for (const driverKind of ['opencode', 'claude', 'opencode', 'claude'] as const) {
      await engine.dispatch({
        type: 'session.provider.switch',
        sessionId: 'aria',
        driverKind,
        modelId: 'chosen',
        effort: null,
      })
      expect((await store.load('aria')).providerSessionId).toBeNull()
      await turn(engine, `Continue on ${driverKind}.`)
      expect(created.at(-1)!.resumeOf).toBeNull()
      expect(created.at(-1)!.prompt).toContain('Conversation so far')
    }
    await turn(engine, 'Stay on Claude.')
    expect(created.at(-1)!.resumeOf).toBe('claude-5')
    expect(created.at(-1)!.prompt).not.toContain('Conversation so far')
  })

  it('rejects switching an ordinary session without journaling a change', async () => {
    await seedSession(store, 'ordinary')
    const engine = engineWith(new DriverRegistry())
    expect(
      await engine.dispatch({
        type: 'session.provider.switch',
        sessionId: 'ordinary',
        driverKind: 'opencode',
        modelId: 'model',
        effort: null,
      }),
    ).toMatchObject({ accepted: false, reason: 'provider switching is only available to Aria' })
    expect(published).toEqual([])
    expect((await store.load('ordinary')).session?.driverKind).toBe('claude')
  })

  it('keeps the handoff for a retry when the new provider fails to start', async () => {
    const created: AdapterSession[] = []
    const registry = new DriverRegistry()
    registry.register(recordingDriver('claude', created))
    const provider = recordingDriver('opencode', created)
    let fail = true
    registry.register({
      ...provider,
      create: async (session) => {
        if (fail) throw new Error('Startup failed')
        return provider.create(session)
      },
    })
    const engine = engineWith(registry)
    await seedSession(store, 'aria', 'helm')
    await turn(engine, 'Keep this context.')
    await engine.dispatch({
      type: 'session.provider.switch',
      sessionId: 'aria',
      driverKind: 'opencode',
      modelId: 'chosen',
      effort: null,
    })
    await turn(engine, 'Use the new provider.')
    expect((await store.load('aria')).providerHandoffPending).toBe(true)
    fail = false
    await turn(engine, 'Try again.')
    expect(created.at(-1)!.resumeOf).toBeNull()
    expect(created.at(-1)!.prompt).toContain('User: Keep this context.')
    expect((await store.load('aria')).providerHandoffPending).toBe(false)
  })
})

describe('engine end-to-end with scripted driver', () => {
  it.each(['live', 'follow-up', 'unknown', false] as const)(
    'uses the created adapter steering capability %s for coordination',
    async (steering) => {
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const steer = vi.fn(async () => true)
      const registry = new DriverRegistry()
      registry.register({
        kind: 'claude',
        capabilities: () => ({ ...UNKNOWN_PROVIDER_CAPABILITIES, steering: 'live' }),
        create: async () => ({
          capabilities: () => ({
            ...UNKNOWN_PROVIDER_CAPABILITIES,
            steering,
            liveResponses: false,
          }),
          start: () => ({
            async *[Symbol.asyncIterator]() {
              yield { type: 'text-delta' as const, text: 'working' }
              await gate
              yield { type: 'done' as const }
            },
          }),
          interrupt: release,
          dispose: async () => undefined,
          steer,
          respondApproval: () => undefined,
          respondInput: () => undefined,
        }),
      })
      const engine = new Engine({
        store,
        registry,
        publish: (sessionId, event) => published.push({ sessionId, event }),
        git: { captureCheckpoint: async () => ({ ok: true, value: null }) },
      })
      await seedSession(store, 'capability')
      await engine.dispatch({
        type: 'turn.start',
        sessionId: 'capability',
        text: 'work',
        attachments: [],
      })
      await expect
        .poll(() => published.some((entry) => entry.event.type === 'assistant.parts.appended'))
        .toBe(true)
      expect(engine.liveCapabilities('capability')).toEqual({
        approval: false,
        question: false,
        steer: steering === 'live',
      })
      const delivered = await engine.deliverCoordination({
        messageId: 'inbox-one',
        senderSessionId: 'sender',
        recipientSessionId: 'capability',
        text: 'coordinate',
        createdAt: 1,
        status: 'delivering',
        turnId: (await store.load('capability')).activeTurnId,
        consumedAt: null,
      })
      expect(delivered).toBe(steering === 'live')
      expect(steer).toHaveBeenCalledTimes(steering === 'live' ? 1 : 0)
      if (delivered)
        expect(
          (await store.load('capability')).messages.find((message) => message.id === 'inbox-one')
            ?.origin,
        ).toEqual({ kind: 'session', sessionId: 'sender' })
      release()
      await engine.quiesce('capability')
      expect((await store.load('capability')).queuedMessages).toEqual([])
    },
  )

  it.each(['completed', 'interrupted', 'error'] as const)(
    'preserves provider task/request identity and explicit done reason %s',
    async (stopReason) => {
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const identity = {
        providerThreadId: 'provider-child',
        providerTurnId: 'provider-turn',
        providerItemId: 'provider-item',
      }
      const registry = new DriverRegistry()
      registry.register({
        kind: 'claude',
        create: async () => ({
          capabilities: () => ({ ...UNKNOWN_PROVIDER_CAPABILITIES, liveResponses: 'approvals' }),
          start: () => ({
            async *[Symbol.asyncIterator](): AsyncGenerator<AgentEvent> {
              yield {
                type: 'background-task',
                id: 'native',
                kind: 'subagent',
                label: 'Native',
                status: 'running',
                ...identity,
              }
              yield {
                type: 'approval-requested',
                approvalId: 'grant',
                toolName: 'Bash',
                summaryJson: '{}',
                options: [],
                ...identity,
              }
              await gate
              yield { type: 'done', stopReason }
            },
          }),
          interrupt: release,
          dispose: async () => undefined,
          respondApproval: () => undefined,
        }),
      })
      const engine = new Engine({
        store,
        registry,
        publish: (sessionId, event) => published.push({ sessionId, event }),
        git: { captureCheckpoint: async () => ({ ok: true, value: null }) },
      })
      await seedSession(store, 'identity')
      await engine.dispatch({
        type: 'turn.start',
        sessionId: 'identity',
        text: 'work',
        attachments: [],
      })
      await expect.poll(async () => (await store.load('identity')).pendingApprovals.length).toBe(1)
      expect((await store.load('identity')).pendingApprovals[0]).toMatchObject(identity)
      expect((await store.load('identity')).backgroundTasks?.[0]).toMatchObject(identity)
      release()
      await engine.quiesce('identity')
      expect((await store.load('identity')).lastTurn?.stopReason).toBe(stopReason)
      await store.closeJournal('identity')
      const replayed = await new SessionStore({ rootDir: dir }).load('identity')
      expect(replayed.backgroundTasks?.[0]).toMatchObject(identity)
      expect(replayed.lastTurn?.stopReason).toBe(stopReason)
    },
  )

  it('keeps quiesce fenced while turn-start events are being journaled', async () => {
    let releaseAppend!: () => void
    const appendEntered = new Promise<void>((resolve) => {
      releaseAppend = resolve
    })
    let appendBlocked!: () => void
    const appendGate = new Promise<void>((resolve) => {
      appendBlocked = resolve
    })
    const originalAppend = store.append.bind(store)
    vi.spyOn(store, 'append').mockImplementation(async (sessionId, event) => {
      if (event.type === 'turn.started') {
        releaseAppend()
        await appendGate
      }
      return originalAppend(sessionId, event)
    })

    const registry = new DriverRegistry()
    registry.register(scriptedDriver({ echo: 'finished' }))
    const engine = new Engine({
      store,
      registry,
      publish: (sessionId, event) => published.push({ sessionId, event }),
      git: { captureCheckpoint: async () => ({ ok: true, value: null }) },
    })
    const sessionId = 'sess_quiesce_fence'
    await seedSession(store, sessionId)

    const dispatching = engine.dispatch({ type: 'turn.start', sessionId, text: 'start' } as Command)
    await appendEntered
    let quiesced = false
    const quiescing = engine.quiesce(sessionId).then(() => {
      quiesced = true
    })
    await Promise.resolve()
    expect(quiesced).toBe(false)

    appendBlocked()
    await dispatching
    await quiescing
    expect(quiesced).toBe(true)
  }, 10000)

  it('runs a full turn: journal events land and subscribers see them', async () => {
    const registry = new DriverRegistry()
    registry.register(scriptedDriver({ echo: 'hello world' }))
    const engine = new Engine({
      store,
      registry,
      publish: (sessionId, event) => published.push({ sessionId, event }),
      git: { captureCheckpoint: async () => ({ ok: true, value: null }) },
    })

    const sessionId = 'sess_e2e'
    await seedSession(store, sessionId)

    const result = await engine.dispatch({
      type: 'turn.start',
      sessionId,
      text: 'say hello',
    } as Command)
    expect(result.accepted).toBe(true)

    // Wait until settle has folded idle into the read model (load-independent).
    const settledAt = Date.now()
    while (true) {
      const model = await store.load(sessionId)
      if (model.status === 'idle' && published.some((p) => p.event.type === 'turn.settled')) break
      if (Date.now() - settledAt > 30000) throw new Error('turn never settled idle')
      await new Promise((r) => setTimeout(r, 25))
    }

    const types = published.map((p) => p.event.type)
    const idleIdx = published.findIndex(
      (p) => p.event.type === 'session.status.changed' && p.event.to === 'idle',
    )
    const settledIdx = types.lastIndexOf('turn.settled')
    expect(idleIdx).toBeGreaterThanOrEqual(0)
    expect(idleIdx).toBeLessThan(settledIdx)

    const model = await store.load(sessionId)
    expect(model.status).toBe('idle')
    if (model.messages.length !== 2)
      throw new Error('DEBUG events=' + JSON.stringify(published.map((p) => p.event.type)))
    expect(
      model.messages[1]?.parts.some((p) => p.type === 'text' && p.text.includes('hello')),
    ).toBe(true)
    expect(published.length).toBeGreaterThanOrEqual(5)
    expect(published[0]?.event.type).toBe('turn.started')
    expect(published.map((p) => p.event)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'usage.recorded', inputTokens: 3, cachedInputTokens: 1 }),
        expect.objectContaining({ type: 'context.recorded', usedTokens: 5, windowTokens: 200 }),
      ]),
    )
  }, 10000)

  it('does not start the provider when turn-start persistence fails', async () => {
    const delegate = scriptedDriver({ echo: 'must not run' })
    const create = vi.fn((session: AdapterSession) => delegate.create(session))
    const registry = new DriverRegistry()
    registry.register({ kind: 'claude', create })
    const engine = new Engine({
      store,
      registry,
      publish: (sessionId, event) => published.push({ sessionId, event }),
      git: { captureCheckpoint: async () => ({ ok: true, value: null }) },
    })
    const sessionId = 'sess_failed_start'
    await seedSession(store, sessionId)
    vi.spyOn(store, 'append').mockRejectedValueOnce(new Error('disk full'))

    await expect(
      engine.dispatch({ type: 'turn.start', sessionId, text: 'do not run', attachments: [] }),
    ).rejects.toThrow('disk full')
    await engine.quiesce(sessionId)

    expect(create).not.toHaveBeenCalled()
    expect(engine.hasLiveTurn(sessionId)).toBe(false)
  })

  it('resolves staged attachments for the adapter and journals image parts', async () => {
    const seen: AdapterSession[] = []
    const capturing: Driver = {
      kind: 'claude',
      create: (session: AdapterSession) => {
        seen.push(session)
        return Promise.resolve({
          capabilities: () => ({
            ...UNKNOWN_PROVIDER_CAPABILITIES,
            steering: 'live',
            liveResponses: 'approvals-and-input',
          }),
          start: () => ({
            async *[Symbol.asyncIterator](): AsyncGenerator<AgentEvent> {
              yield { type: 'done' }
            },
          }),
          interrupt: () => undefined,
          dispose: () => Promise.resolve(),
        })
      },
    }
    const registry = new DriverRegistry()
    registry.register(capturing)
    const engine = new Engine({
      store,
      registry,
      publish: (sessionId, event) => published.push({ sessionId, event }),
      git: { captureCheckpoint: async () => ({ ok: true, value: null }) },
      resolveAttachmentPath: async (id) => `/staged/${id}.png`,
    })

    const sessionId = 'sess_attachments'
    await seedSession(store, sessionId)
    const ref = { id: 'att_1', name: 'shot.png', mimeType: 'image/png', size: 8 }
    const result = await engine.dispatch({
      type: 'turn.start',
      sessionId,
      text: 'look',
      attachments: [ref],
    })
    expect(result.accepted).toBe(true)

    const settledAt = Date.now()
    while (true) {
      const model = await store.load(sessionId)
      if (model.status === 'idle') break
      if (Date.now() - settledAt > 30000) throw new Error('turn never settled idle')
      await new Promise((r) => setTimeout(r, 25))
    }

    expect(seen).toHaveLength(1)
    expect(seen[0]?.attachments).toEqual([
      { id: 'att_1', name: 'shot.png', mimeType: 'image/png', path: '/staged/att_1.png' },
    ])
    const userMessage = published.find((p) => p.event.type === 'user.message.added')?.event
    if (userMessage?.type !== 'user.message.added') throw new Error('missing user message')
    expect(userMessage.message.parts).toEqual([
      { type: 'image', attachmentId: 'att_1', name: 'shot.png', mimeType: 'image/png', size: 8 },
      { type: 'text', text: 'look' },
    ])
  }, 10000)

  it('stages provider image output and journals it on the assistant message', async () => {
    const imageDriver: Driver = {
      kind: 'claude',
      create: () =>
        Promise.resolve({
          capabilities: () => ({
            ...UNKNOWN_PROVIDER_CAPABILITIES,
            steering: 'live',
            liveResponses: 'approvals-and-input',
          }),
          start: () => ({
            async *[Symbol.asyncIterator](): AsyncGenerator<AgentEvent> {
              yield { type: 'text-delta', text: 'Here it is.' }
              yield {
                type: 'image-output',
                dataBase64: 'aGk=',
                mimeType: 'image/png',
                name: 'generated.png',
              }
              yield { type: 'done' }
            },
          }),
          interrupt: () => undefined,
          dispose: () => Promise.resolve(),
        }),
    }
    const registry = new DriverRegistry()
    registry.register(imageDriver)
    const stageOutputImage = vi.fn(async () => ({
      id: 'att_generated',
      name: 'generated.png',
      mimeType: 'image/png',
      size: 2,
    }))
    const engine = new Engine({
      store,
      registry,
      publish: (sessionId, event) => published.push({ sessionId, event }),
      git: { captureCheckpoint: async () => ({ ok: true, value: null }) },
      stageOutputImage,
    })
    const sessionId = 'sess_generated_image'
    await seedSession(store, sessionId)

    await engine.dispatch({ type: 'turn.start', sessionId, text: 'make an image', attachments: [] })
    await engine.quiesce(sessionId)

    expect(stageOutputImage).toHaveBeenCalledWith({
      dataBase64: 'aGk=',
      mimeType: 'image/png',
      name: 'generated.png',
    })
    const assistant = (await store.load(sessionId)).messages.find(
      (message) => message.role === 'assistant',
    )
    expect(assistant?.parts).toEqual([
      { type: 'text', text: 'Here it is.' },
      {
        type: 'image',
        attachmentId: 'att_generated',
        name: 'generated.png',
        mimeType: 'image/png',
        size: 2,
      },
    ])
  }, 10000)

  it('loads Grok file-backed image output before staging it', async () => {
    const generatedPath = join(dir, '1.jpg')
    await writeFile(generatedPath, 'jpeg bytes')
    const imageDriver: Driver = {
      kind: 'claude',
      create: () =>
        Promise.resolve({
          capabilities: () => ({
            ...UNKNOWN_PROVIDER_CAPABILITIES,
            steering: 'live',
            liveResponses: 'approvals-and-input',
          }),
          start: () => ({
            async *[Symbol.asyncIterator](): AsyncGenerator<AgentEvent> {
              yield {
                type: 'image-output-path',
                path: generatedPath,
                mimeType: 'image/jpeg',
                name: '1.jpg',
              }
              yield { type: 'done' }
            },
          }),
          interrupt: () => undefined,
          dispose: () => Promise.resolve(),
        }),
    }
    const registry = new DriverRegistry()
    registry.register(imageDriver)
    const stageOutputImage = vi.fn(async () => ({
      id: 'att_grok',
      name: '1.jpg',
      mimeType: 'image/jpeg',
      size: 10,
    }))
    const engine = new Engine({
      store,
      registry,
      publish: (sessionId, event) => published.push({ sessionId, event }),
      git: { captureCheckpoint: async () => ({ ok: true, value: null }) },
      stageOutputImage,
    })
    const sessionId = 'sess_grok_image'
    await seedSession(store, sessionId)

    await engine.dispatch({ type: 'turn.start', sessionId, text: 'make an image', attachments: [] })
    await engine.quiesce(sessionId)

    expect(stageOutputImage).toHaveBeenCalledWith({
      dataBase64: Buffer.from('jpeg bytes').toString('base64'),
      mimeType: 'image/jpeg',
      name: '1.jpg',
    })
    const assistant = (await store.load(sessionId)).messages.find(
      (message) => message.role === 'assistant',
    )
    expect(assistant?.parts).toContainEqual({
      type: 'image',
      attachmentId: 'att_grok',
      name: '1.jpg',
      mimeType: 'image/jpeg',
      size: 10,
    })
  }, 10000)

  it('interrupt settles an active turn and drops late adapter events', async () => {
    const slowDriver: Driver = {
      kind: 'claude',
      create: (_session: AdapterSession) =>
        Promise.resolve({
          capabilities: () => ({
            ...UNKNOWN_PROVIDER_CAPABILITIES,
            steering: 'live',
            liveResponses: 'approvals-and-input',
          }),
          start: () => ({
            async *[Symbol.asyncIterator]() {
              yield { type: 'status', status: 'running' as const }
              await new Promise(() => undefined) // never resolves
            },
          }),
          interrupt: () => undefined,
          dispose: () => Promise.resolve(),
        }),
    }
    const registry = new DriverRegistry()
    registry.register(slowDriver)
    const engine = new Engine({
      store,
      registry,
      publish: (sessionId, event) => published.push({ sessionId, event }),
      git: { captureCheckpoint: async () => ({ ok: true, value: null }) },
    })

    const sessionId = 'sess_slow'
    await seedSession(store, sessionId)
    await engine.dispatch({ type: 'turn.start', sessionId, text: 'hang' } as Command)
    await new Promise((r) => setTimeout(r, 50))

    const interrupt = await engine.dispatch({
      type: 'turn.interrupt',
      sessionId,
    })
    expect(interrupt.accepted).toBe(true)
    await new Promise((r) => setTimeout(r, 80))

    const model = await store.load(sessionId)
    expect(model.activeTurnId).toBeNull()
    expect(model.status).toBe('idle')
  }, 10000)

  it('emits checkpoint.pruned when the capturer reports GC deletions', async () => {
    const registry = new DriverRegistry()
    registry.register(scriptedDriver({ echo: 'gc run' }))
    const prunedRefs = ['refs/ari/sess_gc_e2e/turn_old1', 'refs/ari/sess_gc_e2e/turn_old2']
    const pruneCalls: { turnIds: readonly string[]; maxPerSession: number }[] = []
    const engine = new Engine({
      store,
      registry,
      publish: (sessionId, event) => published.push({ sessionId, event }),
      git: {
        captureCheckpoint: async () => ({
          ok: true,
          value: 'refs/ari/sess_gc_e2e/turn_new',
        }),
        pruneCheckpoints: async (_cwd, _sessionId, turnIds, maxPerSession) => {
          pruneCalls.push({ turnIds, maxPerSession })
          return { ok: true, value: [...prunedRefs] }
        },
      },
    })

    const sessionId = 'sess_gc_e2e'
    await seedSession(store, sessionId)
    const result = await engine.dispatch({
      type: 'turn.start',
      sessionId,
      text: 'run with gc',
    } as Command)
    expect(result.accepted).toBe(true)

    // The turn runs async; wait for settle.
    for (let i = 0; i < 150; i++) {
      const model = await store.load(sessionId)
      if (model.activeTurnId === null) break
      await new Promise((r) => setTimeout(r, 20))
    }

    const events = published.filter((p) => p.sessionId === sessionId).map((p) => p.event)
    const captured = events.find((e) => e.type === 'checkpoint.captured')
    expect(captured).toBeDefined()
    // GC is told the capture order, ending with the checkpoint just captured.
    expect(pruneCalls).toEqual([{ turnIds: [captured?.turnId], maxPerSession: 50 }])
    const prunedEvents = events.filter((e) => e.type === 'checkpoint.pruned')
    expect(prunedEvents.map((e) => e.gitRef)).toEqual(prunedRefs)
    expect(prunedEvents[0]?.turnId).toBe('turn_old1')

    // Projection fold: pruned checkpoints leave the read model.
    const model = await store.load(sessionId)
    expect(model.checkpoints.some((c) => c.gitRef.includes('turn_old'))).toBe(false)
  }, 10000)

  it('reports checkpoint.revert failures to the caller and keeps the checkpoint', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'ari-engine-revert-'))
    dirs.push(repo)
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' })
    git('init', '-q')
    // The revert below restores through the checkout filter, which rewrites LF
    // to CRLF on Windows unless the repo opts out. Every other git-backed suite
    // pins it; this one did not.
    git('config', 'core.autocrlf', 'false')
    await writeFile(join(repo, 'a.txt'), 'committed\n')
    git('add', '.')
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init')
    await writeFile(join(repo, 'a.txt'), 'pre-turn work\n')
    const engine = new Engine({ store, registry: new DriverRegistry(), publish: () => undefined })
    const sessionId = 'sess_revert'
    await seedSession(store, sessionId, repo)
    const { GitService } = await import('@ari/engine/git')
    for (const turnId of ['turn_ok', 'turn_gone']) {
      const ref = await new GitService().captureCheckpoint(repo, sessionId, turnId)
      if (!ref.ok || ref.value === null) throw new Error('checkpoint not captured')
      await store.append(sessionId, { type: 'checkpoint.captured', turnId, gitRef: ref.value })
    }
    git('update-ref', '-d', `refs/ari/${sessionId}/turn_gone`)

    const failed = await engine.dispatch({
      type: 'checkpoint.revert',
      sessionId,
      turnId: 'turn_gone',
    })
    expect(failed.accepted).toBe(false)
    expect(failed.reason).toMatch(/^revert failed: /)
    expect((await store.load(sessionId)).checkpoints.map((c) => c.turnId)).toEqual([
      'turn_ok',
      'turn_gone',
    ])

    await writeFile(join(repo, 'a.txt'), 'agent edit\n')
    const reverted = await engine.dispatch({
      type: 'checkpoint.revert',
      sessionId,
      turnId: 'turn_ok',
    })
    expect(reverted).toEqual({ accepted: true })
    expect(await readFile(join(repo, 'a.txt'), 'utf8')).toBe('pre-turn work\n')
  }, 30000)

  it('skips GC silently when the capturer has no pruneCheckpoints', async () => {
    const registry = new DriverRegistry()
    registry.register(scriptedDriver({ echo: 'no gc' }))
    const engine = new Engine({
      store,
      registry,
      publish: (sessionId, event) => published.push({ sessionId, event }),
      git: { captureCheckpoint: async () => ({ ok: true, value: 'refs/ari/sess_nogc/turn_1' }) },
    })
    const sessionId = 'sess_nogc'
    await seedSession(store, sessionId)
    await engine.dispatch({ type: 'turn.start', sessionId, text: 'x' } as Command)
    for (let i = 0; i < 150; i++) {
      const model = await store.load(sessionId)
      if (model.activeTurnId === null) break
      await new Promise((r) => setTimeout(r, 20))
    }
    const events = published.filter((p) => p.sessionId === sessionId).map((p) => p.event)
    expect(events.some((e) => e.type === 'checkpoint.captured')).toBe(true)
    expect(events.some((e) => e.type === 'checkpoint.pruned')).toBe(false)
  }, 10000)

  it('settles the turn as error when a provider emits an error event', async () => {
    // Auth-failure shape: CLI exits 0 but emits an error mid-stream (the
    // real-world `Not logged in · Please run /login` claude failure).
    function failingDriver(): Driver {
      function makeAdapter(): ProviderAdapter {
        async function* start(): AsyncGenerator<AgentEvent> {
          yield {
            type: 'error',
            message: 'authentication_failed: Not logged in · Please run /login',
            rawJson: null,
          }
          yield { type: 'done' }
        }
        return {
          capabilities: () => ({
            ...UNKNOWN_PROVIDER_CAPABILITIES,
            steering: 'live',
            liveResponses: 'approvals-and-input',
          }),
          start: () => ({ [Symbol.asyncIterator]: () => start()[Symbol.asyncIterator]() }),
          interrupt: () => undefined,
          dispose: () => Promise.resolve(),
        }
      }
      return { kind: 'claude', create: () => Promise.resolve(makeAdapter()) }
    }

    const registry = new DriverRegistry()
    registry.register(failingDriver())
    const engine = new Engine({
      store,
      registry,
      publish: (sessionId, event) => published.push({ sessionId, event }),
      git: { captureCheckpoint: async () => ({ ok: true, value: null }) },
    })
    const sessionId = 'sess_auth_fail'
    await seedSession(store, sessionId)
    await engine.dispatch({ type: 'turn.start', sessionId, text: 'hi' } as Command)
    // Wait on the subscriber stream itself — the journal can observe the
    // settle a beat before publish lands.
    for (let i = 0; i < 150; i++) {
      if (published.some((p) => p.sessionId === sessionId && p.event.type === 'turn.settled')) break
      if (i === 149) throw new Error('turn never settled')
      await new Promise((r) => setTimeout(r, 20))
    }

    const settled = published
      .filter((p) => p.sessionId === sessionId)
      .map((p) => p.event)
      .find((e) => e.type === 'turn.settled')
    expect(settled).toBeDefined()
    if (settled?.type === 'turn.settled') {
      expect(settled.stopReason).toBe('error')
      expect(settled.errorMessage).toContain('authentication_failed')
    }
    const model = await store.load(sessionId)
    expect(model.status).toBe('error')
  }, 10000)

  it('shows a notice in the transcript without failing the turn', async () => {
    // A notice is the "this worked, but not the way you asked" channel — a
    // refused model pick. Settling the turn as `error` here would report a
    // failure that did not happen and play the error sound over a good reply.
    function noticingDriver(): Driver {
      function makeAdapter(): ProviderAdapter {
        async function* start(): AsyncGenerator<AgentEvent> {
          yield {
            type: 'notice',
            message: '"gpt-9" is not offered by this agent, so this turn ran on the default.',
          }
          yield { type: 'text-delta', text: 'hello' }
          yield { type: 'done' }
        }
        return {
          capabilities: () => ({
            ...UNKNOWN_PROVIDER_CAPABILITIES,
            steering: 'live',
            liveResponses: 'approvals-and-input',
          }),
          start: () => ({ [Symbol.asyncIterator]: () => start()[Symbol.asyncIterator]() }),
          interrupt: () => undefined,
          dispose: () => Promise.resolve(),
        }
      }
      return { kind: 'claude', create: () => Promise.resolve(makeAdapter()) }
    }

    const registry = new DriverRegistry()
    registry.register(noticingDriver())
    const engine = new Engine({
      store,
      registry,
      publish: (sessionId, event) => published.push({ sessionId, event }),
      git: { captureCheckpoint: async () => ({ ok: true, value: null }) },
    })
    const sessionId = 'sess_notice'
    await seedSession(store, sessionId)
    await engine.dispatch({ type: 'turn.start', sessionId, text: 'hi' } as Command)
    for (let i = 0; i < 150; i++) {
      if (published.some((p) => p.sessionId === sessionId && p.event.type === 'turn.settled')) break
      if (i === 149) throw new Error('turn never settled')
      await new Promise((r) => setTimeout(r, 20))
    }

    const model = await store.load(sessionId)
    expect(model.status).toBe('idle')
    const text = (model.messages ?? [])
      .flatMap((m) => m.parts)
      .filter((p) => p.type === 'text')
      .map((p) => (p as { text: string }).text)
      .join('')
    expect(text).toContain('gpt-9')
    expect(text).toContain('hello')
  }, 10000)

  it('keeps a permission mode the adapter reports for the turns that follow', async () => {
    const created: AdapterSession[] = []
    const wideningDriver: Driver = {
      kind: 'claude',
      create: (session) => {
        created.push(session)
        return Promise.resolve({
          capabilities: () => ({
            ...UNKNOWN_PROVIDER_CAPABILITIES,
            steering: 'live',
            liveResponses: 'approvals-and-input',
          }),
          start: () => ({
            async *[Symbol.asyncIterator](): AsyncGenerator<AgentEvent> {
              yield { type: 'permission-mode', mode: 'full' }
              yield { type: 'done' }
            },
          }),
          interrupt: () => undefined,
          dispose: () => Promise.resolve(),
        })
      },
    }
    const registry = new DriverRegistry()
    registry.register(wideningDriver)
    const engine = new Engine({
      store,
      registry,
      publish: (sessionId, event) => published.push({ sessionId, event }),
      git: { captureCheckpoint: async () => ({ ok: true, value: null }) },
    })
    const sessionId = 'sess_widened'
    await seedSession(store, sessionId)

    for (const text of ['first', 'second']) {
      await engine.dispatch({ type: 'turn.start', sessionId, text } as Command)
      for (let i = 0; i < 150; i++) {
        const model = await store.load(sessionId)
        if (model.activeTurnId === null) break
        if (i === 149) throw new Error(`${text} turn never settled`)
        await new Promise((r) => setTimeout(r, 20))
      }
    }

    expect(created.map((session) => session.permissionMode)).toEqual(['ask', 'full'])
    expect((await store.load(sessionId)).session?.permissionMode).toBe('full')
  }, 10000)

  it('passes the observed provider ref as resumeOf on the next turn only', async () => {
    const created: AdapterSession[] = []
    function resumingDriver(): Driver {
      return {
        kind: 'claude',
        create: (session) => {
          created.push(session)
          return Promise.resolve({
            capabilities: () => ({
              ...UNKNOWN_PROVIDER_CAPABILITIES,
              steering: 'live',
              liveResponses: 'approvals-and-input',
            }),
            start: () => ({
              async *[Symbol.asyncIterator](): AsyncGenerator<AgentEvent> {
                yield { type: 'session-ref', ref: 'native-thread-1' }
                yield { type: 'done' }
              },
            }),
            interrupt: () => undefined,
            dispose: () => Promise.resolve(),
          })
        },
      }
    }
    const registry = new DriverRegistry()
    registry.register(resumingDriver())
    const engine = new Engine({
      store,
      registry,
      publish: (sessionId, event) => published.push({ sessionId, event }),
      git: { captureCheckpoint: async () => ({ ok: true, value: null }) },
    })
    const sessionId = 'sess_resume'
    await seedSession(store, sessionId)
    await store.append(sessionId, {
      type: 'session.ref.observed',
      ref: 'imported:pi:native-thread-before-import',
    })

    await engine.dispatch({ type: 'turn.start', sessionId, text: 'first' } as Command)
    for (let i = 0; i < 150; i++) {
      const model = await store.load(sessionId)
      if (model.activeTurnId === null) break
      if (i === 149) throw new Error('first turn never settled')
      await new Promise((r) => setTimeout(r, 20))
    }

    await engine.dispatch({ type: 'turn.start', sessionId, text: 'second' } as Command)
    for (let i = 0; i < 150; i++) {
      const model = await store.load(sessionId)
      if (model.activeTurnId === null) break
      if (i === 149) throw new Error('second turn never settled')
      await new Promise((r) => setTimeout(r, 20))
    }

    expect(created).toHaveLength(2)
    expect(created[0]?.resumeOf).toBeNull()
    expect(created[1]?.resumeOf).toBe('native-thread-1')
  }, 10000)

  it('journals a burst of deltas as one part, on a timer, while the provider is quiet', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    try {
      const releaseRef = { current: null as (() => void) | null }
      const quietDriver: Driver = {
        kind: 'claude',
        create: () =>
          Promise.resolve({
            capabilities: () => ({
              ...UNKNOWN_PROVIDER_CAPABILITIES,
              steering: 'live',
              liveResponses: 'approvals-and-input',
            }),
            start: () => ({
              async *[Symbol.asyncIterator](): AsyncGenerator<AgentEvent> {
                yield { type: 'text-delta', text: 'Still ' }
                yield { type: 'text-delta', text: 'thinking ' }
                yield { type: 'text-delta', text: 'about it' }
                // The provider goes quiet mid-reply: no further event arrives
                // to push the buffered text out.
                await new Promise<void>((resolve) => {
                  releaseRef.current = resolve
                })
                yield { type: 'done' }
              },
            }),
            interrupt: () => undefined,
            dispose: () => Promise.resolve(),
          }),
      }
      const registry = new DriverRegistry()
      registry.register(quietDriver)
      const engine = new Engine({
        store,
        registry,
        publish: () => undefined,
        git: { captureCheckpoint: async () => ({ ok: true, value: null }) },
      })
      const sessionId = 'sess_text_flush'
      await seedSession(store, sessionId)
      await engine.dispatch({ type: 'turn.start', sessionId, text: 'go' } as Command)

      // The clock is frozen, so all three deltas land in one buffered run.
      while (releaseRef.current === null) await new Promise((r) => setImmediate(r))
      await vi.advanceTimersByTimeAsync(50)
      vi.useRealTimers()

      const assistantParts = async () =>
        (await store.load(sessionId)).messages
          .filter((m) => m.role === 'assistant')
          .flatMap((m) => m.parts)
      for (let i = 0; i < 150 && (await assistantParts()).length === 0; i++) {
        await new Promise((r) => setTimeout(r, 20))
      }
      expect(await assistantParts()).toEqual([{ type: 'text', text: 'Still thinking about it' }])
      expect((await store.load(sessionId)).activeTurnId).not.toBeNull()

      releaseRef.current()
      for (let i = 0; i < 150; i++) {
        if ((await store.load(sessionId)).activeTurnId === null) break
        await new Promise((r) => setTimeout(r, 20))
      }
    } finally {
      vi.useRealTimers()
    }
  }, 10000)

  it('holds delegated work at the capacity gate and starts it when a slot frees', async () => {
    let allowed = false
    const started: string[] = []
    const registry = new DriverRegistry()
    registry.register({
      kind: 'claude',
      create: (session: AdapterSession) =>
        Promise.resolve({
          capabilities: () => ({
            ...UNKNOWN_PROVIDER_CAPABILITIES,
            steering: 'live',
            liveResponses: 'approvals-and-input',
          }),
          start: () => ({
            async *[Symbol.asyncIterator](): AsyncGenerator<AgentEvent> {
              started.push(session.sessionId)
              yield { type: 'done' }
            },
          }),
          interrupt: () => undefined,
          dispose: () => Promise.resolve(),
        }),
    })
    const engine = new Engine({
      store,
      registry,
      publish: () => undefined,
      git: { captureCheckpoint: async () => ({ ok: true, value: null }) },
      authorizeTurn: async () => (allowed ? null : 'Maximum concurrent child sessions reached.'),
    })
    const sessionId = 'sess_held'
    await seedSession(store, sessionId)

    expect(
      await engine.dispatch({
        type: 'message.enqueue',
        sessionId,
        text: 'Implement',
        attachments: [],
        hold: true,
      }),
    ).toMatchObject({ accepted: true })
    await new Promise((resolve) => setTimeout(resolve, 30))
    const held = await store.load(sessionId)
    expect(held.activeTurnId).toBeNull()
    expect(held.queuedMessages).toMatchObject([{ text: 'Implement', held: true }])

    allowed = true
    await engine.drainHeld()
    for (let i = 0; i < 150 && !started.includes(sessionId); i++)
      await new Promise((resolve) => setTimeout(resolve, 20))
    expect(started).toContain(sessionId)
    expect((await store.load(sessionId)).queuedMessages).toEqual([])
  }, 10_000)

  it('starts a human message ahead of room and routine work queued before it', async () => {
    let allowed = false
    const registry = new DriverRegistry()
    registry.register({
      kind: 'claude',
      create: () =>
        Promise.resolve({
          capabilities: () => ({
            ...UNKNOWN_PROVIDER_CAPABILITIES,
            steering: 'live',
            liveResponses: 'approvals-and-input',
          }),
          start: () => ({
            async *[Symbol.asyncIterator](): AsyncGenerator<AgentEvent> {
              yield { type: 'done' }
            },
          }),
          interrupt: () => undefined,
          dispose: () => Promise.resolve(),
        }),
    })
    const engine = new Engine({
      store,
      registry,
      publish: () => undefined,
      git: { captureCheckpoint: async () => ({ ok: true, value: null }) },
      authorizeTurn: async () => (allowed ? null : 'Maximum concurrent child sessions reached.'),
    })
    const sessionId = 'sess_wake_priority'
    await seedSession(store, sessionId)

    for (const [text, priority] of [
      ['nightly sweep', 'routine'],
      ['room aside', 'room'],
    ] as const) {
      await engine.dispatch({
        type: 'message.enqueue',
        sessionId,
        text,
        attachments: [],
        hold: true,
        priority,
      })
    }
    await new Promise((resolve) => setTimeout(resolve, 30))

    allowed = true
    await engine.dispatch({
      type: 'message.enqueue',
      sessionId,
      text: 'fix the build',
      attachments: [],
      hold: true,
      priority: 'human',
    })
    await engine.drainHeld()
    for (let i = 0; i < 150; i++) {
      const model = await store.load(sessionId)
      const users = model.messages.filter((message) => message.role === 'user').length
      if (model.activeTurnId === null && model.queuedMessages.length === 0 && users === 3) break
      if (i === 149) throw new Error('priority queue never drained')
      await new Promise((resolve) => setTimeout(resolve, 20))
    }

    const model = await store.load(sessionId)
    const texts = model.messages
      .filter((message) => message.role === 'user')
      .map((message) => message.parts.find((part) => part.type === 'text')?.text)
    expect(texts).toEqual(['fix the build', 'room aside', 'nightly sweep'])
  }, 10_000)

  it('keeps an enqueue queued even when the provider can steer', async () => {
    const steered: string[] = []
    const releaseTurnRef = { current: null as (() => void) | null }
    let started = 0
    const steerableDriver: Driver = {
      kind: 'claude',
      create: (_session: AdapterSession) =>
        Promise.resolve({
          capabilities: () => ({
            ...UNKNOWN_PROVIDER_CAPABILITIES,
            steering: 'live',
            liveResponses: 'approvals-and-input',
          }),
          start: () => ({
            async *[Symbol.asyncIterator](): AsyncGenerator<AgentEvent> {
              yield { type: 'status', status: 'running' as const }
              if (++started === 1) {
                await new Promise<void>((resolve) => {
                  releaseTurnRef.current = resolve
                })
              }
              yield { type: 'done' }
            },
          }),
          interrupt: () => undefined,
          dispose: () => Promise.resolve(),
          steer: (text) => {
            steered.push(text)
            return true
          },
        }),
    }
    const registry = new DriverRegistry()
    registry.register(steerableDriver)
    const engine = new Engine({
      store,
      registry,
      publish: (sessionId, event) => published.push({ sessionId, event }),
      git: { captureCheckpoint: async () => ({ ok: true, value: null }) },
    })
    const sessionId = 'sess_steer'
    await seedSession(store, sessionId)
    await engine.dispatch({ type: 'turn.start', sessionId, text: 'long task' } as Command)
    await new Promise((r) => setTimeout(r, 50))

    const queued = await engine.dispatch({
      type: 'message.enqueue',
      sessionId,
      text: 'focus on the parser instead',
      attachments: [],
    })
    expect(queued.accepted).toBe(true)
    // Sending while a turn is live queues. Steer is a separate command, so a
    // provider that *could* inject must not swallow the message on send.
    expect(steered).toEqual([])
    const mid = await store.load(sessionId)
    expect(mid.queuedMessages).toEqual([{ text: 'focus on the parser instead', attachments: [] }])

    releaseTurnRef.current?.()
    for (let i = 0; i < 150; i++) {
      const model = await store.load(sessionId)
      const texts = model.messages
        .filter((m) => m.role === 'user')
        .flatMap((m) => m.parts.filter((p) => p.type === 'text').map((p) => p.text))
      if (model.activeTurnId === null && texts.length === 2) break
      if (i === 149) throw new Error('queued message never ran after the turn')
      await new Promise((r) => setTimeout(r, 20))
    }
    expect(steered).toEqual([])
    const folded = await store.load(sessionId)
    expect(
      folded.messages
        .filter((m) => m.role === 'user')
        .flatMap((m) =>
          m.parts.filter((p) => p.type === 'text').map((p) => ('text' in p ? p.text : '')),
        ),
    ).toEqual(['long task', 'focus on the parser instead'])
  }, 10000)

  /**
   * Builds a driver whose adapter refuses to steer, standing in for a
   * transport with no control channel or a provider that rejects the text.
   * `release` parks the first turn until the test lets it settle and lets
   * every later turn complete on its own (so the queue drain can finish);
   * null lets every turn complete immediately.
   */
  function refusingSteerDriver(release: { current: (() => void) | null } | null): Driver {
    let started = 0
    return {
      kind: 'claude',
      create: (_session: AdapterSession) =>
        Promise.resolve({
          capabilities: () => ({
            ...UNKNOWN_PROVIDER_CAPABILITIES,
            steering: 'live',
            liveResponses: 'approvals-and-input',
          }),
          start: () => ({
            async *[Symbol.asyncIterator](): AsyncGenerator<AgentEvent> {
              yield { type: 'status', status: 'running' as const }
              if (release !== null && ++started === 1) {
                await new Promise<void>((resolve) => {
                  release.current = resolve
                })
              }
              yield { type: 'done' }
            },
          }),
          interrupt: () => undefined,
          dispose: () => Promise.resolve(),
          steer: () => false,
        }),
    }
  }

  it('keeps a message queued when the transport refuses to steer it', async () => {
    const releaseTurnRef = { current: null as (() => void) | null }
    const registry = new DriverRegistry()
    registry.register(refusingSteerDriver(releaseTurnRef))
    const engine = new Engine({
      store,
      registry,
      publish: () => undefined,
      git: { captureCheckpoint: async () => ({ ok: true, value: null }) },
    })
    const sessionId = 'sess_steer_refused'
    await seedSession(store, sessionId)
    await engine.dispatch({ type: 'turn.start', sessionId, text: 'long task' } as Command)
    await new Promise((r) => setTimeout(r, 50))

    const queued = await engine.dispatch({
      type: 'message.enqueue',
      sessionId,
      text: 'focus on the parser instead',
      attachments: [],
    })
    expect(queued.accepted).toBe(true)

    // The adapter declined, so the message must still be waiting: reporting it
    // as steered would drop it from the queue and it would never run at all.
    const mid = await store.load(sessionId)
    expect(mid.queuedMessages).toEqual([{ text: 'focus on the parser instead', attachments: [] }])
    expect(mid.messages.filter((m) => m.role === 'user')).toHaveLength(1)

    // And it survives as the follow-up turn once the running one settles. The
    // queue empties a moment before the promoted message is journaled, so wait
    // for the message itself rather than for the queue to drain.
    releaseTurnRef.current?.()
    const userMessages = (model: Awaited<ReturnType<typeof store.load>>): number =>
      model.messages.filter((m) => m.role === 'user').length
    for (let i = 0; i < 150; i++) {
      const model = await store.load(sessionId)
      if (userMessages(model) === 2 && model.activeTurnId === null) break
      if (i === 149) throw new Error('queued message never ran as the follow-up turn')
      await new Promise((r) => setTimeout(r, 20))
    }
    const settled = await store.load(sessionId)
    expect(settled.messages.filter((m) => m.role === 'user').map((m) => m.id)).toHaveLength(2)
  }, 10000)

  it('steers a queued message into the running turn on demand', async () => {
    const steered: string[] = []
    const releaseTurnRef = { current: null as (() => void) | null }
    const steerableDriver: Driver = {
      kind: 'claude',
      create: (_session: AdapterSession) =>
        Promise.resolve({
          capabilities: () => ({
            ...UNKNOWN_PROVIDER_CAPABILITIES,
            steering: 'live',
            liveResponses: 'approvals-and-input',
          }),
          start: () => ({
            async *[Symbol.asyncIterator](): AsyncGenerator<AgentEvent> {
              yield { type: 'status', status: 'running' as const }
              await new Promise<void>((resolve) => {
                releaseTurnRef.current = resolve
              })
              yield { type: 'done' }
            },
          }),
          interrupt: () => undefined,
          dispose: () => Promise.resolve(),
          steer: (text) => {
            steered.push(text)
            return true
          },
        }),
    }
    const registry = new DriverRegistry()
    registry.register(steerableDriver)
    const engine = new Engine({
      store,
      registry,
      publish: () => undefined,
      git: { captureCheckpoint: async () => ({ ok: true, value: null }) },
    })
    const sessionId = 'sess_steer_on_demand'
    await seedSession(store, sessionId)
    await engine.dispatch({ type: 'turn.start', sessionId, text: 'long task' } as Command)
    await new Promise((r) => setTimeout(r, 50))
    await store.append(sessionId, {
      type: 'message.enqueued',
      text: 'focus on the parser',
      attachments: [],
    })

    const result = await engine.dispatch({
      type: 'message.steer',
      sessionId,
      text: 'focus on the parser',
      attachments: [],
    })
    expect(result.accepted).toBe(true)
    expect(steered).toEqual(['focus on the parser'])

    const model = await store.load(sessionId)
    expect(model.queuedMessages).toEqual([])
    expect(
      model.messages
        .filter((m) => m.role === 'user')
        .flatMap((m) => m.parts.filter((p) => p.type === 'text').map((p) => p.text)),
    ).toEqual(['long task', 'focus on the parser'])
    releaseTurnRef.current?.()
    // Let the turn settle so nothing outlives the test.
    for (let i = 0; i < 150; i++) {
      if ((await store.load(sessionId)).activeTurnId === null) break
      await new Promise((r) => setTimeout(r, 20))
    }
  }, 10000)

  it('journals output after a steer below the steered message', async () => {
    const releaseTurnRef = { current: null as (() => void) | null }
    const steerableDriver: Driver = {
      kind: 'claude',
      create: (_session: AdapterSession) =>
        Promise.resolve({
          capabilities: () => ({
            ...UNKNOWN_PROVIDER_CAPABILITIES,
            steering: 'live',
            liveResponses: 'approvals-and-input',
          }),
          start: () => ({
            async *[Symbol.asyncIterator](): AsyncGenerator<AgentEvent> {
              yield { type: 'tool-started', callId: 'c1', name: 'Bash', argsJson: '{}' }
              await new Promise<void>((resolve) => {
                releaseTurnRef.current = resolve
              })
              yield { type: 'tool-completed', callId: 'c1', resultJson: '"one"', isError: false }
              yield { type: 'tool-started', callId: 'c2', name: 'Bash', argsJson: '{}' }
              yield { type: 'tool-completed', callId: 'c2', resultJson: '"two"', isError: false }
              yield { type: 'text-delta', text: 'done' }
              yield { type: 'done' }
            },
          }),
          interrupt: () => undefined,
          dispose: () => Promise.resolve(),
          steer: () => true,
        }),
    }
    const registry = new DriverRegistry()
    registry.register(steerableDriver)
    const engine = new Engine({
      store,
      registry,
      publish: () => undefined,
      git: { captureCheckpoint: async () => ({ ok: true, value: null }) },
    })
    const sessionId = 'sess_steer_order'
    await seedSession(store, sessionId)
    await engine.dispatch({ type: 'turn.start', sessionId, text: 'long task' } as Command)
    for (let i = 0; i < 150; i++) {
      if (releaseTurnRef.current !== null) break
      await new Promise((r) => setTimeout(r, 20))
    }
    await store.append(sessionId, {
      type: 'message.enqueued',
      text: 'focus on the parser',
      attachments: [],
    })
    const result = await engine.dispatch({
      type: 'message.steer',
      sessionId,
      text: 'focus on the parser',
      attachments: [],
    })
    expect(result.accepted).toBe(true)

    releaseTurnRef.current?.()
    for (let i = 0; i < 150; i++) {
      if ((await store.load(sessionId)).activeTurnId === null) break
      await new Promise((r) => setTimeout(r, 20))
    }

    const rows = (await store.load(sessionId)).messages.map((m) => [
      m.role,
      m.parts.map((p) =>
        p.type === 'text'
          ? p.text
          : p.type === 'tool-call' || p.type === 'tool-result'
            ? `${p.type}:${p.callId}`
            : p.type,
      ),
    ])
    // The in-flight call's result stays with its call; everything the agent
    // does after the steer lands in a new message below it.
    expect(rows).toEqual([
      ['user', ['long task']],
      ['assistant', ['tool-call:c1', 'tool-result:c1']],
      ['user', ['focus on the parser']],
      ['assistant', ['tool-call:c2', 'tool-result:c2', 'done']],
    ])
  }, 10000)

  it('keeps text written before a steer above the steered message', async () => {
    const releaseTurnRef = { current: null as (() => void) | null }
    const steerableDriver: Driver = {
      kind: 'claude',
      create: (_session: AdapterSession) =>
        Promise.resolve({
          capabilities: () => ({
            ...UNKNOWN_PROVIDER_CAPABILITIES,
            steering: 'live',
            liveResponses: 'approvals-and-input',
          }),
          start: () => ({
            async *[Symbol.asyncIterator](): AsyncGenerator<AgentEvent> {
              // Still in the coalescing buffer when the steer lands.
              yield { type: 'text-delta', text: 'Let me run the tests.' }
              await new Promise<void>((resolve) => {
                releaseTurnRef.current = resolve
              })
              yield { type: 'text-delta', text: 'On the parser now.' }
              yield { type: 'done' }
            },
          }),
          interrupt: () => undefined,
          dispose: () => Promise.resolve(),
          steer: () => true,
        }),
    }
    const registry = new DriverRegistry()
    registry.register(steerableDriver)
    const engine = new Engine({
      store,
      registry,
      publish: () => undefined,
      git: { captureCheckpoint: async () => ({ ok: true, value: null }) },
    })
    const sessionId = 'sess_steer_buffered'
    await seedSession(store, sessionId)
    await engine.dispatch({ type: 'turn.start', sessionId, text: 'long task' } as Command)
    for (let i = 0; i < 150; i++) {
      if (releaseTurnRef.current !== null) break
      await new Promise((r) => setTimeout(r, 20))
    }
    await store.append(sessionId, {
      type: 'message.enqueued',
      text: 'focus on the parser',
      attachments: [],
    })
    await engine.dispatch({
      type: 'message.steer',
      sessionId,
      text: 'focus on the parser',
      attachments: [],
    })
    releaseTurnRef.current?.()
    for (let i = 0; i < 150; i++) {
      if ((await store.load(sessionId)).activeTurnId === null) break
      await new Promise((r) => setTimeout(r, 20))
    }

    const rows = (await store.load(sessionId)).messages.map((m) => [
      m.role,
      m.parts.map((p) => (p.type === 'text' ? p.text : p.type)).join(''),
    ])
    expect(rows).toEqual([
      ['user', 'long task'],
      ['assistant', 'Let me run the tests.'],
      ['user', 'focus on the parser'],
      ['assistant', 'On the parser now.'],
    ])
  }, 10000)

  it('removes a queued message without running it', async () => {
    const releaseTurnRef = { current: null as (() => void) | null }
    const registry = new DriverRegistry()
    registry.register(refusingSteerDriver(releaseTurnRef))
    const engine = new Engine({
      store,
      registry,
      publish: () => undefined,
      git: { captureCheckpoint: async () => ({ ok: true, value: null }) },
    })
    const sessionId = 'sess_dequeue'
    await seedSession(store, sessionId)
    await engine.dispatch({ type: 'turn.start', sessionId, text: 'long task' } as Command)
    await new Promise((r) => setTimeout(r, 50))
    await store.append(sessionId, { type: 'message.enqueued', text: 'never mind', attachments: [] })

    const result = await engine.dispatch({
      type: 'message.dequeue',
      sessionId,
      text: 'never mind',
      attachments: [],
    })
    expect(result.accepted).toBe(true)
    expect((await store.load(sessionId)).queuedMessages).toEqual([])

    releaseTurnRef.current?.()
    for (let i = 0; i < 150; i++) {
      if ((await store.load(sessionId)).activeTurnId === null) break
      await new Promise((r) => setTimeout(r, 20))
    }
    // It was dropped, not deferred: no follow-up turn ever ran it.
    const settled = await store.load(sessionId)
    expect(
      settled.messages
        .filter((m) => m.role === 'user')
        .flatMap((m) => m.parts.filter((p) => p.type === 'text').map((p) => p.text)),
    ).toEqual(['long task'])
  }, 10000)

  it('starts a turn when an enqueue races a settle instead of rejecting it', async () => {
    const registry = new DriverRegistry()
    registry.register(refusingSteerDriver(null))
    const engine = new Engine({
      store,
      registry,
      publish: () => undefined,
      git: { captureCheckpoint: async () => ({ ok: true, value: null }) },
    })
    const sessionId = 'sess_enqueue_idle'
    await seedSession(store, sessionId)

    // The renderer still believes a turn is running here (its `running` flag
    // lags the settle), so it sends an enqueue with nothing live to queue
    // behind. That used to be rejected and the message vanished with it.
    const result = await engine.dispatch({
      type: 'message.enqueue',
      sessionId,
      text: 'first message',
      attachments: [],
    })
    expect(result.accepted).toBe(true)

    for (let i = 0; i < 150; i++) {
      const model = await store.load(sessionId)
      if (model.activeTurnId === null && model.messages.length > 0) break
      if (i === 149) throw new Error('promoted enqueue never started a turn')
      await new Promise((r) => setTimeout(r, 20))
    }
    const model = await store.load(sessionId)
    expect(model.queuedMessages).toEqual([])
    expect(
      model.messages
        .filter((m) => m.role === 'user')
        .flatMap((m) => m.parts.filter((p) => p.type === 'text').map((p) => p.text)),
    ).toEqual(['first message'])
  }, 10000)

  it('never steers an imaged message; it stays queued with its images', async () => {
    const steered: string[] = []
    const releaseRef: { current: (() => void) | null } = { current: null }
    const steerableDriver: Driver = {
      kind: 'claude',
      create: (_session: AdapterSession) =>
        Promise.resolve({
          capabilities: () => ({
            ...UNKNOWN_PROVIDER_CAPABILITIES,
            steering: 'live',
            liveResponses: 'approvals-and-input',
          }),
          start: () => ({
            async *[Symbol.asyncIterator](): AsyncGenerator<AgentEvent> {
              yield { type: 'status', status: 'running' as const }
              await new Promise<void>((resolve) => {
                releaseRef.current = resolve
              })
              yield { type: 'done' }
            },
          }),
          interrupt: () => undefined,
          dispose: () => Promise.resolve(),
          steer: (text) => {
            steered.push(text)
            releaseRef.current?.()
            return true
          },
        }),
    }
    const registry = new DriverRegistry()
    registry.register(steerableDriver)
    const engine = new Engine({
      store,
      registry,
      publish: (sessionId, event) => published.push({ sessionId, event }),
      git: { captureCheckpoint: async () => ({ ok: true, value: null }) },
    })
    const sessionId = 'sess_steer_images'
    await seedSession(store, sessionId)
    await engine.dispatch({ type: 'turn.start', sessionId, text: 'long task' } as Command)
    await new Promise((r) => setTimeout(r, 50))

    const ref = { id: 'att_1', name: 'shot.png', mimeType: 'image/png', size: 8 }
    const queued = await engine.dispatch({
      type: 'message.enqueue',
      sessionId,
      text: 'see this',
      attachments: [ref],
    })
    expect(queued.accepted).toBe(true)
    expect(steered).toEqual([])

    const model = await store.load(sessionId)
    expect(model.queuedMessages).toEqual([{ text: 'see this', attachments: [ref] }])
    releaseRef.current?.()
  }, 10000)

  it('journals agent questions and routes input.respond into the live adapter', async () => {
    const answers: { inputId: string; value: string }[] = []
    let finish: ((value: string) => void) | null = null
    const askingDriver: Driver = {
      kind: 'claude',
      create: (_session: AdapterSession) =>
        Promise.resolve({
          capabilities: () => ({
            ...UNKNOWN_PROVIDER_CAPABILITIES,
            steering: 'live',
            liveResponses: 'approvals-and-input',
          }),
          start: () => ({
            async *[Symbol.asyncIterator](): AsyncGenerator<AgentEvent> {
              yield {
                type: 'input-requested',
                inputId: 'q1',
                prompt: 'Proceed?',
                choicesJson: null,
              }
              await new Promise<string>((resolve) => {
                finish = resolve
              })
              yield { type: 'done' }
            },
          }),
          interrupt: () => undefined,
          dispose: () => Promise.resolve(),
          respondInput: (inputId, value) => {
            answers.push({ inputId, value })
            finish?.(value)
          },
        }),
    }
    const registry = new DriverRegistry()
    registry.register(askingDriver)
    const engine = new Engine({
      store,
      registry,
      publish: (sessionId, event) => published.push({ sessionId, event }),
      git: { captureCheckpoint: async () => ({ ok: true, value: null }) },
    })
    const sessionId = 'sess_input'
    await seedSession(store, sessionId)
    await engine.dispatch({ type: 'turn.start', sessionId, text: 'ask me' } as Command)

    for (let i = 0; i < 150; i++) {
      const model = await store.load(sessionId)
      if (model.pendingInputs.some((q) => q.inputId === 'q1')) break
      if (i === 149) throw new Error('agent question never surfaced')
      await new Promise((r) => setTimeout(r, 20))
    }

    const answered = await engine.dispatch({
      type: 'input.respond',
      sessionId,
      inputId: 'q1',
      value: 'proceed',
    })
    expect(answered.accepted).toBe(true)
    expect(answers).toEqual([{ inputId: 'q1', value: 'proceed' }])

    for (let i = 0; i < 150; i++) {
      const model = await store.load(sessionId)
      if (model.activeTurnId === null && model.pendingInputs.length === 0) break
      if (i === 149) throw new Error('turn never settled after answering')
      await new Promise((r) => setTimeout(r, 20))
    }

    const types = published.filter((p) => p.sessionId === sessionId).map((p) => p.event.type)
    expect(types).toContain('input.requested')
    expect(types).toContain('input.responded')
  }, 10000)

  it('routes approval.respond decisions into the live adapter (M16.8)', async () => {
    const decisions: { approvalId: string; decision: AdapterApprovalDecision }[] = []
    // An adapter that parks the stream until its approval is answered.
    let release: ((decision: AdapterApprovalDecision) => void) | null = null
    const approvalDriver: Driver = {
      kind: 'claude',
      create: (_session: AdapterSession) =>
        Promise.resolve({
          capabilities: () => ({
            ...UNKNOWN_PROVIDER_CAPABILITIES,
            steering: 'live',
            liveResponses: 'approvals-and-input',
          }),
          start: () => ({
            async *[Symbol.asyncIterator]() {
              yield {
                type: 'approval-requested',
                approvalId: 'ap_1',
                toolName: 'bash',
                summaryJson: '{}',
                // Two grants of one kind: only the id tells them apart, which
                // is what an answer from the UI actually names.
                options: [
                  { optionId: 'accept', name: 'Allow once', kind: 'allow_once' },
                  {
                    optionId: 'acceptForSession',
                    name: 'Allow for this session',
                    kind: 'allow_always',
                  },
                  { optionId: 'decline', name: 'Deny', kind: 'reject_once' },
                ],
              }
              const decision = await new Promise<AdapterApprovalDecision>((resolve) => {
                release = resolve
              })
              const label = typeof decision === 'string' ? decision : decision.optionId
              yield { type: 'text-delta', text: `resolved:${label}` }
              yield { type: 'done' }
            },
          }),
          interrupt: () => undefined,
          dispose: () => Promise.resolve(),
          respondApproval: (approvalId, decision) => {
            decisions.push({ approvalId, decision })
            release?.(decision)
          },
        }),
    }
    const registry = new DriverRegistry()
    registry.register(approvalDriver)
    const engine = new Engine({
      store,
      registry,
      publish: (sessionId, event) => published.push({ sessionId, event }),
      git: { captureCheckpoint: async () => ({ ok: true, value: null }) },
    })
    const sessionId = 'sess_approval'
    await seedSession(store, sessionId)
    await engine.dispatch({ type: 'turn.start', sessionId, text: 'run it' } as Command)

    // Wait for the adapter's approval-requested to reach the read model.
    for (let i = 0; i < 150; i++) {
      const model = await store.load(sessionId)
      if (model.pendingApprovals.some((a) => a.approvalId === 'ap_1')) break
      if (i === 149) throw new Error('approval never surfaced')
      await new Promise((r) => setTimeout(r, 20))
    }

    const responded = await engine.dispatch({
      type: 'approval.respond',
      sessionId,
      approvalId: 'ap_1',
      optionId: 'acceptForSession',
    })
    expect(responded.accepted).toBe(true)

    for (let i = 0; i < 150; i++) {
      const model = await store.load(sessionId)
      if (model.activeTurnId === null) break
      if (i === 149) throw new Error('turn never settled after approval')
      await new Promise((r) => setTimeout(r, 20))
    }
    expect(decisions).toEqual([{ approvalId: 'ap_1', decision: { optionId: 'acceptForSession' } }])
  }, 10000)

  it('upgrades the slice title once after the first successful turn (M18.2)', async () => {
    const registry = new DriverRegistry()
    registry.register(scriptedDriver({ echo: 'ok' }))
    const engine = new Engine({
      store,
      registry,
      publish: (sessionId, event) => published.push({ sessionId, event }),
      git: { captureCheckpoint: async () => ({ ok: true, value: null }) },
    })
    const sessionId = 'sess_title'
    await seedSession(store, sessionId)
    await store.append(sessionId, {
      type: 'session.updated',
      title: 'New session',
    })

    const prompt = 'can you fix the login redirect loop please'
    await engine.dispatch({ type: 'turn.start', sessionId, text: prompt } as Command)
    const settledAt = Date.now()
    while (true) {
      const model = await store.load(sessionId)
      if (model.session?.title === 'Fix the login redirect loop please') break
      if (Date.now() - settledAt > 30000) throw new Error('title never upgraded')
      await new Promise((r) => setTimeout(r, 20))
    }
    const model = await store.load(sessionId)
    expect(model.session?.title).toBe('Fix the login redirect loop please')

    // Exactly two naming events so far: the turn.start slice + the upgrade.
    const titleEvents = () =>
      published.filter(
        (p) =>
          p.event.type === 'session.updated' &&
          typeof (p.event as { title?: unknown }).title === 'string',
      )
    // The publish can land a tick after the store write the poll above observed,
    // so await the second event instead of assuming it is already visible.
    for (let i = 0; i < 150; i++) {
      if (titleEvents().length >= 2) break
      if (i === 149) throw new Error('title upgrade event never published')
      await new Promise((r) => setTimeout(r, 20))
    }
    expect(titleEvents()).toHaveLength(2)

    // A later turn never regenerates.
    await engine.dispatch({ type: 'turn.start', sessionId, text: 'second task now' } as Command)
    for (let i = 0; i < 150; i++) {
      const m = await store.load(sessionId)
      if (m.status === 'idle') break
      if (i === 149) throw new Error('second turn never settled')
      await new Promise((r) => setTimeout(r, 20))
    }
    expect(titleEvents()).toHaveLength(2)
    expect((await store.load(sessionId)).session?.title).toBe('Fix the login redirect loop please')
  }, 10000)

  it('names the session from the assistant response with prompt fallback', async () => {
    const registry = new DriverRegistry()
    registry.register(scriptedDriver({ echo: 'Fixed the login redirect loop.' }))
    const engine = new Engine({
      store,
      registry,
      publish: (sessionId, event) => published.push({ sessionId, event }),
      git: { captureCheckpoint: async () => ({ ok: true, value: null }) },
    })
    const sessionId = 'sess_title_ai'
    await seedSession(store, sessionId)
    await store.append(sessionId, {
      type: 'session.updated',
      title: 'New session',
    })

    await engine.dispatch({ type: 'turn.start', sessionId, text: 'fix it' } as Command)
    const startedAt = Date.now()
    while (true) {
      const model = await store.load(sessionId)
      if (model.session?.title === 'Fixed the login redirect loop') break
      if (Date.now() - startedAt > 30000) throw new Error('AI response title never landed')
      await new Promise((r) => setTimeout(r, 20))
    }
    expect((await store.load(sessionId)).session?.title).toBe('Fixed the login redirect loop')
  }, 10000)

  it('never generates a title off an error-settled turn', async () => {
    function failingDriver(): Driver {
      return {
        kind: 'claude',
        create: () =>
          Promise.resolve({
            capabilities: () => ({
              ...UNKNOWN_PROVIDER_CAPABILITIES,
              steering: 'live',
              liveResponses: 'approvals-and-input',
            }),
            start: () => ({
              async *[Symbol.asyncIterator](): AsyncGenerator<AgentEvent> {
                yield { type: 'error', message: 'boom', rawJson: null }
                yield { type: 'done' }
              },
            }),
            interrupt: () => undefined,
            dispose: () => Promise.resolve(),
          }),
      }
    }
    const registry = new DriverRegistry()
    registry.register(failingDriver())
    const engine = new Engine({
      store,
      registry,
      publish: (sessionId, event) => published.push({ sessionId, event }),
      git: { captureCheckpoint: async () => ({ ok: true, value: null }) },
    })
    const sessionId = 'sess_err_title'
    await seedSession(store, sessionId)
    await store.append(sessionId, { type: 'session.updated', title: 'New session' })
    const prompt = 'can you fix the login redirect loop please'
    await engine.dispatch({ type: 'turn.start', sessionId, text: prompt } as Command)
    for (let i = 0; i < 150; i++) {
      if (published.some((p) => p.event.type === 'turn.settled')) break
      if (i === 149) throw new Error('turn never settled')
      await new Promise((r) => setTimeout(r, 20))
    }
    await new Promise((r) => setTimeout(r, 50))
    const model = await store.load(sessionId)
    expect(model.status).toBe('error')
    // Only the turn.start slice rename happened; no post-settle upgrade.
    expect(model.session?.title).toBe(prompt)
  }, 10000)

  it('routes title generation through an injected strategy', async () => {
    const registry = new DriverRegistry()
    registry.register(scriptedDriver({ echo: 'done' }))
    const engine = new Engine({
      store,
      registry,
      publish: (sessionId, event) => published.push({ sessionId, event }),
      git: { captureCheckpoint: async () => ({ ok: true, value: null }) },
      titleStrategy: {
        generate: (request) =>
          Promise.resolve(request.prompt.includes('auth') ? 'Auth deep dive' : null),
      },
    })
    const sessionId = 'sess_llm_title'
    await seedSession(store, sessionId)
    await store.append(sessionId, { type: 'session.updated', title: 'New session' })
    await engine.dispatch({ type: 'turn.start', sessionId, text: 'explain auth flow' } as Command)
    const startedAt = Date.now()
    while (true) {
      const model = await store.load(sessionId)
      if (model.session?.title === 'Auth deep dive') break
      if (Date.now() - startedAt > 30000) throw new Error('strategy title never landed')
      await new Promise((r) => setTimeout(r, 20))
    }
    expect((await store.load(sessionId)).session?.title).toBe('Auth deep dive')
  }, 10000)

  it('pins, archives, and unpins a session end-to-end (M18.2)', async () => {
    const registry = new DriverRegistry()
    const engine = new Engine({
      store,
      registry,
      publish: (sessionId, event) => published.push({ sessionId, event }),
      git: { captureCheckpoint: async () => ({ ok: true, value: null }) },
    })
    const sessionId = 'sess_flags'
    await seedSession(store, sessionId)

    const pin = await engine.dispatch({ type: 'session.update', sessionId, pinned: true })
    expect(pin.accepted).toBe(true)
    let model = await store.load(sessionId)
    expect(model.session?.pinned).toBe(true)
    expect(model.session?.archived).toBe(false)

    const archive = await engine.dispatch({ type: 'session.update', sessionId, archived: true })
    expect(archive.accepted).toBe(true)
    model = await store.load(sessionId)
    expect(model.session?.archived).toBe(true)

    // Archived sessions still list — flagged, not hidden (renderer decides).
    const listed = await store.listSessions()
    const entry = listed.find((s) => s.id === sessionId)
    expect(entry?.archived).toBe(true)
    expect(entry?.pinned).toBe(true)

    const clear = await engine.dispatch({
      type: 'session.update',
      sessionId,
      archived: false,
      pinned: false,
    })
    expect(clear.accepted).toBe(true)
    model = await store.load(sessionId)
    expect(model.session?.archived).toBe(false)
    expect(model.session?.pinned).toBe(false)
    expect((await store.listSessions()).find((s) => s.id === sessionId)?.archived).toBe(false)
  })
})

describe('session title source', () => {
  /** Plays one scripted event list per turn; `hang` parks each turn after its events. */
  function turnsDriver(turns: AgentEvent[][], hang = false): Driver {
    let next = 0
    return {
      kind: 'claude',
      create: () => {
        const events = turns[next++] ?? []
        return Promise.resolve({
          capabilities: () => ({
            ...UNKNOWN_PROVIDER_CAPABILITIES,
            steering: 'live',
            liveResponses: 'approvals-and-input',
          }),
          start: () => ({
            async *[Symbol.asyncIterator](): AsyncGenerator<AgentEvent> {
              yield* events
              if (hang) await new Promise(() => undefined)
              yield { type: 'done' }
            },
          }),
          interrupt: () => undefined,
          dispose: () => Promise.resolve(),
        })
      },
    }
  }

  function engineFor(driver: Driver, titleStrategy?: TitleStrategy): Engine {
    const registry = new DriverRegistry()
    registry.register(driver)
    return new Engine({
      store,
      registry,
      publish: (sessionId, event) => published.push({ sessionId, event }),
      git: { captureCheckpoint: async () => ({ ok: true, value: null }) },
      ...(titleStrategy ? { titleStrategy } : {}),
    })
  }

  async function untitledSession(sessionId: string): Promise<void> {
    await seedSession(store, sessionId)
    await store.append(sessionId, { type: 'session.updated', title: 'New session' })
  }

  async function until(what: string, check: () => boolean | Promise<boolean>): Promise<void> {
    for (let i = 0; i < 250; i++) {
      if (await check()) return
      await new Promise((r) => setTimeout(r, 20))
    }
    throw new Error(`${what} never happened`)
  }

  const titleOf = async (sessionId: string): Promise<string | undefined> =>
    (await store.load(sessionId)).session?.title

  const settles = (sessionId: string): number =>
    published.filter((p) => p.sessionId === sessionId && p.event.type === 'turn.settled').length

  it('joins streamed deltas into the title without injecting separators', async () => {
    const engine = engineFor(
      turnsDriver([
        [
          { type: 'text-delta', text: 'Ref' },
          { type: 'text-delta', text: 'actored the tokenizer in package' },
          { type: 'text-delta', text: '.json' },
          { type: 'text-delta', text: '.' },
        ],
      ]),
    )
    const sessionId = 'sess_title_deltas'
    await untitledSession(sessionId)

    await engine.dispatch({ type: 'turn.start', sessionId, text: 'fix it' } as Command)
    await until('title upgrade', async () => (await titleOf(sessionId)) !== 'fix it')

    expect(await titleOf(sessionId)).toBe('Refactored the tokenizer in package.json')
  }, 10000)

  it('keeps a spawned child on the title it was given', async () => {
    const engine = engineFor(
      turnsDriver([[{ type: 'text-delta', text: 'Refactored the tokenizer in package.json.' }]]),
    )
    const sessionId = 'sess_child_title'
    await store.append(sessionId, {
      type: 'session.created',
      session: {
        id: sessionId,
        projectId: 'proj_1',
        parentSessionId: 'sess_root',
        title: 'fix it',
        driverKind: 'claude',
        modelId: null,
        permissionMode: 'ask',
        status: 'idle',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    })
    await engine.dispatch({ type: 'turn.start', sessionId, text: 'fix it' } as Command)
    await until('settle', () => settles(sessionId) > 0)
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(await titleOf(sessionId)).toBe('fix it')
  }, 10000)

  it('tells Aria when a turn it asked for settles, in any project', async () => {
    const engine = engineFor(turnsDriver([[{ type: 'text-delta', text: 'Fixed the redirect.' }]]))
    await seedSession(store, 'sess_helm', 'helm')
    await seedSession(store, 'sess_work', 'proj_1')
    await engine.dispatch(
      { type: 'turn.start', sessionId: 'sess_work', text: 'fix the redirect', attachments: [] },
      { kind: 'session', sessionId: 'sess_helm' },
    )
    await until('settle', () => settles('sess_work') > 0)
    await until(
      'routed',
      async () =>
        (await store.load('sess_helm')).childCompletions?.['sess_work']?.stopReason === 'completed',
    )
    // A turn a person started in that session is not Aria's.
    await engine.dispatch({
      type: 'turn.start',
      sessionId: 'sess_work',
      text: 'thanks',
      attachments: [],
    })
    await until('second settle', () => settles('sess_work') > 1)
    const routed = (await store.load('sess_helm')).childEvents ?? []
    expect(routed.filter((event) => event.type === 'child.session.settled')).toHaveLength(1)
  }, 10000)

  it.each([
    { lead: true, person: false, routed: true },
    { lead: false, person: false, routed: false },
    { lead: true, person: true, routed: false },
  ])(
    'routes an old Aria result only for project leads: %j',
    async ({ lead, person, routed }) => {
      let finish!: () => void
      const gate = new Promise<void>((resolve) => {
        finish = resolve
      })
      const driver: Driver = {
        kind: 'claude',
        create: async () => ({
          start: () => ({
            async *[Symbol.asyncIterator]() {
              await gate
              yield { type: 'text-delta' as const, text: 'Fixed and verified.' }
              yield { type: 'done' as const }
            },
          }),
          interrupt: () => finish(),
          dispose: async () => undefined,
        }),
      }
      const engine = engineFor(driver)
      await seedSession(store, 'old_aria', 'helm')
      await seedSession(store, 'project_lead', 'proj_1', {
        ...(lead ? { lead: true } : {}),
        createdBy: { kind: 'session', sessionId: 'old_aria' },
      })
      await engine.dispatch(
        { type: 'turn.start', sessionId: 'project_lead', text: 'fix it', attachments: [] },
        person ? undefined : { kind: 'session', sessionId: 'old_aria' },
      )
      await store.destroy('old_aria')
      await seedSession(store, 'archived_aria', 'helm', { archived: true })
      await seedSession(store, 'current_aria', 'helm')
      finish()
      await engine.quiesce('project_lead')
      expect(Boolean((await store.load('current_aria')).childCompletions?.project_lead)).toBe(
        routed,
      )
      expect((await store.load('archived_aria')).childCompletions?.project_lead).toBeUndefined()
    },
    10000,
  )

  it('puts Aria turn context ahead of the provider prompt only', async () => {
    const prompts: string[] = []
    const registry = new DriverRegistry()
    registry.register({
      kind: 'claude',
      create: (session) => {
        prompts.push(session.prompt)
        return Promise.resolve({
          start: () =>
            (async function* (): AsyncGenerator<AgentEvent> {
              yield { type: 'done' }
            })(),
          interrupt: () => undefined,
          dispose: () => Promise.resolve(),
        })
      },
    })
    const engine = new Engine({
      store,
      registry,
      publish: (sessionId, event) => published.push({ sessionId, event }),
      git: { captureCheckpoint: async () => ({ ok: true, value: null }) },
      runtimeEnvironment: async () => ({ ARI_ENV: '1' }),
      turnContext: async (session) => (session.projectId === 'helm' ? '[Ari now: test]' : null),
    })
    await seedSession(store, 'sess_helm', 'helm')
    await engine.dispatch({
      type: 'turn.start',
      sessionId: 'sess_helm',
      text: 'what is running',
      attachments: [],
    })
    await until('settle', () => settles('sess_helm') > 0)
    expect(prompts[0]).toContain('[Ari now: test]\n\nwhat is running')
    const asked = (await store.load('sess_helm')).messages.find((m) => m.role === 'user')
    expect(JSON.stringify(asked?.parts)).not.toContain('Ari now')
  }, 10000)

  it('skips a notice banner that opens the first reply', async () => {
    const engine = engineFor(
      turnsDriver([
        [
          { type: 'notice', message: '"gpt-9" is not offered by this agent.' },
          { type: 'text-delta', text: 'Fixed the login' },
          { type: 'text-delta', text: ' redirect loop.' },
        ],
      ]),
    )
    const sessionId = 'sess_title_notice'
    await untitledSession(sessionId)

    await engine.dispatch({ type: 'turn.start', sessionId, text: 'fix it' } as Command)
    await until('title upgrade', async () => (await titleOf(sessionId)) !== 'fix it')

    expect(await titleOf(sessionId)).toBe('Fixed the login redirect loop')
  }, 10000)

  it('names a retried session from the retry, not the failed turn banner', async () => {
    const engine = engineFor(
      turnsDriver([
        [{ type: 'error', message: 'Not logged in · Please run /login', rawJson: null }],
        [{ type: 'text-delta', text: 'Fixed the login redirect loop.' }],
      ]),
    )
    const sessionId = 'sess_title_retry'
    await untitledSession(sessionId)

    await engine.dispatch({ type: 'turn.start', sessionId, text: 'fix it' } as Command)
    await until('failed turn settle', () => settles(sessionId) === 1)
    expect((await store.load(sessionId)).status).toBe('error')

    await engine.dispatch({ type: 'turn.start', sessionId, text: 'try again' } as Command)
    await until('title upgrade', async () => (await titleOf(sessionId)) !== 'fix it')

    expect(await titleOf(sessionId)).toBe('Fixed the login redirect loop')
  }, 10000)

  it('falls back to the prompt when the first turn is interrupted mid-reply', async () => {
    const engine = engineFor(
      turnsDriver(
        [
          [
            { type: 'text-delta', text: 'Refactoring the tokenizer so that it' },
            { type: 'tool-started', callId: 'c1', name: 'read', argsJson: '{}' },
          ],
        ],
        true,
      ),
    )
    const sessionId = 'sess_title_interrupt'
    await untitledSession(sessionId)
    const prompt = 'can you fix the login redirect loop please'

    await engine.dispatch({ type: 'turn.start', sessionId, text: prompt } as Command)
    await until('partial reply', async () =>
      (await store.load(sessionId)).messages.some((m) => m.role === 'assistant'),
    )
    await engine.dispatch({ type: 'turn.interrupt', sessionId })
    await until('title upgrade', async () => (await titleOf(sessionId)) !== prompt)

    expect(await titleOf(sessionId)).toBe('Fix the login redirect loop please')
  }, 10000)

  it('keeps the title of a session that was already answered before this run', async () => {
    const driver = turnsDriver([
      [{ type: 'text-delta', text: 'Added retry logic with exponential backoff.' }],
      [{ type: 'text-delta', text: 'Bumped the retry ceiling to five attempts.' }],
    ])
    const sessionId = 'sess_title_existing'
    await untitledSession(sessionId)
    const prompt = 'Add retry logic to the fetch client'

    // An earlier run left the prompt slice in place, as pre-response builds did.
    const earlier = engineFor(driver, { generate: () => Promise.resolve(null) })
    await earlier.dispatch({ type: 'turn.start', sessionId, text: prompt } as Command)
    await until('first turn settle', () => settles(sessionId) === 1)
    expect(await titleOf(sessionId)).toBe(prompt)

    const requests: TitleRequest[] = []
    const restarted = engineFor(driver, {
      generate: (request) => {
        requests.push(request)
        return deterministicTitleStrategy.generate(request)
      },
    })
    await restarted.dispatch({ type: 'turn.start', sessionId, text: 'raise it' } as Command)
    await until('title request', () => requests.length === 1)
    await new Promise((r) => setTimeout(r, 50))

    expect(requests[0]?.response).toBeUndefined()
    expect(await titleOf(sessionId)).toBe(prompt)
  }, 10000)
})

describe('turn workspace', () => {
  /** Driver that records every AdapterSession it is created with. */
  function recordingDriver(created: AdapterSession[]): Driver {
    return {
      kind: 'claude',
      create: (session) => {
        created.push(session)
        return Promise.resolve({
          capabilities: () => ({
            ...UNKNOWN_PROVIDER_CAPABILITIES,
            steering: 'live',
            liveResponses: 'approvals-and-input',
          }),
          start: () => ({
            async *[Symbol.asyncIterator](): AsyncGenerator<AgentEvent> {
              yield { type: 'done' }
            },
          }),
          interrupt: () => undefined,
          dispose: () => Promise.resolve(),
        })
      },
    }
  }

  async function waitSettled(store: SessionStore, sessionId: string): Promise<void> {
    for (let i = 0; i < 150; i++) {
      const model = await store.load(sessionId)
      if (model.activeTurnId === null) return
      if (i === 149) throw new Error('turn never settled')
      await new Promise((r) => setTimeout(r, 20))
    }
  }

  /** A git repo scratch project; skipped assertions when git is unavailable. */
  async function initRepo(): Promise<string | null> {
    const repo = await mkdtemp(join(tmpdir(), 'ari-proj-'))
    dirs.push(repo)
    try {
      execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore' })
      execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: repo, stdio: 'ignore' })
    } catch {
      return null
    }
    return repo
  }

  it('runs a turn in the project folder the user opened, not a checkout of its own', async () => {
    const projectDir = await initRepo()
    if (projectDir === null) return // no git on this machine

    const created: AdapterSession[] = []
    const registry = new DriverRegistry()
    registry.register(recordingDriver(created))
    const engine = new Engine({
      store,
      registry,
      publish: (sessionId, event) => published.push({ sessionId, event }),
      git: { captureCheckpoint: async () => ({ ok: true, value: null }) },
      resolveWorkspace: async () => projectDir,
    })

    const sessionId = 'sess_ws_project'
    await seedSession(store, sessionId)
    const result = await engine.dispatch({
      type: 'turn.start',
      sessionId,
      text: 'build it',
    } as Command)
    expect(result.accepted).toBe(true)
    await waitSettled(store, sessionId)

    // A user who asked for a build expects it in the folder they opened. Ari
    // never moves the agent into `.ari/worktrees/<sessionId>` on its own — a
    // worktree is the agent's to make when the prompt asks for one.
    expect(created).toHaveLength(1)
    expect(created[0]?.workspacePath).toBe(projectDir)
    expect(existsSync(join(projectDir, '.ari'))).toBe(false)
    const worktrees = execFileSync('git', ['worktree', 'list'], {
      cwd: projectDir,
      encoding: 'utf8',
    })
    expect(worktrees.trim().split(/\r?\n/)).toHaveLength(1) // the main checkout only
    expect(
      execFileSync('git', ['branch', '--list', 'ari/*'], { cwd: projectDir, encoding: 'utf8' }),
    ).toBe('')
  }, 10000)

  it('keeps ad-hoc sessions on the home directory', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'ari-home-'))
    dirs.push(homeDir)

    const created: AdapterSession[] = []
    const registry = new DriverRegistry()
    registry.register(recordingDriver(created))
    const engine = new Engine({
      store,
      registry,
      publish: (sessionId, event) => published.push({ sessionId, event }),
      git: { captureCheckpoint: async () => ({ ok: true, value: null }) },
      resolveWorkspace: async (projectId) => (projectId === 'adhoc' ? homeDir : null),
    })

    const sessionId = 'sess_adhoc_ws'
    await seedSession(store, sessionId, 'adhoc')
    const result = await engine.dispatch({ type: 'turn.start', sessionId, text: 'q' } as Command)
    expect(result.accepted).toBe(true)
    await waitSettled(store, sessionId)

    expect(created[0]?.workspacePath).toBe(homeDir)
  }, 10000)

  it('settles with an actionable error when the project folder is gone', async () => {
    const created: AdapterSession[] = []
    const registry = new DriverRegistry()
    registry.register(recordingDriver(created))
    const engine = new Engine({
      store,
      registry,
      publish: (sessionId, event) => published.push({ sessionId, event }),
      git: { captureCheckpoint: async () => ({ ok: true, value: null }) },
      resolveWorkspace: async () => null,
    })

    const sessionId = 'sess_ws_missing'
    await seedSession(store, sessionId)
    await engine.dispatch({ type: 'turn.start', sessionId, text: 'hi' } as Command)
    await waitSettled(store, sessionId)

    expect(created).toHaveLength(0) // no adapter is spawned without a cwd
    const settled = published.find(
      (p) => p.sessionId === sessionId && p.event.type === 'turn.settled',
    )
    if (settled?.event.type === 'turn.settled') {
      expect(settled.event.stopReason).toBe('error')
      expect(settled.event.errorMessage).toContain('workspace folder not found')
    }
  }, 10000)
})

describe('Engine durable queue continuation', () => {
  it('dequeues a steered message immediately so it never re-runs as a turn', async () => {
    // Ref cell: TS control-flow analysis would otherwise narrow a plain
    // `let` to null at the call site even though the generator assigns it.
    const releaseRef: { current: (() => void) | null } = { current: null }
    const steerableDriver: Driver = {
      kind: 'claude',
      create: (_session: AdapterSession) =>
        Promise.resolve({
          capabilities: () => ({
            ...UNKNOWN_PROVIDER_CAPABILITIES,
            steering: 'live',
            liveResponses: 'approvals-and-input',
          }),
          start: () => ({
            async *[Symbol.asyncIterator](): AsyncGenerator<AgentEvent> {
              yield { type: 'status', status: 'running' as const }
              await new Promise<void>((resolve) => {
                releaseRef.current = resolve
              })
              yield { type: 'done' }
            },
          }),
          interrupt: () => undefined,
          dispose: () => Promise.resolve(),
          steer: () => true,
        }),
    }
    const registry = new DriverRegistry()
    registry.register(steerableDriver)
    const engine = new Engine({
      store,
      registry,
      publish: () => undefined,
      git: { captureCheckpoint: async () => ({ ok: true, value: null }) },
    })
    const sessionId = 'sess_steer_drain'
    await seedSession(store, sessionId)
    await engine.dispatch({ type: 'turn.start', sessionId, text: 'long task' } as Command)
    await new Promise((r) => setTimeout(r, 50))

    expect(
      (
        await engine.dispatch({
          type: 'message.enqueue',
          sessionId,
          text: 'steer away',
          attachments: [],
        })
      ).accepted,
    ).toBe(true)
    const steered = await engine.dispatch({
      type: 'message.steer',
      sessionId,
      text: 'steer away',
      attachments: [],
    })
    expect(steered.accepted).toBe(true)

    // The steering-capable transport consumed the text; the journal must
    // reflect that the queue is empty again, and the follow-up must still
    // appear as a user message so it doesn't vanish from the session.
    const model = await store.load(sessionId)
    expect(model.queuedMessages).toEqual([])
    expect(
      model.messages.some(
        (m) =>
          m.role === 'user' &&
          m.parts.some((part) => part.type === 'text' && part.text === 'steer away'),
      ),
    ).toBe(true)

    releaseRef.current?.()
  }, 10000)

  /**
   * A driver that parks its first turn until the test releases it and lets
   * every later turn complete on its own, so a queue drain cannot hang the
   * test. `steer` answers from `accept` — false stands in for a transport
   * that keeps the message queued.
   */
  function holdingDriver(options: {
    release: { current: (() => void) | null }
    accept: (call: number) => boolean
    steered?: string[]
  }): Driver {
    let started = 0
    let calls = 0
    return {
      kind: 'claude',
      create: (_session: AdapterSession) =>
        Promise.resolve({
          capabilities: () => ({
            ...UNKNOWN_PROVIDER_CAPABILITIES,
            steering: 'live',
            liveResponses: 'approvals-and-input',
          }),
          start: () => ({
            async *[Symbol.asyncIterator](): AsyncGenerator<AgentEvent> {
              yield { type: 'status', status: 'running' as const }
              if (++started === 1) {
                await new Promise<void>((resolve) => {
                  options.release.current = resolve
                })
              }
              yield { type: 'done' }
            },
          }),
          interrupt: () => undefined,
          dispose: () => Promise.resolve(),
          steer: (text) => {
            options.steered?.push(text)
            return options.accept(++calls)
          },
        }),
    }
  }

  /** Waits for a turn that may still be draining the queue behind it. */
  async function settleInto(
    sessionId: string,
    done: (model: Awaited<ReturnType<typeof store.load>>) => boolean,
    what: string,
  ): Promise<Awaited<ReturnType<typeof store.load>>> {
    for (let i = 0; i < 150; i++) {
      const model = await store.load(sessionId)
      if (model.activeTurnId === null && done(model)) return model
      await new Promise((r) => setTimeout(r, 20))
    }
    throw new Error(`${what} never happened`)
  }

  const userTexts = (model: Awaited<ReturnType<typeof store.load>>): string[] =>
    model.messages
      .filter((m) => m.role === 'user')
      .flatMap((m) => m.parts.filter((p) => p.type === 'text').map((p) => p.text))

  it('dequeues a child-originated steer under the stored origin, not the bare command', async () => {
    // The renderer has no origin to send, so `message.steer` arrives bare while
    // the stored row carries `{kind:'session'}`. Matching the command's own
    // fields left the row queued *and* ran the text a second time as a turn.
    const release = { current: null as (() => void) | null }
    const steered: string[] = []
    const registry = new DriverRegistry()
    registry.register(holdingDriver({ release, accept: () => true, steered }))
    const engine = new Engine({
      store,
      registry,
      publish: () => undefined,
      git: { captureCheckpoint: async () => ({ ok: true, value: null }) },
    })
    const sessionId = 'sess_steer_origin'
    await seedSession(store, sessionId)
    await engine.dispatch({ type: 'turn.start', sessionId, text: 'long task' } as Command)
    await new Promise((r) => setTimeout(r, 50))
    // Journaled behind the turn by hand: an enqueue carrying an origin would
    // have been steered straight through the command path instead of queued.
    await store.append(sessionId, {
      type: 'message.enqueued',
      text: 'child asks',
      attachments: [],
      origin: { kind: 'session', sessionId: 'sess_child' },
    })

    const result = await engine.dispatch({
      type: 'message.steer',
      sessionId,
      text: 'child asks',
      attachments: [],
    })
    expect(result.accepted).toBe(true)
    // The child's own framing is what reaches the provider.
    expect(steered).toEqual(['[Ari message from session sess_child]\n\nchild asks'])
    expect((await store.load(sessionId)).queuedMessages).toEqual([])

    release.current?.()
    const settled = await settleInto(
      sessionId,
      (model) => model.queuedMessages.length === 0,
      'the steered child message settling',
    )
    // Steered means dequeued: the drain must not run it again as a follow-up.
    expect(userTexts(settled)).toEqual(['long task', 'child asks'])
  }, 10000)

  it('does not strand an identical twin when one of two queued copies is steered', async () => {
    const release = { current: null as (() => void) | null }
    const registry = new DriverRegistry()
    // The transport takes the first steer and declines the second.
    registry.register(holdingDriver({ release, accept: (call) => call === 1 }))
    const engine = new Engine({
      store,
      registry,
      publish: () => undefined,
      git: { captureCheckpoint: async () => ({ ok: true, value: null }) },
    })
    const sessionId = 'sess_steer_twin'
    await seedSession(store, sessionId)
    await engine.dispatch({ type: 'turn.start', sessionId, text: 'long task' } as Command)
    await new Promise((r) => setTimeout(r, 50))

    const enqueue = (): Promise<{ accepted: boolean }> =>
      engine.dispatch({
        type: 'message.enqueue',
        sessionId,
        text: 'run the tests',
        attachments: [],
      })
    expect((await enqueue()).accepted).toBe(true)
    expect((await enqueue()).accepted).toBe(true)
    expect(
      (
        await engine.dispatch({
          type: 'message.steer',
          sessionId,
          text: 'run the tests',
          attachments: [],
        })
      ).accepted,
    ).toBe(true)

    // The steered copy left, the declined twin is still waiting its turn.
    const mid = await store.load(sessionId)
    expect(mid.queuedMessages).toEqual([{ text: 'run the tests', attachments: [] }])
    expect(userTexts(mid)).toEqual(['long task', 'run the tests'])

    release.current?.()
    const settled = await settleInto(
      sessionId,
      (model) => userTexts(model).length === 3,
      'the surviving twin running',
    )
    // Text-matching bookkeeping used to skip the twin and leave it queued
    // forever; it has to run, and only once.
    expect(settled.queuedMessages).toEqual([])
    expect(userTexts(settled)).toEqual(['long task', 'run the tests', 'run the tests'])
  }, 10000)

  it('still runs a queued same-text message that carries images after a text-only steer', async () => {
    const release = { current: null as (() => void) | null }
    const registry = new DriverRegistry()
    registry.register(holdingDriver({ release, accept: (call) => call === 1 }))
    const engine = new Engine({
      store,
      registry,
      publish: () => undefined,
      git: { captureCheckpoint: async () => ({ ok: true, value: null }) },
      resolveAttachmentPath: async (id) => `/staged/${id}.png`,
    })
    const sessionId = 'sess_steer_image_twin'
    await seedSession(store, sessionId)
    await engine.dispatch({ type: 'turn.start', sessionId, text: 'long task' } as Command)
    await new Promise((r) => setTimeout(r, 50))

    const ref = { id: 'att_1', name: 'shot.png', mimeType: 'image/png', size: 8 }
    expect(
      (await engine.dispatch({ type: 'message.enqueue', sessionId, text: 'look', attachments: [] }))
        .accepted,
    ).toBe(true)
    // Images never steer, so this one is queued even though the transport is
    // still accepting text.
    expect(
      (
        await engine.dispatch({
          type: 'message.enqueue',
          sessionId,
          text: 'look',
          attachments: [ref],
        })
      ).accepted,
    ).toBe(true)
    expect(
      (
        await engine.dispatch({
          type: 'message.steer',
          sessionId,
          text: 'look',
          attachments: [],
        })
      ).accepted,
    ).toBe(true)

    const mid = await store.load(sessionId)
    expect(mid.queuedMessages).toEqual([{ text: 'look', attachments: [ref] }])

    release.current?.()
    const settled = await settleInto(
      sessionId,
      (model) => userTexts(model).length === 3,
      'the imaged twin running',
    )
    // A text-only steer key used to suppress the queued row that shares its
    // text, even though the projection matches on the image set too.
    expect(settled.queuedMessages).toEqual([])
    expect(
      settled.messages.some(
        (m) =>
          m.role === 'user' &&
          m.parts.some((p) => p.type === 'image' && p.attachmentId === 'att_1'),
      ),
    ).toBe(true)
  }, 10000)

  it('retries a sibling queue when a live turn releases root capacity', async () => {
    const started: string[] = []
    let waitingRuns = 0
    let busyDisposeEntered = false
    let enforceCapacity = false
    let releaseBusyDispose!: () => void
    let releaseWaitingTurn!: () => void
    const busyDisposeGate = new Promise<void>((resolve) => {
      releaseBusyDispose = resolve
    })
    const waitingTurnGate = new Promise<void>((resolve) => {
      releaseWaitingTurn = resolve
    })
    const driver: Driver = {
      kind: 'claude',
      create: (session: AdapterSession) =>
        Promise.resolve({
          capabilities: () => ({
            ...UNKNOWN_PROVIDER_CAPABILITIES,
            steering: 'live',
            liveResponses: 'approvals-and-input',
          }),
          start: () => ({
            async *[Symbol.asyncIterator](): AsyncGenerator<AgentEvent> {
              started.push(session.sessionId)
              if (session.sessionId === 'sess_waiting' && ++waitingRuns === 1) {
                yield { type: 'status', status: 'running' as const }
                await waitingTurnGate
              }
              yield { type: 'done' }
            },
          }),
          interrupt: () => undefined,
          dispose: () => {
            if (session.sessionId !== 'sess_busy') return Promise.resolve()
            busyDisposeEntered = true
            return busyDisposeGate
          },
        }),
    }
    const registry = new DriverRegistry()
    registry.register(driver)
    const engine: Engine = new Engine({
      store,
      registry,
      publish: () => undefined,
      git: { captureCheckpoint: async () => ({ ok: true, value: null }) },
      authorizeTurn: async (session): Promise<string | null> =>
        enforceCapacity &&
        ['sess_busy', 'sess_waiting'].some((id) => id !== session.id && engine.hasLiveTurn(id))
          ? 'Maximum concurrent child sessions reached.'
          : null,
    })
    await seedSession(store, 'sess_root')
    for (const id of ['sess_busy', 'sess_waiting']) {
      await store.append(id, {
        type: 'session.created',
        session: {
          id,
          projectId: 'proj_1',
          parentSessionId: 'sess_root',
          rootSessionId: 'sess_root',
          title: id,
          driverKind: 'claude',
          modelId: null,
          permissionMode: 'ask',
          status: 'idle',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      })
    }

    await engine.dispatch({
      type: 'turn.start',
      sessionId: 'sess_busy',
      text: 'busy',
      attachments: [],
    })
    for (let i = 0; i < 200; i++) {
      if (busyDisposeEntered && engine.hasLiveTurn('sess_busy')) break
      if (i === 199) throw new Error('busy turn did not enter disposal')
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    await engine.dispatch({
      type: 'turn.start',
      sessionId: 'sess_waiting',
      text: 'first waiting turn',
      attachments: [],
    })
    for (let i = 0; i < 200; i++) {
      if (waitingRuns === 1) break
      if (i === 199) throw new Error('waiting turn did not start')
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    enforceCapacity = true
    await engine.dispatch({
      type: 'message.enqueue',
      sessionId: 'sess_waiting',
      text: 'run after capacity frees',
      attachments: [],
    })
    releaseWaitingTurn()
    await engine.quiesce('sess_waiting')
    expect(waitingRuns).toBe(1)
    expect((await store.load('sess_waiting')).queuedMessages).toHaveLength(1)

    releaseBusyDispose()
    await engine.quiesce('sess_busy')
    for (let i = 0; i < 300; i++) {
      const waiting = await store.load('sess_waiting')
      if (waitingRuns === 2 && waiting.activeTurnId === null) break
      if (i === 299) throw new Error('waiting queue was not retried')
      await new Promise((resolve) => setTimeout(resolve, 10))
    }

    expect(started).toEqual(['sess_busy', 'sess_waiting', 'sess_waiting'])
    expect((await store.load('sess_waiting')).queuedMessages).toEqual([])
  }, 10000)

  it('after a clean settle the engine runs the oldest queued message itself', async () => {
    const startedPrompts: string[] = []
    let runCount = 0
    const releaseRef: { current: (() => void) | null } = { current: null }
    const plainDriver: Driver = {
      // seedSession() seeds a `claude` session — kinds must match.
      kind: 'claude',
      create: (session: AdapterSession) =>
        Promise.resolve({
          capabilities: () => ({
            ...UNKNOWN_PROVIDER_CAPABILITIES,
            steering: 'live',
            liveResponses: 'approvals-and-input',
          }),
          start: () => ({
            async *[Symbol.asyncIterator](): AsyncGenerator<AgentEvent> {
              runCount++
              startedPrompts.push(session.prompt)
              if (runCount === 1) {
                yield { type: 'status', status: 'running' as const }
                await new Promise<void>((resolve) => {
                  releaseRef.current = resolve
                })
                yield { type: 'done' }
              } else {
                yield { type: 'text-delta', text: 'continued turn output' }
                yield { type: 'done' }
              }
            },
          }),
          interrupt: () => undefined,
          dispose: () => Promise.resolve(),
        }),
    }
    const registry = new DriverRegistry()
    registry.register(plainDriver)
    const engine = new Engine({
      store,
      registry,
      publish: (sessionId, event) => published.push({ sessionId, event }),
      git: { captureCheckpoint: async () => ({ ok: true, value: null }) },
    })
    const sessionId = 'sess_queue_cont'
    await seedSession(store, sessionId)

    await engine.dispatch({ type: 'turn.start', sessionId, text: 'first prompt' } as Command)
    // Wait for the turn to actually register rather than a blind sleep.
    for (let i = 0; i < 200; i++) {
      const running = await store.load(sessionId)
      if (running.activeTurnId !== null && releaseRef.current !== null) break
      if (i === 199) throw new Error('first turn never registered')
      await new Promise((r) => setTimeout(r, 10))
    }

    const queued = await engine.dispatch({
      type: 'message.enqueue',
      sessionId,
      text: 'queued follow-up',
      attachments: [],
    })
    expect(queued.accepted).toBe(true)

    releaseRef.current?.()

    // The continuation runs and settles on its own.
    for (let i = 0; i < 600; i++) {
      const after = await store.load(sessionId)
      if (runCount >= 2 && after.activeTurnId === null) break
      if (i === 599) throw new Error('continuation never ran or never settled')
      await new Promise((r) => setTimeout(r, 20))
    }

    const model = await store.load(sessionId)
    expect(model.queuedMessages).toEqual([])
    expect(startedPrompts).toContain('queued follow-up')
    const userTexts = published
      .map((p) => p.event)
      .filter(
        (
          e,
        ): e is JournalEvent & {
          type: 'user.message.added'
          message: { parts: { type: string; text?: string }[] }
        } => e.type === 'user.message.added',
      )
    expect(
      userTexts.some((e) =>
        e.message.parts.some((part) => part.type === 'text' && part.text === 'queued follow-up'),
      ),
    ).toBe(true)
  }, 30000)

  it('does not strand a message enqueued while the turn is settling', async () => {
    const startedPrompts: string[] = []
    let runCount = 0
    const releaseRef: { current: (() => void) | null } = { current: null }
    const plainDriver: Driver = {
      kind: 'claude',
      create: (session: AdapterSession) =>
        Promise.resolve({
          capabilities: () => ({
            ...UNKNOWN_PROVIDER_CAPABILITIES,
            steering: 'live',
            liveResponses: 'approvals-and-input',
          }),
          start: () => ({
            async *[Symbol.asyncIterator](): AsyncGenerator<AgentEvent> {
              runCount++
              startedPrompts.push(session.prompt)
              if (runCount === 1) {
                yield { type: 'status', status: 'running' as const }
                await new Promise<void>((resolve) => {
                  releaseRef.current = resolve
                })
                yield { type: 'done' }
              } else {
                yield { type: 'text-delta', text: 'continued turn output' }
                yield { type: 'done' }
              }
            },
          }),
          interrupt: () => undefined,
          dispose: () => Promise.resolve(),
        }),
    }
    const registry = new DriverRegistry()
    registry.register(plainDriver)
    const engine = new Engine({
      store,
      registry,
      publish: (sessionId, event) => published.push({ sessionId, event }),
      git: { captureCheckpoint: async () => ({ ok: true, value: null }) },
    })
    const sessionId = 'sess_queue_settle_race'
    await seedSession(store, sessionId)

    // Block the first turn.settled append: once blocked, settle has loaded
    // its snapshot with an EMPTY queue, so an enqueue now lands exactly in
    // the stale-snapshot window (after settle's load, before its queue
    // check). Old code strands it idle; the serialized drain must run it.
    let releaseSettled!: () => void
    const settledGate = new Promise<void>((resolve) => {
      releaseSettled = resolve
    })
    let settledEntered!: () => void
    const settledStarted = new Promise<void>((resolve) => {
      settledEntered = resolve
    })
    let settledBlocked = false
    const originalAppend = store.append.bind(store)
    const appendSpy = vi.spyOn(store, 'append').mockImplementation(async (sid, event) => {
      if (sid === sessionId && event.type === 'turn.settled' && !settledBlocked) {
        settledBlocked = true
        settledEntered()
        await settledGate
      }
      return originalAppend(sid, event)
    })

    try {
      await engine.dispatch({ type: 'turn.start', sessionId, text: 'first prompt' } as Command)
      for (let i = 0; i < 200; i++) {
        const running = await store.load(sessionId)
        if (running.activeTurnId !== null && releaseRef.current !== null) break
        if (i === 199) throw new Error('first turn never registered')
        await new Promise((r) => setTimeout(r, 10))
      }

      releaseRef.current?.()
      await settledStarted

      const racing = await engine.dispatch({
        type: 'message.enqueue',
        sessionId,
        text: 'racing message',
        attachments: [],
      })
      expect(racing.accepted).toBe(true)

      releaseSettled()

      for (let i = 0; i < 600; i++) {
        const after = await store.load(sessionId)
        if (runCount >= 2 && after.activeTurnId === null) break
        if (i === 599) throw new Error('racing continuation never ran or never settled')
        await new Promise((r) => setTimeout(r, 20))
      }

      const model = await store.load(sessionId)
      expect(model.queuedMessages).toEqual([])
      expect(startedPrompts).toContain('racing message')
    } finally {
      appendSpy.mockRestore()
    }
  }, 30000)
})

describe('streamed journal replay', () => {
  it('delivers history as bounded seq-ordered chunks, never one giant array', async () => {
    const sessionId = 'sess_chunk_replay'
    await seedSession(store, sessionId)
    const registry = new DriverRegistry()
    registry.register(scriptedDriver({ echo: ''.padEnd(128 * 1024, 'x') }))
    const engine = new Engine({
      store,
      registry,
      publish: (sid, event) => published.push({ sessionId: sid, event }),
      git: { captureCheckpoint: async () => ({ ok: true, value: null }) },
    })
    for (let turn = 0; turn < 4; turn++) {
      const result = await engine.dispatch({
        type: 'turn.start',
        sessionId,
        text: `turn ${turn}`,
      } as Command)
      expect(result.accepted).toBe(true)
      // `turn.settled` is journaled after the status flips to idle, so wait
      // for the event itself; idle alone can race the final append.
      const settledAt = Date.now() + 30000
      while (
        published.filter((p) => p.sessionId === sessionId && p.event.type === 'turn.settled')
          .length <= turn
      ) {
        if (Date.now() > settledAt) throw new Error('turn never settled')
        await new Promise((r) => setTimeout(r, 25))
      }
    }

    // Parsed straight off disk so the expectation doesn't share the journal
    // reader under test.
    const raw = await readFile(join(dir, sessionId, 'journal.0000.jsonl'), 'utf8')
    const onDisk = raw
      .split(/\r?\n/)
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as JournalEvent)
    const chunks: JournalEvent[][] = []
    await engine.replaySessionChunks(sessionId, (chunk) => {
      chunks.push(chunk)
    })
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.flat()).toEqual(onDisk)
    expect(await engine.replaySession(sessionId)).toEqual(onDisk)
  }, 30000)

  it('replaySession still returns the same ordered events as before chunking', async () => {
    const sessionId = 'sess_replay_compat'
    await seedSession(store, sessionId)
    await store.append(sessionId, {
      type: 'user.message.added',
      message: {
        id: 'm1',
        sessionId,
        turnId: 'turn_1',
        role: 'user',
        parts: [{ type: 'text', text: 'hi' }],
        createdAt: Date.now(),
      },
    })
    const registry = new DriverRegistry()
    const engine = new Engine({
      store,
      registry,
      publish: (sid, event) => published.push({ sessionId: sid, event }),
      git: { captureCheckpoint: async () => ({ ok: true, value: null }) },
    })
    const events = await engine.replaySession(sessionId)
    expect(events[0]?.type).toBe('session.created')
    expect(events.at(-1)?.type).toBe('user.message.added')
    expect(events).not.toBeNull()
  })
})
