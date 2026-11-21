// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { JournalEvent } from '@ari/contracts/events'
import { DriverRegistry } from '@ari/providers/registry'
import { SessionStore } from '@ari/engine/session-store'
import { Engine, type EngineDeps } from './engine'

describe('provider update turn gate', () => {
  it('refuses a registered provider while updating and allows retry after it settles', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ari-provider-update-gate-'))
    const store = new SessionStore({ rootDir: directory })
    const registry = new DriverRegistry()
    const create = vi.fn(async () => ({
      start: () =>
        (async function* () {
          yield { type: 'text-delta' as const, text: 'after update' }
          yield { type: 'done' as const }
        })(),
      interrupt: () => undefined,
      dispose: async () => undefined,
    }))
    registry.register({ kind: 'claude', create })
    const published: JournalEvent[] = []
    const unavailable = vi
      .fn<NonNullable<EngineDeps['driverUnavailable']>>()
      .mockResolvedValue('This provider is updating. Try again shortly.')
    const engine = new Engine({
      store,
      registry,
      publish: (_id, event) => published.push(event),
      driverUnavailable: unavailable,
      git: { captureCheckpoint: async () => ({ ok: true, value: null }) },
    })
    try {
      await store.append('updating', {
        type: 'session.created',
        session: {
          id: 'updating',
          projectId: 'project',
          title: 'Update gate',
          driverKind: 'claude',
          modelId: null,
          permissionMode: 'ask',
          status: 'idle',
          createdAt: 1,
          updatedAt: 1,
        },
      })
      await engine.dispatch({
        type: 'turn.start',
        sessionId: 'updating',
        text: 'work',
        attachments: [],
      })
      await engine.quiesce('updating')
      expect(unavailable).toHaveBeenCalledWith('claude')
      expect(create).not.toHaveBeenCalled()
      expect(JSON.stringify(published)).toContain('This provider is updating. Try again shortly.')
      unavailable.mockResolvedValue(null)
      await engine.dispatch({
        type: 'turn.start',
        sessionId: 'updating',
        text: 'retry',
        attachments: [],
      })
      await engine.quiesce('updating')
      expect(create).toHaveBeenCalledOnce()
      expect(JSON.stringify(published)).toContain('after update')
    } finally {
      await engine.shutdown()
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    }
  })
})
