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

    // Wait until the engine publishes turn.settled (load-independent).
    const settledAt = Date.now()
    while (!published.some((p) => p.event.type === 'turn.settled')) {
      if (Date.now() - settledAt > 30000) throw new Error('turn never settled')
      await new Promise((r) => setTimeout(r, 25))
    }

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
})

