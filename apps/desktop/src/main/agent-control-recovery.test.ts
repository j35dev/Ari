// @vitest-environment node
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, expect, it, vi, type Mock } from 'vitest'
import { delegationSettingsSchema, type CreatedProject } from '@ari/contracts/agent-control'
import { projectCreationProgressSchema, type ProjectCreationProgress } from '@ari/contracts/project'
import type { UnstampedEvent } from '@ari/engine/projection'
import { SessionStore } from '@ari/engine/session-store'
import { ProjectStore } from '@ari/engine/projects'
import { GitService, ManagedWorkspaces } from '@ari/engine/git'
import { err } from '@ari/shared/result'
import { DriverRegistry } from '@ari/providers/registry'
import { Engine } from './engine'
import { startAgentRuntime } from './agent-runtime'
import { createProject } from './project-create'

let dir: string
let home: string
let userData: string
let store: SessionStore
let projects: ProjectStore
let engine: Engine
let runtime: Awaited<ReturnType<typeof startAgentRuntime>>
type ProjectCreator = (
  input: { name: string; path?: string },
  onProgress?: (progress: Readonly<ProjectCreationProgress>) => Promise<void>,
) => Promise<CreatedProject>
let create: Mock<ProjectCreator>
const params = { name: 'Recover', idempotencyKey: 'recover' }

it.each(['returned', 'thrown', 'before checkout'] as const)(
  'retains one isolated worker identity across reload after %s worktree failure',
  async (failure) => {
    const project = await createProject(
      { projects, home, userData },
      { name: 'Worker project', path: join(dir, 'worker-project') },
    )
    await engine.createSession({
      id: 'root',
      projectId: project.projectId,
      title: 'Root',
      driverKind: 'codex',
      modelId: 'fixture',
      permissionMode: 'ask',
      status: 'idle',
      createdAt: 1,
      updatedAt: 1,
    })
    const original = GitService.prototype.addWorktree
    const add = vi
      .spyOn(GitService.prototype, 'addWorktree')
      .mockImplementationOnce(async function (this: GitService, ...args) {
        if (failure !== 'before checkout') {
          const result = await original.apply(this, args)
          expect(result.ok).toBe(true)
        }
        if (failure === 'thrown') throw new Error('untrusted checkout failure detail')
        return err({ code: 'command_failed', message: 'git timed out while adding worktree' })
      })
    const creating = vi.spyOn(engine, 'createSession')
    const request = {
      title: 'Worker',
      driverKind: 'codex',
      modelId: 'fixture',
      workspaceMode: 'isolated',
      idempotencyKey: 'checkout-loss',
    }
    const first = await runtime.service.invoke('root', 'session.spawn', request)
    const receipt = await operation('root')
    const [, path, branch, , baseCommit] = add.mock.calls[0]!
    const childSessionId = path.split(/[\\/]/).at(-1)!
    const recovery = {
      childSessionId,
      projectId: project.projectId,
      stage: 'workspace_preparing',
      workspacePath: path,
      workspace: {
        kind: 'managed-worktree',
        path,
        branch,
        baseRef: `refs/ari/orchestration/${childSessionId}/base`,
        baseCommit,
      },
    }
    expect(first).toMatchObject({
      ok: false,
      error: {
        code: 'uncertain_outcome',
        details: { operationId: receipt.operationId, ...recovery },
      },
    })
    expect(receipt).toMatchObject({ status: 'uncertain', result: { recovery } })
    expect(creating).not.toHaveBeenCalled()
    expect(await store.loadExisting(childSessionId)).toBeNull()
    const inspectFolder = async () => {
      if (failure === 'before checkout')
        await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
      else {
        expect((await stat(path)).isDirectory()).toBe(true)
        expect(await readFile(join(path, '.git'), 'utf8')).toContain('gitdir:')
      }
    }
    await inspectFolder()
    await reload()
    const replayCreate = vi.spyOn(engine, 'createSession')
    expect(await runtime.service.invoke('root', 'session.spawn', request)).toMatchObject({
      ok: false,
      error: {
        code: 'uncertain_outcome',
        details: { operationId: receipt.operationId, ...recovery },
      },
    })
    expect(
      await runtime.service.invoke('root', 'session.spawn', {
        ...request,
        title: 'Different worker',
      }),
    ).toMatchObject({ ok: false, error: { code: 'invalid_request' } })
    expect(add).toHaveBeenCalledTimes(1)
    expect(replayCreate).not.toHaveBeenCalled()
    await inspectFolder()
  },
)

it('retries a pre-worktree repository validation failure with the same key after Git is ready', async () => {
  const folder = join(dir, 'worker-project')
  await mkdir(folder)
  const project = await projects.open(folder, 'Worker project')
  await engine.createSession({
    id: 'root',
    projectId: project.id,
    title: 'Root',
    driverKind: 'codex',
    modelId: 'fixture',
    permissionMode: 'ask',
    status: 'idle',
    createdAt: 1,
    updatedAt: 1,
  })
  const add = vi.spyOn(GitService.prototype, 'addWorktree')
  const request = {
    title: 'Worker',
    driverKind: 'codex',
    modelId: 'fixture',
    workspaceMode: 'isolated',
    idempotencyKey: 'git-not-ready',
  }
  expect(await runtime.service.invoke('root', 'session.spawn', request)).toMatchObject({
    ok: false,
    error: { code: 'workspace_not_git' },
  })
  expect(add).not.toHaveBeenCalled()
  const git = new GitService()
  expect((await git.runPlumbing(folder, ['init', '--template='])).ok).toBe(true)
  expect(
    (
      await git.runPlumbing(
        folder,
        [
          '-c',
          'core.hooksPath=',
          '-c',
          'commit.gpgsign=false',
          'commit',
          '--allow-empty',
          '-m',
          'Fixture',
        ],
        {
          ...process.env,
          GIT_AUTHOR_NAME: 'Ari fixture',
          GIT_AUTHOR_EMAIL: 'fixture@localhost',
          GIT_COMMITTER_NAME: 'Ari fixture',
          GIT_COMMITTER_EMAIL: 'fixture@localhost',
        },
      )
    ).ok,
  ).toBe(true)
  await reload()
  const result = await runtime.service.invoke('root', 'session.spawn', request)
  expect(result).toMatchObject({ ok: true, result: { child: { projectId: project.id } } })
  expect(await runtime.service.invoke('root', 'session.spawn', request)).toEqual(result)
  expect(add).toHaveBeenCalledTimes(1)
})

it.each(['session.spawn', 'projects.ask'] as const)(
  'retains top-level %s shared workspace identity after a lost completion receipt',
  async (method) => {
    const project = await createProject(
      { projects, home, userData },
      {
        name: 'Shared project',
        path: join(dir, 'shared-project'),
      },
    )
    await projects.setDefaultAgent(project.projectId, {
      driverKind: 'codex',
      modelId: 'fixture',
      effort: null,
      permissionMode: 'ask',
    })
    const record = engine.record.bind(engine)
    vi.spyOn(engine, 'record').mockImplementation(async (id, event) => {
      if (
        event.type === 'orchestration.operation.updated' &&
        event.operation.status === 'completed'
      )
        throw new Error('Lost shared worker receipt')
      return record(id, event)
    })
    const request =
      method === 'session.spawn'
        ? {
            projectId: project.projectId,
            title: 'Shared worker',
            prompt: 'Keep work',
            idempotencyKey: 'shared',
          }
        : { projectId: project.projectId, text: 'Keep work', idempotencyKey: 'shared' }
    const dispatch = vi.spyOn(engine, 'dispatch')
    await runtime.service.invoke('aria', method, request)
    const previous = await operation()
    const recovery = (previous.result as { recovery: { childSessionId: string } }).recovery
    expect(recovery).toMatchObject({
      stage: 'session_created',
      projectId: project.projectId,
      workspace: { kind: 'project' },
      workspacePath: project.path,
    })
    const count = (await store.listSessions()).length
    await reload()
    expect(await runtime.service.invoke('aria', method, request)).toMatchObject({
      ok: false,
      error: {
        code: 'uncertain_outcome',
        details: { operationId: previous.operationId, ...recovery },
      },
    })
    expect(await store.listSessions()).toHaveLength(count)
    expect(
      (await store.load(recovery.childSessionId)).messages.filter(
        (message) => message.role === 'user',
      ),
    ).toHaveLength(1)
    expect(
      dispatch.mock.calls.filter(([command]) => command.type === 'message.enqueue'),
    ).toHaveLength(1)
  },
)

it.each([
  undefined,
  {
    childSessionId: 'fake',
    stage: 'session_created',
    workspace: {
      kind: 'managed-worktree',
      path: 'fake',
      branch: 'fake',
      baseRef: 'fake',
      baseCommit: 'invalid',
    },
  },
])('returns only the operation identity for missing/corrupt worker recovery', async (recovery) => {
  const project = await createProject(
    { projects, home, userData },
    { name: 'Worker project', path: join(dir, 'worker-project') },
  )
  await engine.createSession({
    id: 'root',
    projectId: project.projectId,
    title: 'Root',
    driverKind: 'codex',
    modelId: 'fixture',
    permissionMode: 'ask',
    status: 'idle',
    createdAt: 1,
    updatedAt: 1,
  })
  const original = engine.createSession.bind(engine)
  const creating = vi.spyOn(engine, 'createSession').mockImplementationOnce(async (session) => {
    await original(session)
    throw new Error('Lost worker receipt')
  })
  const request = {
    title: 'Worker',
    driverKind: 'codex',
    workspaceMode: 'isolated',
    idempotencyKey: 'worker',
  }
  await runtime.service.invoke('root', 'session.spawn', request)
  const previous = await operation('root')
  await store.append('root', {
    type: 'orchestration.operation.updated',
    operation: { ...previous, result: { recovery } },
  })
  await reload()
  expect(await runtime.service.invoke('root', 'session.spawn', request)).toEqual({
    ok: false,
    error: {
      code: 'uncertain_outcome',
      message: expect.any(String),
      details: { operationId: previous.operationId },
    },
  })
  expect(creating).toHaveBeenCalledTimes(1)
})

function progressOf(event: UnstampedEvent): ProjectCreationProgress | undefined {
  if (event.type !== 'orchestration.operation.updated') return undefined
  const result = event.operation.result as { recovery?: { projectCreation?: unknown } } | undefined
  return projectCreationProgressSchema.safeParse(result?.recovery?.projectCreation).data
}

async function start(): Promise<void> {
  const registry = new DriverRegistry()
  registry.register({
    kind: 'codex',
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
  engine = new Engine({
    store,
    registry,
    publish: () => undefined,
    resolveWorkspace: async (id) =>
      projects.list().find((project) => project.id === id)?.path ?? join(dir, 'worker-project'),
    git: { captureCheckpoint: async () => ({ ok: true, value: null }) },
  })
  runtime = await startAgentRuntime({
    engine,
    store,
    userData,
    cliPath: resolve('resources/cli/ari.cjs'),
    executable: process.execPath,
    version: 'test',
    recover: false,
    policy: () =>
      delegationSettingsSchema.parse({
        approvalMode: 'never',
        allowSharedWorkspace: true,
        autoDeliverResults: false,
      }),
    providers: async () => [
      { driverKind: 'codex', available: true, models: [{ id: 'fixture', label: 'Fixture' }] },
    ],
    projects: async () =>
      projects.list().map((project) => ({
        projectId: project.id,
        name: project.name,
        path: project.path,
        available: project.status === 'ok',
        defaultAgent: project.defaultAgent,
      })),
    createProject: create,
  })
}

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'ari-control-recovery-')))
  home = join(dir, 'home')
  userData = join(dir, 'data')
  await mkdir(home)
  projects = new ProjectStore({ dir: userData })
  store = new SessionStore({ rootDir: join(dir, 'sessions') })
  await store.append('aria', {
    type: 'session.created',
    session: {
      id: 'aria',
      projectId: 'helm',
      title: 'Aria',
      driverKind: 'codex',
      modelId: 'fixture',
      permissionMode: 'full',
      status: 'idle',
      createdAt: 1,
      updatedAt: 1,
    },
  })
  create = vi.fn<ProjectCreator>(async (input, onProgress) =>
    createProject({ projects, home, userData, onProgress }, input),
  )
  await start()
})

async function close(): Promise<void> {
  await runtime.close()
  for (const row of await store.listSessions()) {
    await engine.quiesce(row.id)
    await store.closeJournal(row.id)
  }
}

async function reload(): Promise<void> {
  await close()
  store = new SessionStore({ rootDir: join(dir, 'sessions') })
  projects = new ProjectStore({ dir: userData })
  await projects.load()
  await start()
}

afterEach(async () => {
  vi.restoreAllMocks()
  await close()
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

async function operation(caller = 'aria') {
  return Object.values((await store.load(caller)).orchestration!.operations)[0]!
}

const phases = [
  'folder_ready',
  'repository_check',
  'git_init',
  'initial_commit',
  'registering',
  'registered',
] as const

it.each(['repository_check', 'git_init', 'initial_commit', 'registering'] as const)(
  'retains actual helper %s uncertainty and same folder on fresh-runtime retry',
  async (phase) => {
    const path = join(home, 'Projects', 'recover')
    if (phase === 'repository_check') {
      vi.spyOn(GitService.prototype, 'isRepo').mockResolvedValue({
        ok: false,
        error: { code: 'command_failed', message: 'injected' },
      })
    } else if (phase === 'registering') {
      await mkdir(join(userData, 'projects.json.tmp'))
    } else {
      const git = new GitService()
      const original = GitService.prototype.runPlumbing
      vi.spyOn(GitService.prototype, 'runPlumbing').mockImplementation(async (cwd, args, env) => {
        if (
          (phase === 'git_init' && args[0] === 'init') ||
          (phase === 'initial_commit' && args.includes('commit'))
        )
          return { ok: false, error: { code: 'command_failed', message: 'injected' } }
        return original.call(git, cwd, args, env)
      })
    }
    const first = await runtime.service.invoke('aria', 'projects.create', params)
    const failureCode =
      phase === 'registering' ? 'project_registration_failed' : 'project_git_failed'
    expect(first).toMatchObject({
      ok: false,
      error: {
        code: 'uncertain_outcome',
        details: {
          operationId: expect.any(String),
          projectCreation: { name: 'Recover', path, created: true, phase },
          failureCode,
        },
      },
    })
    expect(await operation()).toMatchObject({
      status: 'uncertain',
      result: {
        recovery: {
          projectCreation: { path, phase },
          failureCode,
        },
      },
    })
    await reload()
    const retried = await runtime.service.invoke('aria', 'projects.create', params)
    expect(retried).toMatchObject({
      ok: false,
      error: {
        code: 'uncertain_outcome',
        details: {
          operationId: (await operation()).operationId,
          projectCreation: { name: 'Recover', path, created: true, phase },
          failureCode,
        },
      },
    })
    expect(create).toHaveBeenCalledTimes(1)
    expect(await readdir(join(home, 'Projects'))).toEqual(['recover'])
    expect((await stat(path)).isDirectory()).toBe(true)
  },
)

it.each(phases)(
  'preserves the exact %s identity when the operation progress write fails',
  async (phase) => {
    let injected = false
    const record = engine.record.bind(engine)
    vi.spyOn(engine, 'record').mockImplementation(async (id, event) => {
      if (
        !injected &&
        event.type === 'orchestration.operation.updated' &&
        event.operation.status === 'started' &&
        progressOf(event)?.phase === phase
      ) {
        injected = true
        throw new Error('Progress write failed')
      }
      return record(id, event)
    })
    const first = await runtime.service.invoke('aria', 'projects.create', params)
    expect(injected).toBe(true)
    const path = join(home, 'Projects', 'recover')
    const details = {
      projectCreation: { name: 'Recover', path, created: true, phase },
      failureCode: 'project_progress_failed',
    }
    expect(first).toMatchObject({ ok: false, error: { code: 'uncertain_outcome', details } })
    expect(await operation()).toMatchObject({ status: 'uncertain', result: { recovery: details } })
    await reload()
    const retry = await runtime.service.invoke('aria', 'projects.create', params)
    expect(retry).toMatchObject({ ok: false, error: { code: 'uncertain_outcome', details } })
    expect(create).toHaveBeenCalledTimes(1)
    if (phase === 'folder_ready' || phase === 'repository_check')
      expect(await readdir(path)).toEqual([])
    if (phase === 'registered')
      expect((await operation()).result).toMatchObject({
        recovery: { projectCreation: { projectId: projects.list()[0]!.id } },
      })
    expect(await readdir(join(home, 'Projects'))).toEqual(['recover'])
  },
)

it.each([false, true])(
  'keeps registration inspectable when final success receipt fails (afterAppend=$0)',
  async (afterAppend) => {
    let injected = false
    const record = engine.record.bind(engine)
    vi.spyOn(engine, 'record').mockImplementation(async (id, event) => {
      if (
        !injected &&
        event.type === 'orchestration.operation.updated' &&
        event.operation.status === 'completed'
      ) {
        injected = true
        if (afterAppend) await record(id, event)
        throw new Error('Final receipt failed')
      }
      return record(id, event)
    })
    const first = await runtime.service.invoke('aria', 'projects.create', params)
    const project = projects.list()[0]!
    const details = {
      projectCreation: {
        projectId: project.id,
        name: project.name,
        path: project.path,
        created: true,
        phase: 'registered',
      },
    }
    expect(first).toMatchObject({ ok: false, error: { code: 'uncertain_outcome', details } })
    expect(await operation()).toMatchObject({ status: 'uncertain', result: { recovery: details } })
    await reload()
    expect(await runtime.service.invoke('aria', 'projects.create', params)).toMatchObject({
      ok: false,
      error: { code: 'uncertain_outcome', details },
    })
    expect(create).toHaveBeenCalledTimes(1)
    expect(projects.list()).toHaveLength(1)
  },
)

it('preserves adopted folder content/defaults when registered progress persistence fails', async () => {
  const path = join(dir, 'adopted')
  await mkdir(path)
  await writeFile(join(path, 'draft.txt'), 'Keep user work')
  const existing = await projects.open(path, 'Existing')
  const saved = {
    driverKind: 'codex' as const,
    modelId: 'saved',
    effort: 'xhigh',
    permissionMode: 'full' as const,
  }
  await projects.setDefaultAgent(existing.id, saved)
  const record = engine.record.bind(engine)
  vi.spyOn(engine, 'record').mockImplementation(async (id, event) => {
    if (
      event.type === 'orchestration.operation.updated' &&
      event.operation.status === 'started' &&
      progressOf(event)?.phase === 'registered'
    )
      throw new Error('Lost progress')
    return record(id, event)
  })
  const request = { ...params, path, name: 'Requested' }
  await runtime.service.invoke('aria', 'projects.create', request)
  await reload()
  expect(await runtime.service.invoke('aria', 'projects.create', request)).toMatchObject({
    ok: false,
    error: {
      code: 'uncertain_outcome',
      details: {
        projectCreation: {
          projectId: existing.id,
          path,
          name: 'Existing',
          created: false,
          phase: 'registered',
        },
      },
    },
  })
  expect(create).toHaveBeenCalledTimes(1)
  expect(await readdir(path)).toEqual(['draft.txt'])
  expect(await readFile(join(path, 'draft.txt'), 'utf8')).toBe('Keep user work')
  expect(projects.get(existing.id)?.defaultAgent).toEqual(saved)
})

it('retries validation-only failure after recovery with the same key and preserves successful create', async () => {
  const path = join(dir, 'blocked')
  await writeFile(path, 'Keep file')
  const request = { ...params, path }
  expect(await runtime.service.invoke('aria', 'projects.create', request)).toMatchObject({
    ok: false,
    error: { code: 'invalid_request' },
  })
  expect(await operation()).toMatchObject({ status: 'completed' })
  // The test removes only its own blocking file to simulate the external condition changing.
  await rm(path)
  await reload()
  const result = await runtime.service.invoke('aria', 'projects.create', request)
  expect(result).toMatchObject({ ok: true, result: { name: 'Recover', path, created: true } })
  await reload()
  expect(await runtime.service.invoke('aria', 'projects.create', request)).toEqual(result)
  expect(create).toHaveBeenCalledTimes(2)
  expect(projects.list()).toHaveLength(1)
  expect(await new GitService().isRepo(path)).toEqual({ ok: true, value: true })
})

it.each([undefined, { projectCreation: { path: 'made-up', phase: 'registered', created: 'yes' } }])(
  'does not fabricate recovery from missing or corrupt project progress',
  async (recovery) => {
    vi.spyOn(GitService.prototype, 'isRepo').mockResolvedValue({
      ok: false,
      error: { code: 'command_failed', message: 'injected' },
    })
    await runtime.service.invoke('aria', 'projects.create', params)
    const previous = await operation()
    await store.append('aria', {
      type: 'orchestration.operation.updated',
      operation: { ...previous, result: { recovery } },
    })
    await reload()
    const retry = await runtime.service.invoke('aria', 'projects.create', params)
    expect(retry).toEqual({
      ok: false,
      error: {
        code: 'uncertain_outcome',
        message: expect.any(String),
        details: { operationId: previous.operationId },
      },
    })
    expect(create).toHaveBeenCalledTimes(1)
  },
)

it('retains the last persisted phase if the uncertain outcome receipt itself is lost', async () => {
  const git = new GitService()
  const original = GitService.prototype.runPlumbing
  vi.spyOn(GitService.prototype, 'runPlumbing').mockImplementation(async (cwd, args, env) =>
    args.includes('commit')
      ? { ok: false, error: { code: 'command_failed', message: 'injected' } }
      : original.call(git, cwd, args, env),
  )
  const record = engine.record.bind(engine)
  vi.spyOn(engine, 'record').mockImplementation(async (id, event) => {
    if (event.type === 'orchestration.operation.updated' && event.operation.status === 'uncertain')
      throw new Error('Lost uncertain receipt')
    return record(id, event)
  })
  expect((await runtime.service.invoke('aria', 'projects.create', params)).ok).toBe(false)
  await reload()
  expect(await runtime.service.invoke('aria', 'projects.create', params)).toMatchObject({
    ok: false,
    error: {
      code: 'uncertain_outcome',
      details: {
        projectCreation: {
          name: 'Recover',
          path: join(home, 'Projects', 'recover'),
          created: true,
          phase: 'initial_commit',
        },
      },
    },
  })
  expect(create).toHaveBeenCalledTimes(1)
})

it.each(['create', 'prompt', 'receipt'] as const)(
  'exposes real isolated worker recovery after %s uncertainty without another effect',
  async (boundary) => {
    const folder = join(dir, 'worker-project')
    const project = await createProject(
      { projects, home, userData },
      { name: 'Worker project', path: folder },
    )
    await engine.createSession({
      id: 'root',
      projectId: project.projectId,
      title: 'Root',
      driverKind: 'codex',
      modelId: 'fixture',
      permissionMode: 'ask',
      status: 'idle',
      createdAt: 1,
      updatedAt: 1,
    })
    const originalCreate = engine.createSession.bind(engine)
    const originalDispatch = engine.dispatch.bind(engine)
    const isolate = vi.spyOn(ManagedWorkspaces.prototype, 'isolate')
    const createSession = vi.spyOn(engine, 'createSession')
    const dispatch = vi.spyOn(engine, 'dispatch')
    if (boundary === 'create') {
      createSession.mockImplementationOnce(async (session) => {
        await originalCreate(session)
        throw new Error('Lost create receipt')
      })
    } else if (boundary === 'prompt') {
      dispatch.mockImplementation(async (command, origin) => {
        const outcome = await originalDispatch(command, origin)
        if (command.type === 'message.enqueue') throw new Error('Lost prompt receipt')
        return outcome
      })
    } else {
      const record = engine.record.bind(engine)
      vi.spyOn(engine, 'record').mockImplementation(async (id, event) => {
        if (
          event.type === 'orchestration.operation.updated' &&
          event.operation.status === 'completed'
        )
          throw new Error('Lost worker receipt')
        return record(id, event)
      })
    }
    const request = {
      title: 'Worker',
      driverKind: 'codex',
      modelId: 'fixture',
      workspaceMode: 'isolated',
      prompt: 'Keep assignment',
      idempotencyKey: 'worker',
    }
    await runtime.service.invoke('root', 'session.spawn', request)
    const previous = await operation('root')
    const recovery = (
      previous.result as {
        recovery: { childSessionId: string; workspace: { path: string }; stage: string }
      }
    ).recovery
    expect(recovery).toMatchObject({
      childSessionId: expect.any(String),
      stage: expect.any(String),
      workspace: { kind: 'managed-worktree', path: expect.any(String) },
    })
    expect((await stat(recovery.workspace.path)).isDirectory()).toBe(true)
    expect(createSession).toHaveBeenCalledTimes(1)
    expect(isolate).toHaveBeenCalledTimes(1)
    expect(
      dispatch.mock.calls.filter(([command]) => command.type === 'message.enqueue'),
    ).toHaveLength(boundary === 'create' ? 0 : 1)
    await reload()
    expect(await runtime.service.invoke('root', 'session.spawn', request)).toMatchObject({
      ok: false,
      error: {
        code: 'uncertain_outcome',
        details: { operationId: previous.operationId, ...recovery },
      },
    })
    expect((await store.load(recovery.childSessionId)).session?.permissionMode).toBe('ask')
    await store.append(recovery.childSessionId, { type: 'session.updated', permissionMode: 'full' })
    await store.append('aria', { type: 'session.updated', permissionMode: 'ask' })
    expect(
      await runtime.service.invoke('aria', 'session.prompt', {
        targetSessionId: recovery.childSessionId,
        text: 'Should be refused',
        idempotencyKey: 'above-permission',
      }),
    ).toMatchObject({ ok: false, error: { code: 'scope_denied' } })
    expect((await stat(recovery.workspace.path)).isDirectory()).toBe(true)
    expect(createSession).toHaveBeenCalledTimes(1)
    expect(isolate).toHaveBeenCalledTimes(1)
    expect(
      dispatch.mock.calls.filter(([command]) => command.type === 'message.enqueue'),
    ).toHaveLength(boundary === 'create' ? 0 : 1)
  },
)
