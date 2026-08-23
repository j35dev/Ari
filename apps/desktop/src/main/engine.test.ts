import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentEvent } from '@ari/contracts/agent-event'
import type { JournalEvent } from '@ari/contracts/events'
import type { Command } from '@ari/contracts/commands'
import { DriverRegistry } from '@ari/providers/registry'
import type { AdapterSession, Driver, ProviderAdapter } from '@ari/providers/driver'
import { SessionStore } from '@ari/engine/session-store'
import { Engine } from './engine'

let dir: string
let store: SessionStore
let published: { sessionId: string; event: JournalEvent }[]

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ari-engine-e2e-'))
  store = new SessionStore({ rootDir: dir })
  published = []
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
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
      yield { type: 'usage', inputTokens: 3, outputTokens: 2, costUsd: null }
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

async function seedSession(store: SessionStore, sessionId: string): Promise<void> {
  await store.append(sessionId, {
    type: 'session.created',
    session: {
      id: sessionId,
      projectId: 'proj_1',
      title: 'E2E',
      driverKind: 'claude',
      modelId: null,
      permissionMode: 'ask',
      status: 'idle',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
  })
}

describe('engine end-to-end with scripted driver', () => {
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
    if (model.messages.length !== 2) throw new Error('DEBUG events=' + JSON.stringify(published.map((p) => p.event.type)))
    expect(
      model.messages[1]?.parts.some((p) => p.type === 'text' && p.text.includes('hello')),
    ).toBe(true)
    expect(published.length).toBeGreaterThanOrEqual(5)
    expect(published[0]?.event.type).toBe('turn.started')
  }, 10000)

  it('interrupt settles an active turn and drops late adapter events', async () => {
    const slowDriver: Driver = {
      kind: 'claude',
      create: (_session: AdapterSession) =>
        Promise.resolve({
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
    const engine = new Engine({
      store,
      registry,
      publish: (sessionId, event) => published.push({ sessionId, event }),
      git: {
        captureCheckpoint: async () => ({
          ok: true,
          value: 'refs/ari/sess_gc_e2e/turn_new',
        }),
        pruneCheckpoints: async () => ({ ok: true, value: [...prunedRefs] }),
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
    const prunedEvents = events.filter((e) => e.type === 'checkpoint.pruned')
    expect(prunedEvents.map((e) => e.gitRef)).toEqual(prunedRefs)
    expect(prunedEvents[0]?.turnId).toBe('turn_old1')

    // Projection fold: pruned checkpoints leave the read model.
    const model = await store.load(sessionId)
    expect(model.checkpoints.some((c) => c.gitRef.includes('turn_old'))).toBe(false)
  }, 10000)

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
          yield { type: 'error', message: 'authentication_failed: Not logged in · Please run /login', rawJson: null }
          yield { type: 'done' }
        }
        return {
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
    for (let i = 0; i < 150; i++) {
      const model = await store.load(sessionId)
      if (model.activeTurnId === null) break
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

  it('passes the observed provider ref as resumeOf on the next turn only', async () => {
    const created: AdapterSession[] = []
    function resumingDriver(): Driver {
      return {
        kind: 'claude',
        create: (session) => {
          created.push(session)
          return Promise.resolve({
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

  it('routes approval.respond decisions into the live adapter (M16.8)', async () => {
    const decisions: { approvalId: string; decision: string }[] = []
    // An adapter that parks the stream until its approval is answered.
    let release: ((decision: string) => void) | null = null
    const approvalDriver: Driver = {
      kind: 'claude',
      create: (_session: AdapterSession) =>
        Promise.resolve({
          start: () => ({
            async *[Symbol.asyncIterator]() {
              yield { type: 'approval-requested', approvalId: 'ap_1', toolName: 'bash', summaryJson: '{}' }
              const decision = await new Promise<string>((resolve) => {
                release = resolve
              })
              yield { type: 'text-delta', text: `resolved:${decision}` }
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
      decision: 'always-allow',
    })
    expect(responded.accepted).toBe(true)

    for (let i = 0; i < 150; i++) {
      const model = await store.load(sessionId)
      if (model.activeTurnId === null) break
      if (i === 149) throw new Error('turn never settled after approval')
      await new Promise((r) => setTimeout(r, 20))
    }
    expect(decisions).toEqual([{ approvalId: 'ap_1', decision: 'always-allow' }])
  }, 10000)
})

