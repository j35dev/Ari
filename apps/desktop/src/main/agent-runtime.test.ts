// @vitest-environment node
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { delegationSettingsSchema } from '@ari/contracts/agent-control'
import type { Session } from '@ari/contracts/session'
import { SessionStore } from '@ari/engine/session-store'
import { DriverRegistry } from '@ari/providers/registry'
import type { AdapterSession } from '@ari/providers/driver'
import { Engine } from './engine'
import { startAgentRuntime } from './agent-runtime'

const execute = promisify(execFile)
const cliPath = resolve('resources/cli/ari.cjs')

it('runs the shipped CLI through scoped transport, a real isolated worker and exact integration', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ari-e2e-'))
  const repo = join(dir, 'repo space')
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
  const seen: AdapterSession[] = []
  registry.register({
    kind: 'claude',
    create: async (session) => {
      seen.push(session)
      return {
        start: () => ({
          async *[Symbol.asyncIterator]() {
            if (session.sessionId !== 'root')
              await writeFile(join(session.workspacePath, 'worker.txt'), 'worker output\n')
            yield { type: 'text-delta' as const, text: 'Finished worker task' }
            yield { type: 'done' as const }
          },
        }),
        interrupt: () => undefined,
        dispose: async () => undefined,
      }
    },
  })
  const engine = new Engine({
    store,
    registry,
    publish: () => undefined,
    resolveWorkspace: async () => repo,
    runtimeEnvironment: async (session) => runtime.environment(session),
    respondControlApproval: (id, decision) => runtime.approvals.respond(id, decision),
    git: { captureCheckpoint: async () => ({ ok: true, value: null }) },
  })
  const runtime = await startAgentRuntime({
    engine,
    store,
    userData: dir,
    cliPath,
    executable: process.execPath,
    version: 'test',
    policy: () => delegationSettingsSchema.parse({ approvalMode: 'never' }),
    providers: async () => [
      { driverKind: 'claude', available: true, models: [{ id: 'fixture', label: 'Fixture' }] },
    ],
  })
  const root: Session = {
    id: 'root',
    projectId: 'project',
    title: 'Root',
    driverKind: 'claude',
    modelId: null,
    permissionMode: 'ask',
    status: 'idle',
    createdAt: 1,
    updatedAt: 1,
  }
  await engine.createSession(root)
  const env = runtime.environment(root)
  const cli = async (...args: string[]): Promise<Record<string, unknown>> => {
    const { stdout } = await execute(process.execPath, [cliPath, ...args, '--json'], {
      env,
      windowsHide: true,
      timeout: 30_000,
    })
    return JSON.parse(stdout) as Record<string, unknown>
  }
  try {
    expect(await cli('env')).toMatchObject({ ok: true, result: { caller: { sessionId: 'root' } } })
    expect(await cli('agents')).toMatchObject({ ok: true, result: [{ driverKind: 'claude' }] })
    const args = [
      'session',
      'spawn',
      '--title',
      'Worker',
      '--agent',
      'claude',
      '--model',
      'fixture',
      '--prompt',
      'Implement',
      '--key',
      'task-one',
      '--wait',
    ]
    const spawned = (await cli(...args)) as { result: { child: Session } }
    const child = spawned.result.child
    const duplicate = (await cli(...args)) as { result: { child: Session } }
    expect(duplicate.result.child.id).toBe(child.id)
    await engine.quiesce(child.id)
    expect(seen.filter((s) => s.sessionId === child.id)).toHaveLength(1)
    expect(seen[0]?.workspacePath).not.toBe(repo)
    expect(seen[0]?.prompt).toContain('ari --skill')
    expect(runtime.environment(child).ARI_CONTROL_TOKEN).not.toBe(env.ARI_CONTROL_TOKEN)
    const transcript = (await cli('session', 'read', child.id)) as {
      result: { messages: { text: string }[] }
    }
    expect(transcript.result.messages.map((message) => message.text)).toContain(
      'Finished worker task',
    )
    await expect(readFile(join(repo, 'worker.txt'))).rejects.toThrow()
    const diff = (await cli('session', 'diff', child.id, '--patch')) as {
      result: { currentSnapshotCommit: string; patch: string }
    }
    expect(diff.result.patch).toContain('worker.txt')
    expect(
      await cli(
        'session',
        'integrate',
        child.id,
        '--snapshot',
        diff.result.currentSnapshotCommit,
        '--key',
        'apply',
      ),
    ).toMatchObject({ ok: true, result: { status: 'integrated' } })
    expect(await readFile(join(repo, 'worker.txt'), 'utf8')).toBe('worker output\n')
    expect(
      await cli(
        'session',
        'integrate',
        child.id,
        '--snapshot',
        diff.result.currentSnapshotCommit,
        '--key',
        'apply-again',
      ),
    ).toMatchObject({ ok: true, result: { status: 'already_integrated' } })
    const parentJournal = await engine.replaySession('root')
    expect(parentJournal.some((event) => event.type === 'child.session.spawned')).toBe(true)
    expect(parentJournal.some((event) => event.type === 'child.session.integrated')).toBe(true)
    expect(JSON.stringify(parentJournal)).not.toContain(env.ARI_CONTROL_TOKEN)
    const replay = new SessionStore({ rootDir: join(dir, 'sessions') })
    expect((await replay.load(child.id)).session?.workspace).toEqual(child.workspace)
    expect((await replay.load(child.id)).messages[0]?.origin).toEqual({
      kind: 'session',
      sessionId: 'root',
    })
  } finally {
    await runtime.close()
    for (const session of await store.listSessions()) {
      await engine.quiesce(session.id)
      await store.closeJournal(session.id)
    }
    await rm(dir, { recursive: true, force: true, maxRetries: 3 })
  }
}, 60_000)
