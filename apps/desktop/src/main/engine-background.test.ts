// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionStore } from '@ari/engine/session-store'
import { DriverRegistry } from '@ari/providers/registry'
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

describe('background output', () => {
  it('journals what an agent reports between turns as one agent message', async () => {
    const engine = new Engine({ store, registry: new DriverRegistry() })
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
})
