// @vitest-environment node
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { delegationSettingsSchema } from '@ari/contracts/agent-control'
import type { Session } from '@ari/contracts/session'
import { SessionStore } from '@ari/engine/session-store'
import { DriverRegistry } from '@ari/providers/registry'
import type { AdapterSession } from '@ari/providers/driver'
import { Engine } from './engine'
import { controlEndpoint, SOCKET_ROOT, startAgentRuntime } from './agent-runtime'

const execute = promisify(execFile)
const cliPath = resolve('resources/cli/ari.cjs')

/** `sockaddr_un.sun_path` is char[104] on macOS, NUL terminator included. */
const MACOS_SUN_PATH_BYTES = 104

describe('control endpoint', () => {
  // The reporter's path: Electron userData plus the runtime directory.
  const macUserData = '/Users/jdholst/Library/Application Support/@ari/desktop/agent-control'

  it('overflows sun_path when bound under macOS userData', () => {
    expect(Buffer.byteLength(join(macUserData, `${randomUUID()}.sock`))).toBeGreaterThanOrEqual(
      MACOS_SUN_PATH_BYTES,
    )
  })

  it('stays within it when bound in a short root', async () => {
    const { endpoint } = await controlEndpoint('darwin', tmpdir())
    expect(Buffer.byteLength(endpoint)).toBeLessThan(MACOS_SUN_PATH_BYTES)
  })

  // `controlEndpoint` is exercised above with a caller-supplied root, so this
  // pins the root production actually passes. Pointing it back at userData is
  // the exact regression that produced the reporter's EINVAL.
  it('binds under a shipped root short enough for the macOS budget', () => {
    const endpoint = join(SOCKET_ROOT, 'ari-XXXXXX', `${randomUUID()}.sock`)
    expect(Buffer.byteLength(endpoint)).toBeLessThan(MACOS_SUN_PATH_BYTES)
  })
})

/** Socket directories the runtime owns under the shipped root. */
async function socketDirs(): Promise<string[]> {
  return (await readdir(SOCKET_ROOT)).filter((name) => name.startsWith('ari-')).sort()
}

// `close` only exists on the object a successful start returns, so a startup
// that rejected after creating the directory had nothing left to remove it —
// one directory per attempt, for a failure that repeats on every launch.
it('removes the socket directory when startup fails after creating it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ari-startup-fail-'))
  const bin = join(dir, 'agent-control', 'bin')
  await mkdir(bin, { recursive: true })
  // A directory where the launcher file belongs, so the write — which runs
  // after the socket directory exists — is the step that rejects.
  await mkdir(join(bin, process.platform === 'win32' ? 'ari.cmd' : 'ari'))
  const store = new SessionStore({ rootDir: join(dir, 'sessions') })
  const engine = new Engine({
    store,
    registry: new DriverRegistry(),
    publish: () => undefined,
    resolveWorkspace: async () => dir,
    git: { captureCheckpoint: async () => ({ ok: true, value: null }) },
  })
  const before = await socketDirs()
  await expect(
    startAgentRuntime({
      engine,
      store,
      userData: dir,
      cliPath,
      executable: process.execPath,
      version: 'test',
      policy: () => delegationSettingsSchema.parse({ approvalMode: 'never' }),
      providers: async () => [],
    }),
  ).rejects.toThrow()
  expect(await socketDirs()).toEqual(before)
  await rm(dir, { recursive: true, force: true })
})

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
    expect((await store.load(child.id)).messages[0]?.origin).toEqual({
      kind: 'session',
      sessionId: 'root',
    })
    expect(await cli('session', 'destroy', child.id, '--key', 'done')).toMatchObject({
      ok: true,
      result: { destroyed: true },
    })
    expect((await store.listSessions()).map((session) => session.id)).toEqual(['root'])
    const replay = new SessionStore({ rootDir: join(dir, 'sessions') })
    expect((await replay.load(child.id)).session).toBeNull()
  } finally {
    await runtime.close()
    for (const session of await store.listSessions()) {
      await engine.quiesce(session.id)
      await store.closeJournal(session.id)
    }
    await rm(dir, { recursive: true, force: true, maxRetries: 3 })
  }
}, 60_000)
