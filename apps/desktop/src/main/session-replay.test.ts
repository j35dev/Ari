// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join, resolve, relative, isAbsolute } from 'node:path'
import type { JournalEvent } from '@ari/contracts/events'
import type { SessionEventFrame, StreamFrame } from '@ari/contracts/rpc'
import { SessionStore } from '@ari/engine/session-store'
import { DriverRegistry } from '@ari/providers/registry'
import { Engine } from './engine'
import { RpcRegistry } from './rpc-registry'
import { streamSessionReplay } from './session-replay'

const event: JournalEvent = {
  seq: 1,
  at: 1,
  sessionId: 's',
  type: 'turn.started',
  turnId: 'old',
}

describe('session subscription replay terminal path', () => {
  it.each([false, true])(
    'reports a read failure (partial chunk: %s) and completes a later retry',
    async (partial) => {
      const store = new SessionStore({ rootDir: 'unused' })
      let fail = true
      // Exercise Engine.replaySessionChunks, including the read iterator throwing
      // after delivering a chunk. No substitute replay-outcome reducer is used.
      vi.spyOn(store, 'openJournal').mockImplementation(
        async () =>
          ({
            async *readByChunk() {
              if (!fail || partial) yield [{ kind: 'value', value: event }]
              if (fail) throw new Error('disk read failed')
            },
          }) as Awaited<ReturnType<SessionStore['openJournal']>>,
      )
      const engine = new Engine({ store, registry: new DriverRegistry(), publish: () => {} })
      const sent: StreamFrame[] = []
      const registry = new RpcRegistry({ send: (frame) => sent.push(frame) })
      registry.subscribe({ id: 'attempt', name: 'session.events', params: { sessionId: 's' } })
      const warn = vi.fn()
      const replay = () =>
        streamSessionReplay(
          's',
          (chunk) => engine.replaySessionChunks('s', chunk),
          (frame) => registry.sendTo('attempt', frame),
          warn,
        )

      await replay()
      expect(sent.map((frame) => frame.payload)).toEqual([
        ...(partial ? [{ sessionId: 's', replay: true, events: [event] }] : []),
        { sessionId: 's', replayDone: true, replayOutcome: 'incomplete' },
      ])
      expect(warn).toHaveBeenCalledOnce()
      // Completion remains a sentinel on both outcomes for older consumers.
      const terminal = sent.at(-1)?.payload as SessionEventFrame
      expect(terminal.replayDone).toBe(true)
      registry.publish('session.events', { sessionId: 's', event: { ...event, seq: 2 } })
      expect(sent.at(-1)?.payload).toHaveProperty('event.seq', 2)

      fail = false
      sent.length = 0
      await replay()
      expect(sent.map((frame) => frame.payload)).toEqual([
        { sessionId: 's', replay: true, events: [event] },
        { sessionId: 's', replayDone: true, replayOutcome: 'complete' },
      ])
    },
  )

  it('drops an old attempt terminal after unsubscribe while a new attempt is reading', async () => {
    const sent: StreamFrame[] = []
    const registry = new RpcRegistry({ send: (frame) => sent.push(frame) })
    registry.subscribe({ id: 'old', name: 'session.events', params: { sessionId: 's' } })
    let reject!: (error: Error) => void
    const old = streamSessionReplay(
      's',
      () =>
        new Promise<void>((_, r) => {
          reject = r
        }),
      (frame) => registry.sendTo('old', frame),
      () => {},
    )
    registry.unsubscribe('old')
    registry.subscribe({ id: 'new', name: 'session.events', params: { sessionId: 's' } })
    reject(new Error('late failure'))
    await old
    expect(sent).toEqual([])
  })

  it('reports runtime execution at the boundary instead of a journaled turn start', async () => {
    const store = new SessionStore({ rootDir: 'unused' })
    vi.spyOn(store, 'openJournal').mockResolvedValue({
      async *readByChunk() {
        yield [{ kind: 'value', value: event }]
      },
    } as Awaited<ReturnType<SessionStore['openJournal']>>)
    const engine = new Engine({ store, registry: new DriverRegistry(), publish: () => {} })
    const sent: SessionEventFrame[] = []
    await streamSessionReplay(
      's',
      (chunk) => engine.replaySessionChunks('s', chunk),
      (frame) => sent.push(frame),
      () => {},
      () => engine.liveTurnId('s'),
    )
    expect(sent.at(-1)).toEqual({
      sessionId: 's',
      replayDone: true,
      replayOutcome: 'complete',
      liveTurnId: null,
    })
  })

  it('reports owned startup and clears execution before provider disposal finishes', async () => {
    const root = await mkdtemp(join(process.cwd(), '.history-lifecycle-'))
    const target = relative(resolve(process.cwd()), resolve(root))
    if (target.startsWith('..') || isAbsolute(target))
      throw new Error('Scratch root escaped checkout')
    const store = new SessionStore({ rootDir: root })
    let start!: () => void
    let dispose!: () => void
    let disposing!: () => void
    const startGate = new Promise<void>((r) => {
      start = r
    })
    const disposeGate = new Promise<void>((r) => {
      dispose = r
    })
    const disposingGate = new Promise<void>((r) => {
      disposing = r
    })
    const registry = new DriverRegistry()
    registry.register({
      kind: 'claude',
      create: async () => {
        await startGate
        return {
          async *start() {
            yield { type: 'done' as const }
          },
          interrupt: () => {},
          dispose: async () => {
            disposing()
            await disposeGate
          },
        }
      },
    })
    const engine = new Engine({
      store,
      registry,
      publish: () => {},
      git: { captureCheckpoint: async () => ({ ok: true, value: null }) },
    })
    try {
      await store.append('s', {
        type: 'session.created',
        session: {
          id: 's',
          projectId: 'adhoc',
          title: 'Lifecycle',
          driverKind: 'claude',
          modelId: null,
          permissionMode: 'ask',
          status: 'idle',
          createdAt: 1,
          updatedAt: 1,
        },
      })
      await engine.dispatch({ type: 'turn.start', sessionId: 's', text: 'hello', attachments: [] })
      const turnId = (await store.load('s')).activeTurnId
      expect(turnId).not.toBeNull()
      expect(engine.liveTurnId('s')).toBe(turnId)
      start()
      await disposingGate
      expect(engine.hasLiveTurn('s')).toBe(true)
      expect(engine.liveTurnId('s')).toBeNull()
      const frames: SessionEventFrame[] = []
      await streamSessionReplay(
        's',
        (chunk) => engine.replaySessionChunks('s', chunk),
        (frame) => frames.push(frame),
        () => {},
        () => engine.liveTurnId('s'),
      )
      expect(frames.at(-1)).toMatchObject({ replayOutcome: 'complete', liveTurnId: null })
    } finally {
      start()
      dispose()
      await engine.quiesce('s')
      await store.closeJournal('s')
      await rm(root, { recursive: true, force: true, maxRetries: 3 })
    }
  })
})
