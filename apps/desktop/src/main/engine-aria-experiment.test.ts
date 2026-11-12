// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { SessionStore } from '@ari/engine/session-store'
import { DriverRegistry } from '@ari/providers/registry'
import type { Session } from '@ari/contracts/session'
import { Engine } from './engine'

it('disabling stops Aria cleanly, keeps its queued words, and leaves project work running', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ari-experiment-'))
  const store = new SessionStore({ rootDir: dir })
  const registry = new DriverRegistry()
  let enabled = true
  const finish = new Map<string, () => void>()
  const release = vi.fn<(id: string) => Promise<void>>(async () => undefined)
  registry.register({
    kind: 'codex',
    create: async (session) => {
      let resolve!: () => void
      const done = new Promise<void>((settled) => {
        resolve = settled
      })
      finish.set(session.sessionId, resolve)
      return {
        start: () => ({
          async *[Symbol.asyncIterator]() {
            yield { type: 'text-delta' as const, text: 'Saved history' }
            await done
            yield { type: 'done' as const }
          },
        }),
        interrupt: resolve,
        dispose: async () => undefined,
      }
    },
  })
  const engine = new Engine({
    store,
    registry,
    ariaEnabled: () => enabled,
    publish: () => undefined,
    releaseProviderConnection: release,
    git: { captureCheckpoint: async () => ({ ok: true, value: null }) },
  })
  try {
    for (const id of ['aria', 'project']) {
      const session: Session = {
        id,
        projectId: id === 'aria' ? 'helm' : 'project',
        title: id,
        driverKind: 'codex',
        modelId: 'model',
        permissionMode: 'full',
        status: 'idle',
        createdAt: 1,
        updatedAt: 1,
      }
      await engine.createSession(session)
      await engine.dispatch({
        type: 'turn.start',
        sessionId: id,
        text: 'First request',
        attachments: [],
      })
    }
    await expect.poll(() => finish.size).toBe(2)
    await engine.dispatch({
      type: 'message.enqueue',
      sessionId: 'aria',
      text: 'A complete\nmultiline follow-up',
      attachments: [],
    })
    enabled = false
    await engine.refreshAriaExperiment()
    const off = await store.load('aria')
    expect(off.activeTurnId).toBeNull()
    expect(off.lastTurn).toMatchObject({ stopReason: 'interrupted', errorMessage: null })
    expect(off.queuedMessages.map((message) => message.text)).toEqual([
      'A complete\nmultiline follow-up',
    ])
    expect(
      off.messages.some((message) => JSON.stringify(message.parts).includes('Saved history')),
    ).toBe(true)
    expect((await store.load('project')).activeTurnId).not.toBeNull()
    expect(release.mock.calls.every(([id]) => id === 'aria')).toBe(true)
    expect(
      await engine.dispatch({
        type: 'turn.start',
        sessionId: 'aria',
        text: 'No wake',
        attachments: [],
      }),
    ).toMatchObject({ accepted: false })
    expect((await store.load('aria')).lastTurn).toEqual(off.lastTurn)
    enabled = true
    await engine.refreshAriaExperiment()
    expect((await store.load('aria')).queuedMessages).toEqual(off.queuedMessages)
  } finally {
    for (const resolve of finish.values()) resolve()
    await engine.shutdown()
    for (const row of await store.listSessions()) await store.closeJournal(row.id)
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})
