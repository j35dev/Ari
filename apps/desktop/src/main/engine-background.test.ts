// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent } from '@ari/contracts/agent-event'
import { SessionStore } from '@ari/engine/session-store'
import { DriverRegistry } from '@ari/providers/registry'
import type { Driver, ProviderAdapter } from '@ari/providers/driver'
import { Engine } from './engine'

let root: string
let store: SessionStore

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ari-background-'))
  store = new SessionStore({ rootDir: root })
  await store.append('sess_1', {
    type: 'session.created',
    session: {
      id: 'sess_1',
      projectId: root,
      title: 'Background',
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
  await store.closeJournal('sess_1')
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

const shell: AgentEvent = {
  type: 'background-task',
  id: 'call_bg',
  kind: 'shell',
  label: 'Run the test suite',
  status: 'running',
  detail: null,
}

/** One turn per adapter: emits `events`, then reports whether it was parked. */
function driverOf(turns: { events: AgentEvent[]; keeps: boolean }[]): Driver {
  return {
    kind: 'claude',
    create: () => {
      const turn = turns.shift() ?? { events: [], keeps: false }
      const adapter: ProviderAdapter = {
        start: () => ({
          async *[Symbol.asyncIterator]() {
            for (const event of turn.events) yield event
            yield { type: 'done' } as AgentEvent
          },
        }),
        interrupt: () => undefined,
        dispose: () => Promise.resolve(),
        keepsBackgroundWork: () => turn.keeps,
      }
      return Promise.resolve(adapter)
    },
  }
}

function engineWith(driver?: Driver): Engine {
  const registry = new DriverRegistry()
  if (driver) registry.register(driver)
  return new Engine({
    store,
    registry,
    publish: () => undefined,
    git: { captureCheckpoint: async () => ({ ok: true, value: null }) },
  })
}

async function runTurn(engine: Engine, text: string): Promise<void> {
  await engine.dispatch({ type: 'turn.start', sessionId: 'sess_1', text, attachments: [] })
  await vi.waitFor(async () => expect((await store.load('sess_1')).activeTurnId).toBeNull(), {
    timeout: 10_000,
  })
  await engine.quiesce('sess_1')
}

describe('background output', () => {
  it('journals what an agent reports between turns as one agent message', async () => {
    const engine = engineWith()
    engine.recordBackground('sess_1', [
      { type: 'tool-started', callId: 'c1', name: 'Bash', argsJson: '{"command":"npm test"}' },
    ])
    engine.recordBackground('sess_1', [
      { type: 'tool-completed', callId: 'c1', resultJson: '"ok"', isError: false },
      { type: 'text-delta', text: 'Tests ' },
      { type: 'text-delta', text: 'passed.' },
    ])
    await vi.waitFor(async () => {
      const model = await store.load('sess_1')
      expect(model.messages).toHaveLength(1)
      expect(model.messages[0]).toMatchObject({
        role: 'assistant',
        turnId: null,
        parts: [
          { type: 'tool-call', callId: 'c1', name: 'Bash' },
          { type: 'tool-result', callId: 'c1', isError: false },
          { type: 'text', text: 'Tests passed.' },
        ],
      })
    })
  })

  it('journals background tasks reported between turns', async () => {
    const engine = engineWith()
    engine.recordBackground('sess_1', [shell])
    engine.recordBackground('sess_1', [
      { type: 'text-delta', text: 'Tests passed.' },
      { ...shell, status: 'completed', detail: 'The agent reported back' },
    ])
    await vi.waitFor(async () => {
      const model = await store.load('sess_1')
      expect(model.backgroundTasks).toEqual([
        expect.objectContaining({
          id: 'call_bg',
          kind: 'shell',
          label: 'Run the test suite',
          status: 'completed',
          detail: 'The agent reported back',
        }),
      ])
    })
  })

  it('keeps a turn’s shell running while its process is parked, until the next turn', async () => {
    const engine = engineWith(
      driverOf([
        { events: [shell], keeps: true },
        { events: [], keeps: true },
      ]),
    )
    await runTurn(engine, 'start the tests in the background')
    let model = await store.load('sess_1')
    expect(model.backgroundTasks).toEqual([
      expect.objectContaining({ id: 'call_bg', status: 'running', endedAt: null }),
    ])

    await runTurn(engine, 'anything else?')
    model = await store.load('sess_1')
    expect(model.backgroundTasks).toEqual([
      expect.objectContaining({ id: 'call_bg', status: 'completed' }),
    ])
  }, 20_000)

  it('ends background work with a turn whose process was not kept', async () => {
    const engine = engineWith(driverOf([{ events: [shell], keeps: false }]))
    await runTurn(engine, 'start the tests')
    const model = await store.load('sess_1')
    expect(model.backgroundTasks).toEqual([
      expect.objectContaining({ id: 'call_bg', status: 'stopped', detail: 'Ended with the turn' }),
    ])
  }, 20_000)

  it('releases what the journal shows running once the process is gone', async () => {
    const engine = engineWith()
    engine.recordBackground('sess_1', [shell])
    await vi.waitFor(async () =>
      expect((await store.load('sess_1')).backgroundTasks?.[0]?.status).toBe('running'),
    )
    await engine.releaseBackgroundTasks('sess_1', 'The agent process ended')
    const model = await store.load('sess_1')
    expect(model.backgroundTasks?.[0]).toMatchObject({
      status: 'stopped',
      detail: 'The agent process ended',
    })
  })
})
