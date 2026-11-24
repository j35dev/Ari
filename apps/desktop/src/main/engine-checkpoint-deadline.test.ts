// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SessionStore } from '@ari/engine/session-store'
import { DriverRegistry } from '@ari/providers/registry'
import { Engine, type CheckpointCapturer } from './engine'

let dir: string
let store: SessionStore

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ari-checkpoint-deadline-'))
  store = new SessionStore({ storage: 'jsonl', rootDir: join(dir, '.journals') })
  await store.append('sess_1', {
    type: 'session.created',
    session: {
      id: 'sess_1',
      projectId: dir,
      title: 'Stalled git',
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
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

it('never starts a stalled snapshot when processing follow-up turns', async () => {
  // A git child whose pipes never close leaves both captures pending forever.
  const stalled: CheckpointCapturer = {
    captureCheckpoint: vi.fn(() => new Promise<never>(() => undefined)),
    captureTurnEnd: vi.fn(() => new Promise<never>(() => undefined)),
  }
  let started = 0
  const registry = new DriverRegistry()
  registry.register({
    kind: 'claude',
    create: async () => ({
      start: async function* () {
        started += 1
        yield { type: 'done' as const }
      },
      dispose: async () => undefined,
      interrupt: () => undefined,
    }),
  })
  const engine = new Engine({
    store,
    registry,
    git: stalled,
    checkpointTimeoutMs: 20,
    publish: () => undefined,
  })
  for (const text of ['first', 'second']) {
    const receipt = await engine.dispatch({
      type: 'turn.start',
      sessionId: 'sess_1',
      text,
      attachments: [],
    })
    expect(receipt.accepted).toBe(true)
    await engine.quiesce('sess_1')
  }
  expect(started).toBe(2)
  expect(stalled.captureCheckpoint).not.toHaveBeenCalled()
  expect(stalled.captureTurnEnd).not.toHaveBeenCalled()
  const model = await store.load('sess_1')
  expect(model.activeTurnId).toBeNull()
  expect(model.checkpoints).toEqual([])
})
