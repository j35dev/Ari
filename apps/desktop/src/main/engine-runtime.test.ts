import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { SessionStore } from '@ari/engine/session-store'
import { DriverRegistry } from '@ari/providers/registry'
import type { AdapterSession } from '@ari/providers/driver'
import { Engine } from './engine'

it('runs concurrent sessions with distinct cwd and credentials without journaling secrets', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ari-runtime-'))
  const store = new SessionStore({ rootDir: join(dir, 'sessions') })
  const registry = new DriverRegistry()
  const seen: AdapterSession[] = []
  let finish!: () => void
  const finished = new Promise<void>((resolve) => { finish = resolve })
  let settled = 0
  registry.register({ kind: 'claude', create: async (session) => {
    seen.push(session)
    return { start: () => ({ async *[Symbol.asyncIterator]() { yield { type: 'done' as const } } }),
      interrupt: () => undefined, dispose: async () => undefined }
  } })
  const engine = new Engine({ store, registry,
    publish: (_id, event) => { if (event.type === 'turn.settled' && ++settled === 2) finish() },
    resolveWorkspace: async () => dir,
    runtimeEnvironment: async (session) => ({ ARI_CONTROL_TOKEN: `secret-${session.id}` }),
    git: { captureCheckpoint: async () => ({ ok: true, value: null }) },
  })
  try {
    for (const id of ['root', 'child']) {
      await store.append(id, { type: 'session.created', session: { id, projectId: 'p', title: id,
        driverKind: 'claude', modelId: null, permissionMode: 'ask', status: 'idle', createdAt: 1, updatedAt: 1,
        ...(id === 'child' ? { parentSessionId: 'root', rootSessionId: 'root', workspace: {
          kind: 'managed-worktree' as const, path: tmpdir(), branch: 'ari/child', baseRef: 'refs/ari/base', baseCommit: 'a'.repeat(40),
        } } : {}),
      } })
    }
    await Promise.all(['root', 'child'].map((sessionId) => engine.dispatch({ type: 'turn.start', sessionId, text: 'Hi', attachments: [] })))
    await finished
    expect(seen.find((s) => s.sessionId === 'root')?.workspacePath).toBe(dir)
    expect(seen.find((s) => s.sessionId === 'child')?.workspacePath).toBe(tmpdir())
    expect(new Set(seen.map((s) => s.runtimeEnv?.['ARI_CONTROL_TOKEN'])).size).toBe(2)
    for (const id of ['root', 'child']) expect(JSON.stringify(await engine.replaySession(id))).not.toContain('secret-')
  } finally {
    await store.closeJournal('root')
    await store.closeJournal('child')
    await rm(dir, { recursive: true, force: true, maxRetries: 3 })
  }
})
