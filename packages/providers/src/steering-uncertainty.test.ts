import { PassThrough } from 'node:stream'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it, vi } from 'vitest'
import type { AdapterSession, ProviderAdapter } from './driver'
import type { AgentEvent } from '@ari/contracts/agent-event'
import { delegationSettingsSchema } from '@ari/contracts/agent-control'
import { createCodexAppServerAdapter } from './codex/codex-driver'
import { createAcpAdapter } from './acp/acp-driver'
import { DriverRegistry } from './driver-registry'
import { SessionStore } from '../../engine/src/session-store'
import { AgentControlService } from '../../engine/src/agent-control'
import { Engine } from '../../../apps/desktop/src/main/engine'
import { startAgentRuntime } from '../../../apps/desktop/src/main/agent-runtime'

type Transport = 'codex' | 'acp'
type Failure = 'timeout' | 'disconnect' | 'refusal' | 'unavailable' | 'malformed' | 'write_failure'
interface Frame {
  id?: number
  method?: string
  params?: unknown
}

/** Real adapter/connection IO, with no provider or MCP subprocess. */
function wire(transport: Transport, failure: Failure) {
  const stdin = new PassThrough(),
    stdout = new PassThrough(),
    stderr = new PassThrough()
  const frames: Frame[] = []
  let started!: () => void, receivedSteer!: () => void
  const start = new Promise<void>((yes) => {
    started = yes
  })
  const steering = new Promise<void>((yes) => {
    receivedSteer = yes
  })
  const steerMethod = transport === 'codex' ? 'turn/steer' : '_session/steering'
  const child = {
    stdin,
    stdout,
    stderr,
    killed: false,
    kill() {
      this.killed = true
      stdin.destroy()
      stdout.destroy()
      stderr.destroy()
      return true
    },
    on() {
      return this
    },
  }
  const reply = (id: number | undefined, result: unknown) => {
    if (!stdout.destroyed) stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`)
  }
  let buffer = ''
  stdin.setEncoding('utf8')
  stdin.on('data', (chunk: string) => {
    buffer += chunk
    let newline = buffer.indexOf('\n')
    while (newline >= 0) {
      const frame = JSON.parse(buffer.slice(0, newline)) as Frame
      buffer = buffer.slice(newline + 1)
      frames.push(frame)
      if (frame.method === steerMethod) {
        receivedSteer()
        if (failure === 'write_failure')
          throw new Error('Write failed after steering bytes arrived')
        if (failure === 'disconnect') stdout.destroy()
        else if (failure === 'refusal')
          stdout.write(
            `${JSON.stringify({
              jsonrpc: '2.0',
              id: frame.id,
              error: { code: -32601, message: 'Steering is unavailable' },
            })}\n`,
          )
        else if (failure === 'malformed') reply(frame.id, {})
        // A timeout fixture has received the request but loses its reply.
      } else if (frame.method === 'initialize') {
        reply(frame.id, {
          protocolVersion: 1,
          userAgent: 'scripted',
          _meta: { steering: { supported: true } },
        })
      } else if (frame.method === 'thread/start')
        reply(frame.id, { thread: { id: 'native-thread' } })
      else if (frame.method === 'session/new') reply(frame.id, { sessionId: 'native-session' })
      else if (frame.method === 'turn/start') {
        reply(frame.id, { turn: { id: 'native-turn', status: 'inProgress' } })
        started()
      } else if (frame.method === 'session/prompt') started()
      else if (frame.id !== undefined) reply(frame.id, {})
      newline = buffer.indexOf('\n')
    }
  })
  return {
    start,
    steering,
    frames,
    stdin,
    child,
    steerFrames: () => frames.filter((frame) => frame.method === steerMethod),
    create: (session: AdapterSession): Promise<ProviderAdapter> =>
      transport === 'codex'
        ? createCodexAppServerAdapter('not-launched', session, () => child)
        : createAcpAdapter(
            { label: 'scripted', command: 'not-launched', args: [] },
            session,
            () => child,
          ),
    complete: () => {
      if (stdout.destroyed) return
      if (transport === 'codex')
        stdout.write(
          `${JSON.stringify({
            method: 'turn/completed',
            params: {
              threadId: 'native-thread',
              turn: { id: 'native-turn', status: 'completed', items: [] },
            },
          })}\n`,
        )
      else
        reply(frames.find((frame) => frame.method === 'session/prompt')?.id, {
          stopReason: 'end_turn',
        })
    },
  }
}

const session: AdapterSession = {
  sessionId: 'worker',
  workspacePath: process.cwd(),
  prompt: 'Initial task',
  modelId: null,
  permissionMode: 'full',
  resumeOf: null,
}
async function collect(adapter: ProviderAdapter): Promise<AgentEvent[]> {
  const events: AgentEvent[] = []
  for await (const event of adapter.start()) events.push(event)
  return events
}

it.each(['codex', 'acp'] as const)(
  '%s preserves submitted steering timeout uncertainty without failing the live turn',
  async (transport) => {
    const fixture = wire(transport, 'timeout')
    const adapter = await fixture.create(session)
    const events = collect(adapter)
    try {
      await fixture.start
      await new Promise<void>((yes) => setImmediate(yes))
      vi.useFakeTimers()
      const outcome = Promise.resolve(adapter.steer!('Coordination note')).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      )
      await fixture.steering
      await vi.advanceTimersByTimeAsync(10_001)
      expect(await outcome).toMatchObject({ error: { requestOutcome: 'uncertain' } })
      vi.useRealTimers()
      fixture.complete()
      expect((await events).some((event) => event.type === 'error')).toBe(false)
      expect(fixture.steerFrames()).toHaveLength(1)
    } finally {
      vi.useRealTimers()
      fixture.complete()
      await events
      fixture.child.kill()
      await adapter.dispose()
    }
  },
)

it.each(['codex', 'acp'] as const)(
  '%s preserves uncertainty when the transport closes after receiving steering',
  async (transport) => {
    const fixture = wire(transport, 'disconnect')
    const adapter = await fixture.create(session)
    const events = collect(adapter)
    try {
      await fixture.start
      await new Promise<void>((yes) => setImmediate(yes))
      await expect(adapter.steer!('Coordination note')).rejects.toMatchObject({
        requestOutcome: 'uncertain',
      })
      expect(fixture.steerFrames()).toHaveLength(1)
    } finally {
      fixture.child.kill()
      await events
      await adapter.dispose()
    }
  },
)

it.each(['codex', 'acp'] as const)(
  '%s keeps a write failure after steering arrival uncertain',
  async (transport) => {
    const fixture = wire(transport, 'write_failure')
    const adapter = await fixture.create(session)
    const events = collect(adapter)
    try {
      await fixture.start
      await new Promise<void>((yes) => setImmediate(yes))
      await expect(adapter.steer!('Coordination note')).rejects.toMatchObject({
        requestOutcome: 'uncertain',
      })
      expect(fixture.steerFrames()).toHaveLength(1)
    } finally {
      fixture.complete()
      await events
      fixture.child.kill()
      await adapter.dispose()
    }
  },
)

it.each(['codex', 'acp'] as const)(
  '%s keeps confirmed refusal and unavailable stdin safe to queue',
  async (transport) => {
    for (const failure of ['refusal', 'unavailable'] as const) {
      const fixture = wire(transport, failure)
      const adapter = await fixture.create(session)
      const events = collect(adapter)
      try {
        await fixture.start
        await new Promise<void>((yes) => setImmediate(yes))
        if (failure === 'unavailable') fixture.stdin.end()
        await expect(Promise.resolve(adapter.steer!('Coordination note'))).resolves.toBe(false)
        expect(fixture.steerFrames()).toHaveLength(failure === 'refusal' ? 1 : 0)
        fixture.complete()
        expect((await events).some((event) => event.type === 'error')).toBe(false)
      } finally {
        fixture.complete()
        await events
        fixture.child.kill()
        await adapter.dispose()
      }
    }
  },
)

it('keeps an unrecognized ACP steering receipt uncertain', async () => {
  const fixture = wire('acp', 'malformed')
  const adapter = await fixture.create(session)
  const events = collect(adapter)
  try {
    await fixture.start
    await new Promise<void>((yes) => setImmediate(yes))
    await expect(adapter.steer!('Coordination note')).rejects.toMatchObject({
      requestOutcome: 'uncertain',
    })
  } finally {
    fixture.complete()
    await events
    fixture.child.kill()
    await adapter.dispose()
  }
})

it.each(['codex', 'acp'] as const)(
  '%s retains an uncertain runtime inbox identity across service reconstruction without resend',
  async (transport) => {
    const dir = await mkdtemp(join(tmpdir(), 'ari-steering-receipt-'))
    const store = new SessionStore({ rootDir: join(dir, 'sessions') })
    const fixture = wire(transport, 'timeout')
    const registry = new DriverRegistry()
    registry.register({ kind: 'codex', create: fixture.create })
    const engine = new Engine({
      store,
      registry,
      publish: () => undefined,
      resolveWorkspace: async () => dir,
      git: { captureCheckpoint: async () => ({ ok: true, value: null }) },
    })
    let runtime: Awaited<ReturnType<typeof startAgentRuntime>> | undefined
    let replay: SessionStore | undefined
    try {
      for (const id of ['aria', 'worker'])
        await engine.createSession({
          id,
          projectId: id === 'aria' ? 'helm' : 'project',
          title: id,
          driverKind: 'codex',
          modelId: null,
          permissionMode: 'full',
          status: 'idle',
          createdAt: 1,
          updatedAt: 1,
          ...(id === 'worker' ? { createdBy: { kind: 'session', sessionId: 'aria' } } : {}),
        })
      runtime = await startAgentRuntime({
        userData: dir,
        cliPath: resolve('../../apps/desktop/resources/cli/ari.cjs'),
        executable: process.execPath,
        version: 'test',
        engine,
        store,
        policy: () => delegationSettingsSchema.parse({ approvalMode: 'never' }),
        providers: async () => [],
      })
      await engine.dispatch(
        { type: 'turn.start', sessionId: 'worker', text: 'Initial task', attachments: [] },
        { kind: 'session', sessionId: 'aria' },
      )
      await fixture.start
      await new Promise<void>((yes) => setImmediate(yes))
      const params = {
        targetSessionId: 'worker',
        text: 'Coordination note',
        idempotencyKey: 'lost-reply',
      }
      vi.useFakeTimers()
      const receipt = runtime.service.invoke('aria', 'session.message', params)
      await fixture.steering
      await vi.advanceTimersByTimeAsync(10_001)
      expect(await receipt).toMatchObject({
        ok: true,
        result: { status: 'uncertain', consumedAt: null },
      })
      vi.useRealTimers()
      expect(engine.hasLiveTurn('worker')).toBe(true)
      expect(await runtime.service.invoke('aria', 'session.message', params)).toEqual(await receipt)
      replay = new SessionStore({ rootDir: join(dir, 'sessions') })
      const reconstructed = new AgentControlService({ ...runtime.service.host, store: replay })
      expect(await reconstructed.invoke('aria', 'session.message', params)).toEqual(await receipt)
      const pending = runtime.service as AgentControlService & {
        deliverPendingCoordination?: (id: string) => Promise<void>
      }
      await pending.deliverPendingCoordination?.('worker')
      expect(fixture.steerFrames()).toHaveLength(1)
      expect(Object.values((await replay.load('worker')).inbox ?? {})[0]?.status).toBe('uncertain')
      fixture.complete()
      await engine.quiesce('worker')
      expect((await store.load('worker')).lastTurn?.stopReason).toBe('completed')
    } finally {
      vi.useRealTimers()
      fixture.complete()
      fixture.child.kill()
      await runtime?.close()
      await engine.shutdown()
      if (replay) for (const row of await replay.listSessions()) await replay.closeJournal(row.id)
      for (const row of await store.listSessions()) await store.closeJournal(row.id)
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    }
  },
)
