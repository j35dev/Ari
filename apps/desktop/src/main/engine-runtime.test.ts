import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { SessionStore } from '@ari/engine/session-store'
import { controlCliApproval } from '@ari/engine/control-cli'
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

it('answers a permission request for a safe ari command itself and asks the user about the rest', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ari-grant-'))
  const store = new SessionStore({ rootDir: join(dir, 'sessions') })
  const registry = new DriverRegistry()
  const answered: { approvalId: string; decision: unknown }[] = []
  const options = [
    { optionId: 'once', name: 'Allow once', kind: 'allow_once' },
    { optionId: 'no', name: 'Deny', kind: 'reject_once' },
  ]
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  registry.register({
    kind: 'claude',
    create: async () => ({
      start: () => ({
        async *[Symbol.asyncIterator]() {
          for (const [approvalId, command] of [
            ['ari-1', 'ari session status --json'],
            ['rm-1', 'rm -rf build'],
          ] as const)
            yield {
              type: 'approval-requested' as const,
              approvalId,
              toolName: 'Bash',
              summaryJson: JSON.stringify({ command }),
              options,
            }
          await held
          yield { type: 'done' as const }
        },
      }),
      interrupt: () => undefined,
      dispose: async () => undefined,
      respondApproval: (approvalId, decision) => {
        answered.push({ approvalId, decision })
      },
    }),
  })
  const engine = new Engine({
    store,
    registry,
    publish: () => undefined,
    resolveWorkspace: async () => dir,
    runtimeEnvironment: async () => ({ ARI_ENV: '1' }),
    autoApprove: controlCliApproval,
    git: { captureCheckpoint: async () => ({ ok: true, value: null }) },
  })
  try {
    await store.append('s', {
      type: 'session.created',
      session: {
        id: 's',
        projectId: 'p',
        title: 's',
        driverKind: 'claude',
        modelId: null,
        permissionMode: 'ask',
        status: 'idle',
        createdAt: 1,
        updatedAt: 1,
      },
    })
    await engine.dispatch({ type: 'turn.start', sessionId: 's', text: 'Go', attachments: [] })
    await expect
      .poll(async () => (await store.load('s')).pendingApprovals.map((a) => a.approvalId))
      .toEqual(['rm-1'])
    expect(answered).toEqual([{ approvalId: 'ari-1', decision: { optionId: 'once' } }])
    release()
    await engine.quiesce('s')
  } finally {
    release()
    await store.closeJournal('s')
    await rm(dir, { recursive: true, force: true, maxRetries: 3 })
  }
})

it('puts the control note in the system channel when the driver has one, else in a fresh prompt', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ari-note-'))
  const store = new SessionStore({ rootDir: join(dir, 'sessions') })
  const registry = new DriverRegistry()
  const seen: AdapterSession[] = []
  const adapter = (session: AdapterSession) => {
    seen.push(session)
    return Promise.resolve({
      start: () => ({
        async *[Symbol.asyncIterator]() {
          yield { type: 'session-ref' as const, ref: `thread-${session.sessionId}` }
          yield { type: 'done' as const }
        },
      }),
      interrupt: () => undefined,
      dispose: async () => undefined,
    })
  }
  registry.register({ kind: 'claude', systemInstructions: true, create: adapter })
  registry.register({ kind: 'codex', create: adapter })
  const engine = new Engine({
    store,
    registry,
    publish: () => undefined,
    resolveWorkspace: async () => dir,
    runtimeEnvironment: async () => ({ ARI_ENV: '1' }),
    git: { captureCheckpoint: async () => ({ ok: true, value: null }) },
  })
  const turn = async (sessionId: string, text: string): Promise<AdapterSession> => {
    const before = seen.length
    await engine.dispatch({ type: 'turn.start', sessionId, text, attachments: [] })
    await engine.quiesce(sessionId)
    await expect.poll(async () => (await store.load(sessionId)).activeTurnId).toBeNull()
    return seen[before] as AdapterSession
  }
  try {
    for (const driverKind of ['claude', 'codex'] as const)
      await store.append(driverKind, {
        type: 'session.created',
        session: {
          id: driverKind,
          projectId: 'p',
          title: driverKind,
          driverKind,
          modelId: null,
          permissionMode: 'ask',
          status: 'idle',
          createdAt: 1,
          updatedAt: 1,
        },
      })

    // A system channel carries the note on every spawn and leaves the user's words alone.
    for (const text of ['First', 'Second']) {
      const session = await turn('claude', text)
      expect(session.prompt).toBe(text)
      expect(session.instructions).toMatch(/^You are running inside the Ari desktop app/)
    }
    expect(seen[1]?.resumeOf).toBe('thread-claude')

    // Without one it rides the first prompt only.
    const fresh = await turn('codex', 'First')
    expect(fresh.instructions).toBeUndefined()
    expect(fresh.prompt).toMatch(/^\[Ari control surface: .*\]\n\nFirst$/s)
    expect((await turn('codex', 'Second')).prompt).toBe('Second')
  } finally {
    await store.closeJournal('claude')
    await store.closeJournal('codex')
    await rm(dir, { recursive: true, force: true, maxRetries: 3 })
  }
})
