// @vitest-environment node
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { delegationSettingsSchema } from '@ari/contracts/agent-control'
import type { Session } from '@ari/contracts/session'
import type { OrchestrationView, ResultPackage } from '@ari/contracts/orchestration'
import type { StreamFrame } from '@ari/contracts/rpc'
import { SessionStore } from '@ari/engine/session-store'
import { ManagedWorkspaces } from '@ari/engine/git'
import { DriverRegistry } from '@ari/providers/registry'
import type { AdapterSession } from '@ari/providers/driver'
import { Engine } from './engine'
import {
  controlEndpoint,
  SOCKET_ROOT,
  startAgentRuntime,
  dropSessionResources,
  revokeArchivedSessions,
  closeControlTransport,
} from './agent-runtime'
import { ResumeSchedule, routineHost } from './resume-schedule'
import { RpcRegistry } from './rpc-registry'
import { registerOrchestrationRpc } from './orchestration-runtime'

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
  const runtime = await startAgentRuntime({
    engine,
    store,
    userData: dir,
    cliPath,
    executable: process.execPath,
    version: 'test',
    policy: () => delegationSettingsSchema.parse({ approvalMode: 'never' }),
    routines: routineHost(schedule),
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
    const work = (await cli('task', 'view')) as { result: OrchestrationView }
    const task = work.result.tasks.find((entry) => entry.child?.sessionId === child.id)!
    const result = task.results.find((entry) => entry.resultId === task.currentResultId)!
    expect(result.reviewState).toBe('integrated')
    const checked = (await cli(
      'task',
      'verify',
      '--params',
      JSON.stringify({
        taskId: task.taskId,
        resultId: result.resultId,
        snapshotCommit: result.snapshotCommit,
      }),
      '--key',
      'independent-check',
    )) as { result: ResultPackage }
    expect(checked.result.verifiedChecks).toMatchObject([
      { exitCode: 0, snapshotCommit: result.snapshotCommit },
    ])
    expect(checked.result.verifiedChecks[0]?.command).toContain('git diff --check')
    expect(checked.result.workerReportedChecks).toEqual([])
    const frames: StreamFrame[] = []
    const rpc = new RpcRegistry({ send: (frame) => frames.push(frame) })
    const stopRpcRefresh = registerOrchestrationRpc(rpc, Promise.resolve(runtime))
    expect(await rpc.invoke('orchestration.view', { sessionId: 'root' })).toMatchObject({
      sessionId: 'root',
    })
    await expect(rpc.invoke('orchestration.stop', { sessionId: 'root' })).rejects.toThrow(
      'invalid params',
    )
    rpc.subscribe({ id: 'work-root', name: 'orchestration.changed', params: { sessionId: 'root' } })
    rpc.subscribe({
      id: 'work-unrelated',
      name: 'orchestration.changed',
      params: { sessionId: 'unrelated' },
    })
    await engine.record(child.id, {
      type: 'usage.recorded',
      inputTokens: 1,
      outputTokens: 1,
      costUsd: null,
    })
    await vi.waitFor(() => expect(frames.some((frame) => frame.id === 'work-root')).toBe(true))
    expect(frames.some((frame) => frame.id === 'work-unrelated')).toBe(false)
    const rpcRoutine = (await rpc.invoke('orchestration.routine.add', {
      sessionId: 'root',
      prompt: 'Follow up',
      at: Date.now() + 3_600_000,
      everyMs: 300_000,
      idempotencyKey: 'rpc-routine',
    })) as { id: string }
    expect(await rpc.invoke('orchestration.routine.list', { sessionId: 'root' })).toMatchObject({
      routines: [{ id: rpcRoutine.id, prompt: 'Follow up' }],
    })
    expect(
      await rpc.invoke('orchestration.routine.remove', {
        sessionId: 'root',
        routineId: rpcRoutine.id,
        idempotencyKey: 'rpc-routine-remove',
      }),
    ).toEqual({ removed: true })
    stopRpcRefresh()
    const context = (await cli(
      'task',
      'context',
      '--params',
      JSON.stringify({ files: ['worker.txt'], maxChars: 6 }),
      '--key',
      'bounded-context',
    )) as { result: { items: { content: string; truncated: boolean }[] } }
    expect(context.result.items).toMatchObject([{ content: 'worker', truncated: true }])
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

it('revokes archive access, releases parked agents, and keeps workspace handles until destruction', async () => {
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
  const revoked: string[] = []
  const parked: string[] = []
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
    onDrop: (id, reason) => {
      revoked.push(id)
      return dropSessionResources(
        id,
        reason,
        async (id) => {
          parked.push(id)
        },
        async (id) => {
          dropped.push(id)
        },
      )
    },
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
    await vi.waitFor(() => expect(revoked).toContain('root'))
    expect(dropped).not.toContain('root')
    expect(parked).toContain('root')
    const release = vi
      .spyOn(ManagedWorkspaces.prototype, 'release')
      .mockResolvedValueOnce(undefined)
    await runtime.release('root')
    expect(dropped).toContain('root')
    expect(release).toHaveBeenCalledWith('root')
    release.mockRestore()
  } finally {
    await runtime.close()
    for (const session of await store.listSessions()) {
      await engine.quiesce(session.id)
      await store.closeJournal(session.id)
    }
    await rm(dir, { recursive: true, force: true, maxRetries: 3 })
  }
}, 60_000)

it('makes control ready while the orphan sweep runs and releases even if resource cleanup fails', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ari-background-sweep-'))
  const store = new SessionStore({ rootDir: join(dir, 'sessions') })
  const engine = new Engine({ store, registry: new DriverRegistry(), publish: () => undefined })
  let finish!: () => void
  const gate = new Promise<void>((resolve) => {
    finish = resolve
  })
  let sweepSignal: AbortSignal | undefined
  const sweep = vi
    .spyOn(ManagedWorkspaces.prototype, 'sweepOrphans')
    .mockImplementationOnce((_exists, _repos, signal) => {
      sweepSignal = signal
      return gate
    })
  const release = vi.spyOn(ManagedWorkspaces.prototype, 'release').mockResolvedValueOnce(undefined)
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  let ready = false
  const starting = startAgentRuntime({
    engine,
    store,
    userData: dir,
    cliPath,
    executable: process.execPath,
    version: 'test',
    policy: () => delegationSettingsSchema.parse({ approvalMode: 'never' }),
    providers: async () => [],
    onDrop: async () => {
      throw new Error('resource cleanup failed')
    },
  }).then((runtime) => {
    ready = true
    return runtime
  })
  try {
    await vi.waitFor(() => expect(sweep).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(ready).toBe(true))
    const runtime = await starting
    await runtime.release('removed-session')
    expect(release).toHaveBeenCalledWith('removed-session')
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('session cleanup failed'),
      expect.objectContaining({
        sessionId: 'removed-session',
        error: 'Error: resource cleanup failed',
      }),
    )
    let closed = false
    const closing = runtime.close().then(() => {
      closed = true
    })
    await closing
    expect(closed).toBe(true)
    expect(sweepSignal?.aborted).toBe(true)
    finish()
  } finally {
    finish()
    await (await starting).close()
    sweep.mockRestore()
    release.mockRestore()
    warn.mockRestore()
    await rm(dir, { recursive: true, force: true, maxRetries: 3 })
  }
})

it('closes without waiting for a stuck retry and starts no cleanup after cancellation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ari-cancel-retry-'))
  const store = new SessionStore({ rootDir: join(dir, 'sessions') })
  const engine = new Engine({ store, registry: new DriverRegistry(), publish: () => undefined })
  let finish!: () => void
  const gate = new Promise<void>((resolve) => {
    finish = resolve
  })
  let retrySignal: AbortSignal | undefined
  const retry = vi
    .spyOn(ManagedWorkspaces.prototype, 'retryReleases')
    .mockImplementationOnce(async (_drop, signal) => {
      retrySignal = signal
      await gate
    })
  const projects = vi.fn(async () => [])
  const runtime = await startAgentRuntime({
    engine,
    store,
    userData: dir,
    cliPath,
    executable: process.execPath,
    version: 'test',
    policy: () => delegationSettingsSchema.parse({ approvalMode: 'never' }),
    providers: async () => [],
    projects,
  })
  try {
    await vi.waitFor(() => expect(retry).toHaveBeenCalledOnce())
    await runtime.close()
    expect(retrySignal?.aborted).toBe(true)
    finish()
    await gate
    await Promise.resolve()
    expect(projects).not.toHaveBeenCalled()
  } finally {
    finish()
    await runtime.close()
    retry.mockRestore()
    await rm(dir, { recursive: true, force: true, maxRetries: 3 })
  }
})

it('closes the server and removes the socket directory before aborting cleanup', async () => {
  const socketDir = await mkdtemp(join(tmpdir(), 'ari-close-socket-'))
  await writeFile(join(socketDir, 'socket'), 'fixture')
  const events: string[] = []
  try {
    await closeControlTransport(
      async () => {
        events.push('server closed')
      },
      socketDir,
      () => {
        expect(existsSync(socketDir)).toBe(false)
        events.push('cleanup aborted')
      },
    )
    expect(events).toEqual(['server closed', 'cleanup aborted'])
  } finally {
    await rm(socketDir, { recursive: true, force: true })
  }
})

it('continues revoking archived sessions when one parked process fails to release', async () => {
  const firstError = new Error('parked cleanup failed')
  const revoke = vi.fn(async (id: string) => {
    if (id === 'first') throw firstError
    if (id === 'child') throw new Error('child cleanup failed')
  })
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  try {
    await expect(revokeArchivedSessions(['first', 'child', 'grandchild'], revoke)).rejects.toBe(
      firstError,
    )
    expect(revoke.mock.calls.map(([id]) => id)).toEqual(['first', 'child', 'grandchild'])
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('archived session cleanup failed'),
      expect.objectContaining({ sessionId: 'first', error: 'Error: parked cleanup failed' }),
    )
    expect(warn).toHaveBeenCalledTimes(2)
  } finally {
    warn.mockRestore()
  }
})

it('awaits session teardown before release and retries failed removals during startup', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ari-release-retry-'))
  const orphan = join(dir, 'worktrees', 'project', 'old-child')
  const live = join(dir, 'worktrees', 'project', 'root')
  await mkdir(orphan, { recursive: true })
  await mkdir(live, { recursive: true })
  await writeFile(join(orphan, 'leftover.txt'), 'old\n')
  const old = new Date(Date.now() - 10 * 60_000)
  await utimes(orphan, old, old)
  await writeFile(join(live, 'keep.txt'), 'live\n')
  const store = new SessionStore({ rootDir: join(dir, 'sessions') })
  const engine = new Engine({
    store,
    registry: new DriverRegistry(),
    publish: () => undefined,
    resolveWorkspace: async () => dir,
    git: { captureCheckpoint: async () => ({ ok: true, value: null }) },
  })
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
  const options = {
    engine,
    store,
    userData: dir,
    cliPath,
    executable: process.execPath,
    version: 'test',
    policy: () => delegationSettingsSchema.parse({ approvalMode: 'never' }),
    providers: async () => [],
  }
  let runtime = await startAgentRuntime(options)
  try {
    await vi.waitFor(
      async () => {
        await expect(readFile(join(orphan, 'leftover.txt'))).rejects.toThrow()
      },
      { timeout: 10_000 },
    )
    expect(await readFile(join(live, 'keep.txt'), 'utf8')).toBe('live\n')
    const locked = join(dir, 'worktrees', 'project', 'locked-child')
    await mkdir(locked)
    await writeFile(join(locked, 'leftover.txt'), 'locked\n')
    await utimes(locked, old, old)
    const effects: string[] = []
    let finish!: () => void
    await runtime.close()
    runtime = await startAgentRuntime({
      ...options,
      onDrop: async (id) => {
        effects.push(`stopping ${id}`)
        await new Promise<void>((resolve) => {
          finish = resolve
        })
        effects.push(`stopped ${id}`)
      },
    })
    await vi.waitFor(
      async () => {
        await expect(readFile(join(locked, 'leftover.txt'))).rejects.toThrow()
      },
      { timeout: 10_000 },
    )
    // Startup sweeps unregistered folders, so recreate this future release.
    await mkdir(locked, { recursive: true })
    await writeFile(join(locked, 'leftover.txt'), 'locked\n')
    const release = vi
      .spyOn(ManagedWorkspaces.prototype, 'release')
      .mockImplementationOnce(async (id) => {
        effects.push(`release ${id}`)
        await writeFile(
          join(dir, 'worktrees', '.pending-releases.json'),
          JSON.stringify({ [id]: [] }),
        )
        throw new Error('folder locked')
      })
    const releasing = runtime.release('locked-child')
    await vi.waitFor(() => expect(effects).toEqual(['stopping locked-child']))
    expect(release).not.toHaveBeenCalled()
    finish()
    await releasing
    expect(effects).toEqual([
      'stopping locked-child',
      'stopped locked-child',
      'release locked-child',
    ])
    release.mockRestore()
    await runtime.close()
    const dropped = vi.fn(async () => undefined)
    runtime = await startAgentRuntime({ ...options, onDrop: dropped })
    await vi.waitFor(() => expect(dropped).toHaveBeenCalledWith('locked-child', 'release'))
    await vi.waitFor(
      async () => {
        await expect(readFile(join(locked, 'leftover.txt'))).rejects.toThrow()
      },
      { timeout: 10_000 },
    )
    expect(await readFile(join(live, 'keep.txt'), 'utf8')).toBe('live\n')
  } finally {
    vi.restoreAllMocks()
    await runtime.close()
    await store.closeJournal('root')
    await rm(dir, { recursive: true, force: true, maxRetries: 3 })
  }
}, 30_000)
