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
/** Extra scratch directories (project folders) created by individual tests. */
let dirs: string[]

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ari-engine-e2e-'))
  store = new SessionStore({ rootDir: dir })
  published = []
  dirs = []
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })))
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

async function seedSession(
  store: SessionStore,
  sessionId: string,
  projectId = 'proj_1',
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

  it('steers a live adapter when a message is enqueued mid-turn', async () => {
    const steered: string[] = []
    let release: (() => void) | null = null
    const steerableDriver: Driver = {
      kind: 'claude',
      create: (_session: AdapterSession) =>
        Promise.resolve({
          start: () => ({
            async *[Symbol.asyncIterator](): AsyncGenerator<AgentEvent> {
              yield { type: 'status', status: 'running' as const }
              await new Promise<void>((resolve) => {
                release = resolve
              })
              yield { type: 'done' }
            },
          }),
          interrupt: () => undefined,
          dispose: () => Promise.resolve(),
          steer: (text) => {
            steered.push(text)
            release?.()
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
    })
    expect(queued.accepted).toBe(true)

    for (let i = 0; i < 150; i++) {
      const model = await store.load(sessionId)
      if (model.activeTurnId === null) break
      if (i === 149) throw new Error('turn never settled after steer')
      await new Promise((r) => setTimeout(r, 20))
    }
    expect(steered).toEqual(['focus on the parser instead'])
  }, 10000)

  it('journals agent questions and accepts input.respond mid-turn', async () => {
    let finish: (() => void) | null = null
    const askingDriver: Driver = {
      kind: 'claude',
      create: (_session: AdapterSession) =>
        Promise.resolve({
          start: () => ({
            async *[Symbol.asyncIterator](): AsyncGenerator<AgentEvent> {
              yield { type: 'input-requested', inputId: 'q1', prompt: 'Proceed?', choicesJson: null }
              await new Promise<void>((resolve) => {
                finish = resolve
              })
              yield { type: 'done' }
            },
          }),
          interrupt: () => undefined,
          dispose: () => Promise.resolve(),
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

    ;(finish as (() => void) | null)?.()
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

  it('never generates a title off an error-settled turn', async () => {
    function failingDriver(): Driver {
      return {
        kind: 'claude',
        create: () =>
          Promise.resolve({
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

describe('M19.3 session worktrees', () => {
  /** Driver that records every AdapterSession it is created with. */
  function recordingDriver(created: AdapterSession[]): Driver {
    return {
      kind: 'claude',
      create: (session) => {
        created.push(session)
        return Promise.resolve({
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

  it('runs project turns inside the session worktree handed to driver.create', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'ari-proj-'))
    dirs.push(projectDir)
    const worktreePath = join(projectDir, '.ari', 'worktrees', 'sess_wt_run')

    const created: AdapterSession[] = []
    const ensureCalls: [string, string][] = []
    const registry = new DriverRegistry()
    registry.register(recordingDriver(created))
    const engine = new Engine({
      store,
      registry,
      publish: (sessionId, event) => published.push({ sessionId, event }),
      git: { captureCheckpoint: async () => ({ ok: true, value: null }) },
      resolveWorkspace: async () => projectDir,
      worktrees: {
        // Stands in for the real GitService-backed source.
        ensure: async (repoPath, sessionId) => {
          ensureCalls.push([repoPath, sessionId])
          return worktreePath
        },
      },
    })

    const sessionId = 'sess_wt_run'
    await seedSession(store, sessionId)
    const result = await engine.dispatch({ type: 'turn.start', sessionId, text: 'hi' } as Command)
    expect(result.accepted).toBe(true)
    await waitSettled(store, sessionId)

    // The turn's cwd — and therefore driver.create's workspacePath — is the
    // session worktree derived from the project folder + session id.
    expect(ensureCalls).toEqual([[projectDir, sessionId]])
    expect(created).toHaveLength(1)
    expect(created[0]?.workspacePath).toBe(worktreePath)
  }, 10000)

  it('falls back to the project folder when no worktree can be ensured', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'ari-proj-'))
    dirs.push(projectDir)

    const created: AdapterSession[] = []
    const registry = new DriverRegistry()
    registry.register(recordingDriver(created))
    const engine = new Engine({
      store,
      registry,
      publish: (sessionId, event) => published.push({ sessionId, event }),
      git: { captureCheckpoint: async () => ({ ok: true, value: null }) },
      resolveWorkspace: async () => projectDir,
      worktrees: { ensure: async () => null }, // fail-soft signal
    })

    const sessionId = 'sess_wt_fallback'
    await seedSession(store, sessionId)
    const result = await engine.dispatch({
      type: 'turn.start',
      sessionId,
      text: 'still works',
    } as Command)
    expect(result.accepted).toBe(true)
    await waitSettled(store, sessionId)

    expect(created[0]?.workspacePath).toBe(projectDir)
    const settled = published.find(
      (p) => p.sessionId === sessionId && p.event.type === 'turn.settled',
    )
    if (settled?.event.type === 'turn.settled') {
      expect(settled.event.stopReason).toBe('completed') // fallback never fails the turn
    }
  }, 10000)

  it('keeps ad-hoc sessions on the home directory without asking for worktrees', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'ari-home-'))
    dirs.push(homeDir)

    const created: AdapterSession[] = []
    let askedForWorktree = false
    const registry = new DriverRegistry()
    registry.register(recordingDriver(created))
    const engine = new Engine({
      store,
      registry,
      publish: (sessionId, event) => published.push({ sessionId, event }),
      git: { captureCheckpoint: async () => ({ ok: true, value: null }) },
      resolveWorkspace: async (projectId) => (projectId === 'adhoc' ? homeDir : null),
      worktrees: {
        ensure: async () => {
          askedForWorktree = true
          return '/tmp/should-not-happen'
        },
      },
    })

    const sessionId = 'sess_adhoc_wt'
    await seedSession(store, sessionId, 'adhoc')
    const result = await engine.dispatch({ type: 'turn.start', sessionId, text: 'q' } as Command)
    expect(result.accepted).toBe(true)
    await waitSettled(store, sessionId)

    expect(askedForWorktree).toBe(false)
    expect(created[0]?.workspacePath).toBe(homeDir)
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
          steer: () => undefined,
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

    const enqueued = await engine.dispatch({
      type: 'message.enqueue',
      sessionId,
      text: 'steer away',
    })
    expect(enqueued.accepted).toBe(true)

    // The steering-capable transport consumed the text; the journal must
    // reflect that the queue is empty again.
    const model = await store.load(sessionId)
    expect(model.queuedMessages).toEqual([])

    releaseRef.current?.()
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
    await new Promise((r) => setTimeout(r, 50))

    const queued = await engine.dispatch({
      type: 'message.enqueue',
      sessionId,
      text: 'queued follow-up',
    })
    expect(queued.accepted).toBe(true)

    releaseRef.current?.()

    // The continuation runs and settles on its own.
    for (let i = 0; i < 150; i++) {
      const after = await store.load(sessionId)
      if (runCount >= 2 && after.activeTurnId === null) break
      if (i === 149) throw new Error('continuation never ran or never settled')
      await new Promise((r) => setTimeout(r, 20))
    }

    const model = await store.load(sessionId)
    expect(model.queuedMessages).toEqual([])
    expect(startedPrompts).toContain('queued follow-up')
    const userTexts = published
      .map((p) => p.event)
      .filter(
        (e): e is JournalEvent & { type: 'user.message.added'; message: { parts: { type: string; text?: string }[] } } =>
          e.type === 'user.message.added',
      )
    expect(
      userTexts.some((e) =>
        e.message.parts.some((part) => part.type === 'text' && part.text === 'queued follow-up'),
      ),
    ).toBe(true)
  }, 15000)
})
