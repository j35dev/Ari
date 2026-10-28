// @vitest-environment node
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { delegationSettingsSchema } from '@ari/contracts/agent-control'
import type { Session } from '@ari/contracts/session'
import { SessionStore } from '@ari/engine/session-store'
import { DriverRegistry } from '@ari/providers/registry'
import type { AdapterSession } from '@ari/providers/driver'
import { Engine } from './engine'
import { controlEndpoint, SOCKET_ROOT, startAgentRuntime } from './agent-runtime'
import { ResumeSchedule, routineHost } from './resume-schedule'
import { BotMemoryStore } from '@ari/engine/bot-memory'

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
    await rm(dirname(endpoint), { recursive: true, force: true })
  })

  // `controlEndpoint` is exercised above with a caller-supplied root, so this
  // pins the root production actually passes. Pointing it back at userData is
  // the exact regression that produced the reporter's EINVAL.
  it('binds under a shipped root short enough for the macOS budget', () => {
    const endpoint = join(SOCKET_ROOT, 'ari-XXXXXX', `${randomUUID()}.sock`)
    expect(Buffer.byteLength(endpoint)).toBeLessThan(MACOS_SUN_PATH_BYTES)
  })
})

// `close` only exists on the object a successful start returns, so a startup
// that rejected after creating the directory had nothing left to remove it —
// one directory per attempt, for a failure that repeats on every launch.
it('removes the socket directory when startup fails after creating it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ari-startup-fail-'))
  // A private socket root: the shared one is also written by every other Ari
  // process and test run on the machine, so a snapshot of it is never stable.
  const socketRoot = await mkdtemp(join(tmpdir(), 'ari-socket-root-'))
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
  // The cleanup wraps the assertion so a startup that resolves — the regression
  // this guards — still removes both temp roots before the failure surfaces.
  try {
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
        socketRoot,
      }),
    ).rejects.toThrow()
    expect(await readdir(socketRoot)).toEqual([])
  } finally {
    await rm(socketRoot, { recursive: true, force: true })
    await rm(dir, { recursive: true, force: true })
  }
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
  const schedule = new ResumeSchedule({
    path: join(dir, 'routines.json'),
    store,
    dispatch: (command) => engine.dispatch(command),
  })
  await schedule.load()
  schedule.start()
  const botMemory = new BotMemoryStore({ dir: join(dir, 'bots') })
  const runtime = await startAgentRuntime({
    engine,
    store,
    userData: dir,
    cliPath,
    executable: process.execPath,
    version: 'test',
    policy: () => delegationSettingsSchema.parse({ approvalMode: 'never' }),
    routines: routineHost(schedule),
    memory: {
      read: (botId) => botMemory.read(botId),
      add: (botId, text) => botMemory.add(botId, text),
      patch: (botId, find, text) => botMemory.patch(botId, find, text),
      remove: (botId, find) => botMemory.remove(botId, find),
    },
    providers: async () => [
      { driverKind: 'claude', available: true, models: [{ id: 'fixture', label: 'Fixture' }] },
    ],
  })
  const root: Session = {
    id: 'root',
    projectId: 'project',
    botId: 'bot_a',
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
    const scheduled = (await cli(
      'routine',
      'add',
      '--prompt',
      'Check CI.',
      '--in',
      '30',
      '--every',
      '60',
      '--key',
      'routine-1',
    )) as { result: { id: string; everyMs: number; at: number } }
    expect(scheduled.result.everyMs).toBe(3_600_000)
    expect(scheduled.result.at).toBeGreaterThan(Date.now())
    expect(await cli('routine', 'list')).toMatchObject({
      ok: true,
      result: { routines: [{ id: scheduled.result.id, prompt: 'Check CI.', sessionId: 'root' }] },
    })
    expect(await cli('routine', 'rm', scheduled.result.id, '--key', 'routine-rm')).toMatchObject({
      ok: true,
      result: { removed: true },
    })
    expect(await cli('routine', 'list')).toMatchObject({ ok: true, result: { routines: [] } })
    expect(await cli('memory', 'add', 'Prefer small commits.', '--key', 'm1')).toMatchObject({
      ok: true,
      result: { memory: 'Prefer small commits.\n' },
    })
    expect(await cli('memory', 'list')).toMatchObject({
      ok: true,
      result: { memory: 'Prefer small commits.\n' },
    })
    expect(
      await cli(
        'memory',
        'patch',
        '--find',
        'small commits',
        '--text',
        'one commit per task',
        '--key',
        'm2',
      ),
    ).toMatchObject({ ok: true, result: { memory: 'Prefer one commit per task.\n' } })
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
    expect(seen[0]?.prompt).toContain('not written by the user')
    expect(seen[0]?.prompt).toContain('`ari --skill`')
    expect(runtime.environment(child).ARI_CONTROL_TOKEN).not.toBe(env.ARI_CONTROL_TOKEN)
    const transcript = (await cli('session', 'read', child.id)) as {
      result: { messages: { text: string }[] }
    }
    expect(transcript.result.messages.map((message) => message.text)).toContain(
      'Finished worker task',
    )
    expect(await cli('session', 'status')).toMatchObject({
      ok: true,
      result: {
        summary: { total: 1, resultAvailable: 1 },
        tasks: [{ sessionId: child.id, report: 'Finished worker task' }],
      },
    })
    if (process.platform === 'win32')
      expect(await readFile(join(dir, 'agent-control', 'bin', 'ari'), 'utf8')).toContain(
        'ELECTRON_RUN_AS_NODE=1 exec',
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
    schedule.close()
    await runtime.close()
    for (const session of await store.listSessions()) {
      await engine.quiesce(session.id)
      await store.closeJournal(session.id)
    }
    await rm(dir, { recursive: true, force: true, maxRetries: 3 })
  }
}, 60_000)

it('wakes an idle parent with its child report and stops children with their parent', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ari-deliver-'))
  const store = new SessionStore({ rootDir: join(dir, 'sessions') })
  const registry = new DriverRegistry()
  const seen: AdapterSession[] = []
  const held = new Map<string, () => void>()
  registry.register({
    kind: 'claude',
    create: async (session) => {
      seen.push(session)
      return {
        start: () => ({
          async *[Symbol.asyncIterator]() {
            if (session.sessionId !== 'root' || session.prompt.includes('hold'))
              await new Promise<void>((resolve) => held.set(session.sessionId, resolve))
            yield {
              type: 'text-delta' as const,
              text: session.sessionId === 'root' ? 'ok' : 'Parser fixed and tested.',
            }
            yield { type: 'done' as const }
          },
        }),
        interrupt: () => held.get(session.sessionId)?.(),
        dispose: async () => undefined,
      }
    },
  })
  const engine = new Engine({
    store,
    registry,
    publish: () => undefined,
    resolveWorkspace: async () => dir,
    runtimeEnvironment: async (session) => runtime.environment(session),
    git: { captureCheckpoint: async () => ({ ok: true, value: null }) },
  })
  const runtime = await startAgentRuntime({
    engine,
    store,
    userData: dir,
    cliPath,
    executable: process.execPath,
    version: 'test',
    deliveryDelayMs: 10,
    policy: () =>
      delegationSettingsSchema.parse({
        approvalMode: 'never',
        allowSharedWorkspace: true,
        defaultWorkspaceMode: 'shared',
      }),
    providers: async () => [{ driverKind: 'claude', available: true, models: [] }],
  })
  const rootTurns = () => seen.filter((session) => session.sessionId === 'root')
  try {
    await engine.createSession({
      id: 'root',
      projectId: 'project',
      title: 'Root',
      driverKind: 'claude',
      modelId: null,
      permissionMode: 'ask',
      status: 'idle',
      createdAt: 1,
      updatedAt: 1,
    })
    await engine.dispatch({ type: 'turn.start', sessionId: 'root', text: 'Plan', attachments: [] })
    await expect.poll(async () => (await store.load('root')).lastTurn?.stopReason).toBe('completed')
    const spawned = await runtime.service.invoke('root', 'session.spawn', {
      title: 'Worker',
      role: 'implementation',
      driverKind: 'claude',
      prompt: 'Fix the parser',
      idempotencyKey: 'worker',
    })
    const child = (spawned as { result: { child: Session } }).result.child
    await expect.poll(() => held.has(child.id)).toBe(true)
    expect(seen.find((session) => session.sessionId === child.id)?.prompt).toContain(
      'working for the session "Root" as its implementation agent',
    )
    held.get(child.id)?.()
    await expect.poll(() => rootTurns().length, { timeout: 10_000 }).toBe(2)
    expect(rootTurns()[1]?.prompt).toContain('[Ari delegation update')
    expect(rootTurns()[1]?.prompt).toContain('Report:\nParser fixed and tested.')
    await expect
      .poll(async () => (await store.load('root')).childCompletions?.[child.id]?.acknowledged)
      .toBe(true)
    await expect.poll(async () => (await store.load('root')).activeTurnId).toBeNull()

    held.clear()
    await runtime.service.invoke('root', 'session.prompt', {
      targetSessionId: child.id,
      text: 'One more pass',
      idempotencyKey: 'again',
    })
    await engine.dispatch({ type: 'turn.start', sessionId: 'root', text: 'hold', attachments: [] })
    await expect.poll(() => held.has('root') && held.has(child.id)).toBe(true)
    await engine.dispatch({ type: 'turn.interrupt', sessionId: 'root' })
    await expect
      .poll(async () => (await store.load(child.id)).lastTurn?.stopReason, { timeout: 10_000 })
      .toBe('interrupted')
    await runtime.supervisor.evaluate('root')
    expect(rootTurns()).toHaveLength(3)
  } finally {
    await runtime.close()
    for (const session of await store.listSessions()) {
      await engine.quiesce(session.id)
      await store.closeJournal(session.id)
    }
    await rm(dir, { recursive: true, force: true, maxRetries: 3 })
  }
}, 60_000)

it('drops a session through onDrop when it is destroyed or archived', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ari-drop-'))
  const store = new SessionStore({ rootDir: join(dir, 'sessions') })
  const registry = new DriverRegistry()
  registry.register({
    kind: 'claude',
    create: async () => ({
      start: () => ({
        async *[Symbol.asyncIterator]() {
          yield { type: 'done' as const }
        },
      }),
      interrupt: () => undefined,
      dispose: async () => undefined,
    }),
  })
  const engine = new Engine({
    store,
    registry,
    publish: () => undefined,
    resolveWorkspace: async () => dir,
    git: { captureCheckpoint: async () => ({ ok: true, value: null }) },
  })
  const dropped: string[] = []
  const runtime = await startAgentRuntime({
    engine,
    store,
    userData: dir,
    cliPath,
    executable: process.execPath,
    version: 'test',
    policy: () =>
      delegationSettingsSchema.parse({
        approvalMode: 'never',
        allowSharedWorkspace: true,
        defaultWorkspaceMode: 'shared',
      }),
    providers: async () => [{ driverKind: 'claude', available: true, models: [] }],
    onDrop: (id) => dropped.push(id),
  })
  try {
    await engine.createSession({
      id: 'root',
      projectId: 'project',
      title: 'Root',
      driverKind: 'claude',
      modelId: null,
      permissionMode: 'ask',
      status: 'idle',
      createdAt: 1,
      updatedAt: 1,
    })
    const spawned = await runtime.service.invoke('root', 'session.spawn', {
      title: 'Worker',
      role: 'implementation',
      driverKind: 'claude',
      idempotencyKey: 'worker',
    })
    const child = (spawned as { result: { child: Session } }).result.child
    await runtime.service.invoke('root', 'session.destroy', {
      targetSessionId: child.id,
      idempotencyKey: 'destroy',
    })
    expect(dropped).toContain(child.id)

    // A remote archive reaches the engine directly, without the desktop RPC.
    await engine.dispatch({ type: 'session.update', sessionId: 'root', archived: true })
    expect(dropped).toContain('root')
  } finally {
    await runtime.close()
    for (const session of await store.listSessions()) {
      await engine.quiesce(session.id)
      await store.closeJournal(session.id)
    }
    await rm(dir, { recursive: true, force: true, maxRetries: 3 })
  }
}, 60_000)
