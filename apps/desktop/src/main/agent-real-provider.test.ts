// @vitest-environment node
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { delegationSettingsSchema } from '@ari/contracts/agent-control'
import type { Session } from '@ari/contracts/session'
import { SessionStore } from '@ari/engine/session-store'
import { DriverRegistry } from '@ari/providers/registry'
import { ClaudeDriver } from '@ari/providers/claude'
import { Engine } from './engine'
import { startAgentRuntime } from './agent-runtime'

/** Explicitly opt-in: uses the installed provider/account only in a disposable repository. */
it.skipIf(!process.env.ARI_REAL_PROVIDER_SMOKE)(
  'real Claude worker discovers Ari, edits in isolation and reports its scoped identity',
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ari-real-smoke-'))
    const repo = join(dir, 'repo')
    await mkdir(repo)
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: repo, windowsHide: true, encoding: 'utf8' }).trim()
    git('init', '-q')
    git('config', 'user.name', 'Test')
    git('config', 'user.email', 'test@example.com')
    git('config', 'core.autocrlf', 'false')
    await writeFile(join(repo, 'base.txt'), 'base\n')
    git('add', '.')
    git('commit', '-qm', 'base')
    const store = new SessionStore({ rootDir: join(dir, 'sessions') })
    const registry = new DriverRegistry()
    registry.register(new ClaudeDriver(process.env.ARI_REAL_PROVIDER_SMOKE!))
    const engine = new Engine({
      store,
      registry,
      publish: () => undefined,
      resolveWorkspace: async () => repo,
      runtimeEnvironment: async (session) => runtime.environment(session),
      git: { captureCheckpoint: async () => ({ ok: true, value: null }) },
    })
    const runtime = await startAgentRuntime({
      engine,
      store,
      userData: dir,
      cliPath: resolve('resources/cli/ari.cjs'),
      executable: process.execPath,
      version: 'smoke',
      policy: () => delegationSettingsSchema.parse({ approvalMode: 'never' }),
      providers: async () => [{ driverKind: 'claude', available: true, models: [] }],
    })
    const root: Session = {
      id: 'root',
      projectId: 'project',
      title: 'Smoke',
      driverKind: 'claude',
      modelId: null,
      permissionMode: 'full',
      status: 'idle',
      createdAt: 1,
      updatedAt: 1,
    }
    await engine.createSession(root)
    try {
      const spawned = await runtime.service.invoke('root', 'session.spawn', {
        title: 'Smoke worker',
        driverKind: 'claude',
        idempotencyKey: 'smoke',
        prompt:
          'This is a bounded Ari integration smoke test in a disposable repository. Do not delegate or message the parent. Read ari --skill, run ari env --json, then create smoke.txt containing only the caller sessionId from that JSON (newline allowed). Do not print credentials or inspect any unrelated files. Finish immediately with a short confirmation.',
      })
      expect(spawned.ok).toBe(true)
      const child = (spawned as { ok: true; result: { child: Session } }).result.child
      const result = await runtime.service.invoke('root', 'session.wait', {
        targetSessionIds: [child.id],
        timeoutMs: 120_000,
      })
      expect(result).toMatchObject({ ok: true, result: [{ stopReason: 'completed' }] })
      await engine.quiesce(child.id)
      const workspace = await engine.workspace(child)
      expect((await readFile(join(workspace!, 'smoke.txt'), 'utf8')).trim()).toBe(child.id)
      await expect(readFile(join(repo, 'smoke.txt'))).rejects.toThrow()
      const diff = (await runtime.service.invoke('root', 'session.diff', {
        targetSessionId: child.id,
      })) as { ok: true; result: { currentSnapshotCommit: string } }
      expect(
        await runtime.service.invoke('root', 'session.integrate', {
          targetSessionId: child.id,
          snapshotCommit: diff.result.currentSnapshotCommit,
          idempotencyKey: 'integrate',
        }),
      ).toMatchObject({ ok: true, result: { status: 'integrated' } })
      expect((await readFile(join(repo, 'smoke.txt'), 'utf8')).trim()).toBe(child.id)
    } finally {
      for (const session of await store.listSessions()) {
        if ((await store.load(session.id)).activeTurnId)
          await engine.dispatch({ type: 'turn.interrupt', sessionId: session.id })
        await engine.quiesce(session.id)
        await store.closeJournal(session.id)
      }
      await runtime.close()
      await rm(dir, { recursive: true, force: true, maxRetries: 3 })
    }
  },
  150_000,
)
