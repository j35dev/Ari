// @vitest-environment node
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, parse } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ProjectStore } from '@ari/engine/projects'
import { GitService, ManagedWorkspaces } from '@ari/engine/git'
import type { Session } from '@ari/contracts/session'
import { ControlFailure } from '@ari/contracts/agent-control'
import {
  projectCreationFailureDetailsSchema,
  projectCreationProgressSchema,
  type ProjectCreationProgress,
} from '@ari/contracts/project'
import {
  createProject,
  defaultProjectsFolder,
  projectSlug,
  type ProjectCreateDeps,
} from './project-create'

let dir: string
let deps: ProjectCreateDeps
const git = new GitService()

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'ari-project-create-')))
  deps = {
    home: join(dir, 'home'),
    userData: join(dir, 'ari-data'),
    projects: new ProjectStore({ dir: join(dir, 'ari-data') }),
  }
  await mkdir(deps.home)
  await mkdir(deps.userData)
})

afterEach(async () => {
  vi.restoreAllMocks()
  await rm(dir, { recursive: true, force: true, maxRetries: 3 })
})

it.each(['repository_check', 'git_init', 'initial_commit', 'registering'] as const)(
  'preserves the exact chosen folder and failed %s phase without exposing exception output',
  async (phase) => {
    const path = join(deps.home, 'Projects', 'app')
    const secret = 'Fixture secret that must not enter recovery details'
    if (phase === 'repository_check') {
      vi.spyOn(GitService.prototype, 'isRepo').mockResolvedValue({
        ok: false,
        error: { code: 'command_failed', message: secret },
      })
    } else if (phase !== 'registering') {
      const original = GitService.prototype.runPlumbing
      vi.spyOn(GitService.prototype, 'runPlumbing').mockImplementation(async (cwd, args, env) => {
        if (
          (phase === 'git_init' && args[0] === 'init') ||
          (phase === 'initial_commit' && args.includes('commit'))
        ) {
          await writeFile(join(cwd, 'notes.txt'), 'Keep partial work')
          return { ok: false, error: { code: 'command_failed', message: secret } }
        }
        return original.call(git, cwd, args, env)
      })
    } else {
      // Make the real registry write fail after the helper initializes the repo.
      await mkdir(join(deps.userData, 'projects.json.tmp'))
    }
    const error: unknown = await createProject(deps, { name: 'App' }).catch(
      (failure: unknown) => failure,
    )
    expect(error).toBeInstanceOf(ControlFailure)
    expect(error).toMatchObject({
      code: 'uncertain_outcome',
      details: {
        projectCreation: { name: 'App', path, created: true, phase },
        failureCode: phase === 'registering' ? 'project_registration_failed' : 'project_git_failed',
      },
    })
    expect(JSON.stringify(error)).not.toContain(secret)
    if (error instanceof ControlFailure) {
      expect(error.message).not.toContain(secret)
      expect(projectCreationFailureDetailsSchema.safeParse(error.details).success).toBe(true)
    }
    expect((await stat(path)).isDirectory()).toBe(true)
    expect(await readdir(dirname(path))).toEqual(['app'])
    if (phase === 'registering') {
      await expect(readFile(join(deps.userData, 'projects.json'))).rejects.toMatchObject({
        code: 'ENOENT',
      })
    } else expect(await deps.projects.load()).toEqual([])
    if (phase === 'initial_commit')
      expect((await stat(join(path, '.git'))).isDirectory()).toBe(true)
    if (phase === 'git_init' || phase === 'initial_commit') {
      expect(await readFile(join(path, 'notes.txt'), 'utf8')).toBe('Keep partial work')
    }
  },
)

it('awaits receipt persistence and emits distinct immutable snapshots before later effects', async () => {
  let release!: () => void
  let enter!: () => void
  const entered = new Promise<void>((resolve) => {
    enter = resolve
  })
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const path = join(dir, 'held')
  const snapshots: Readonly<ProjectCreationProgress>[] = []
  const repoCheck = vi.spyOn(GitService.prototype, 'isRepo')
  const registration = vi.spyOn(deps.projects, 'open')
  const creation = createProject(
    {
      ...deps,
      onProgress: async (snapshot) => {
        snapshots.push(snapshot)
        if (snapshot.phase === 'folder_ready') {
          enter()
          await held
        }
      },
    },
    { name: 'Held', path },
  )
  try {
    await entered
    expect((await stat(path)).isDirectory()).toBe(true)
    expect(await readdir(path)).toEqual([])
    expect(repoCheck).not.toHaveBeenCalled()
    expect(registration).not.toHaveBeenCalled()
  } finally {
    release()
  }
  const result = await creation
  expect(snapshots.map((snapshot) => snapshot.phase)).toEqual([
    'folder_ready',
    'repository_check',
    'git_init',
    'initial_commit',
    'registering',
    'registered',
  ])
  expect(snapshots.every((snapshot) => Object.isFrozen(snapshot))).toBe(true)
  expect(
    snapshots.every((snapshot) => projectCreationProgressSchema.safeParse(snapshot).success),
  ).toBe(true)
  expect(new Set(snapshots).size).toBe(snapshots.length)
  expect(snapshots[0]?.projectId).toBeUndefined()
  expect(snapshots.at(-1)).toEqual({ ...result, phase: 'registered' })
})

it('preserves adopted content, saved preferences and actual identity after registered receipt failure', async () => {
  const path = join(dir, 'adopted')
  await mkdir(path)
  await writeFile(join(path, 'notes.txt'), 'Keep existing work')
  const project = await deps.projects.add(path, 'Existing name')
  const agent = {
    driverKind: 'codex' as const,
    modelId: 'saved',
    effort: 'high',
    permissionMode: 'full' as const,
  }
  await deps.projects.setDefaultAgent(project.id, agent)
  const repoCheck = vi.spyOn(GitService.prototype, 'isRepo')
  const plumbing = vi.spyOn(GitService.prototype, 'runPlumbing')
  const snapshots: Readonly<ProjectCreationProgress>[] = []
  const error: unknown = await createProject(
    {
      ...deps,
      onProgress: async (snapshot) => {
        snapshots.push(snapshot)
        if (snapshot.phase === 'registered') throw new Error('Registration receipt failed')
      },
    },
    { name: 'Requested name', path },
  ).catch((failure: unknown) => failure)
  expect(error).toMatchObject({
    code: 'uncertain_outcome',
    details: {
      failureCode: 'project_progress_failed',
      projectCreation: {
        name: 'Existing name',
        path,
        created: false,
        phase: 'registered',
        projectId: project.id,
      },
    },
  })
  expect(snapshots.map((snapshot) => snapshot.phase)).toEqual([
    'folder_ready',
    'registering',
    'registered',
  ])
  expect(repoCheck).not.toHaveBeenCalled()
  expect(plumbing).not.toHaveBeenCalled()
  expect(await readdir(path)).toEqual(['notes.txt'])
  expect(await readFile(join(path, 'notes.txt'), 'utf8')).toBe('Keep existing work')
  const reloaded = new ProjectStore({ dir: deps.userData })
  await reloaded.load()
  expect(reloaded.get(project.id)).toMatchObject({
    name: 'Existing name',
    open: true,
    defaultAgent: agent,
  })
})

it('bounds progress display names without changing successful project names or exact paths', async () => {
  const path = join(dir, 'display-name')
  const name = `A\n${'x'.repeat(130)}`
  const snapshots: Readonly<ProjectCreationProgress>[] = []
  const result = await createProject(
    {
      ...deps,
      onProgress: async (snapshot) => {
        snapshots.push(snapshot)
      },
    },
    { name, path },
  )
  expect(result.name).toBe(name)
  expect(
    snapshots.every((snapshot) => snapshot.name.length <= 120 && !snapshot.name.includes('\n')),
  ).toBe(true)
  expect(snapshots.every((snapshot) => snapshot.path === path)).toBe(true)
})

it('keeps validation failures before target effects retryable and emits no recovery progress', async () => {
  const onProgress = vi.fn(async () => undefined)
  await expect(
    createProject({ ...deps, onProgress }, { name: 'Unsafe', path: deps.home }),
  ).rejects.toMatchObject({
    code: 'unsafe_project_path',
    details: undefined,
  })
  expect(onProgress).not.toHaveBeenCalled()
  expect(await readdir(deps.home)).toEqual([])
  expect(await deps.projects.load()).toEqual([])
})

it.each([
  'folder_ready',
  'repository_check',
  'git_init',
  'initial_commit',
  'registering',
  'registered',
] as const)(
  'stops subsequent effects when persisting the %s progress snapshot fails',
  async (phase) => {
    const path = join(dir, 'new-app')
    const progress: Readonly<ProjectCreationProgress>[] = []
    const repoCheck = vi.spyOn(GitService.prototype, 'isRepo')
    const plumbing = vi.spyOn(GitService.prototype, 'runPlumbing')
    const registration = vi.spyOn(deps.projects, 'open')
    const error: unknown = await createProject(
      {
        ...deps,
        onProgress: async (snapshot: Readonly<ProjectCreationProgress>) => {
          expect(Object.isFrozen(snapshot)).toBe(true)
          progress.push(snapshot)
          if (snapshot.phase === phase) throw new Error('Receipt persistence unavailable')
        },
      },
      { name: 'New app', path },
    ).catch((failure: unknown) => failure)
    expect(error).toMatchObject({
      code: 'uncertain_outcome',
      details: {
        projectCreation: { name: 'New app', path, created: true, phase },
        failureCode: 'project_progress_failed',
      },
    })
    expect(progress.at(-1)?.phase).toBe(phase)
    expect(progress[0]?.phase).toBe('folder_ready')
    expect(new Set(progress).size).toBe(progress.length)
    expect((await stat(path)).isDirectory()).toBe(true)
    const didInit = phase === 'initial_commit' || phase === 'registering' || phase === 'registered'
    const didCommit = phase === 'registering' || phase === 'registered'
    expect(plumbing.mock.calls.some(([, args]) => args[0] === 'init')).toBe(didInit)
    expect(plumbing.mock.calls.some(([, args]) => args.includes('commit'))).toBe(didCommit)
    expect(repoCheck).toHaveBeenCalledTimes(
      phase === 'folder_ready' || phase === 'repository_check' ? 0 : 1,
    )
    expect(registration).toHaveBeenCalledTimes(phase === 'registered' ? 1 : 0)
    if (phase === 'registered') {
      const project = (await deps.projects.load())[0]!
      expect(error).toMatchObject({ details: { projectCreation: { projectId: project.id } } })
      expect(progress.at(-1)?.projectId).toBe(project.id)
    } else expect(await deps.projects.load()).toEqual([])
  },
)

it.each([
  ['  Garden / Planner: app?!  ', 'garden-planner-app'],
  ['Café tracker', 'cafe-tracker'],
  ['日本語', '日本語'],
  ['...', 'project'],
  ['CON', 'project-con'],
  ['LPT1', 'project-lpt1'],
])('makes a filesystem-safe slug from %s', (name, slug) => {
  expect(projectSlug(name)).toBe(slug)
})

it('uses a majority parent, excluding Aria, and falls back when there is no majority', () => {
  const parent = join(dir, 'Projects')
  const rows = [
    { id: 'one', path: join(parent, 'one') },
    { id: 'two', path: join(parent, 'two') },
    { id: 'other', path: join(dir, 'elsewhere', 'other') },
    { id: 'helm', path: join(deps.userData, 'aria') },
  ]
  expect(defaultProjectsFolder(rows, deps.home)).toBe(parent)
  expect(defaultProjectsFolder([rows[0]!, rows[2]!, rows[3]!], deps.home)).toBe(
    join(deps.home, 'Projects'),
  )
  expect(defaultProjectsFolder([], deps.home)).toBe(join(deps.home, 'Projects'))
})

it('creates unique open projects under the usual parent, including file name collisions', async () => {
  const parent = join(dir, 'Projects')
  await mkdir(join(parent, 'existing'), { recursive: true })
  await deps.projects.open(join(parent, 'existing'))
  await writeFile(join(parent, 'garden'), 'occupied')
  const first = await createProject(deps, { name: 'Garden' })
  const second = await createProject(deps, { name: 'Garden' })
  expect(first).toMatchObject({ name: 'Garden', path: join(parent, 'garden-2'), created: true })
  expect(second.path).toBe(join(parent, 'garden-3'))
  expect(second.projectId).not.toBe(first.projectId)
  expect(deps.projects.get(first.projectId)?.open).toBe(true)
})

it('falls back to home/Projects and never chooses Ari data as the default parent', async () => {
  await deps.projects.open(join(deps.userData, 'existing'))
  const result = await createProject(deps, { name: 'New app' })
  expect(result.path).toBe(join(deps.home, 'Projects', 'new-app'))
  expect(result.created).toBe(true)
})

it('treats an occupied symlink name as a collision without adopting its target', async () => {
  const parent = join(deps.home, 'Projects')
  await mkdir(parent)
  await symlink(
    deps.userData,
    join(parent, 'app'),
    process.platform === 'win32' ? 'junction' : 'dir',
  )
  const result = await createProject(deps, { name: 'App' })
  expect(result.path).toBe(join(parent, 'app-2'))
  expect(await readdir(deps.userData)).toEqual(['projects.json'])
})

it('refuses drive roots, home itself, data folders, system folders and relative paths', async () => {
  const system =
    process.platform === 'win32' ? (process.env['SystemRoot'] ?? 'C:\\Windows') : '/etc'
  for (const path of [
    parse(dir).root,
    deps.home,
    deps.userData,
    join(deps.userData, 'aria', 'new'),
    system,
    join(system, 'new-project'),
    'relative/project',
  ]) {
    await expect(createProject(deps, { name: 'Unsafe', path })).rejects.toMatchObject({
      code: path === 'relative/project' ? 'invalid_request' : 'unsafe_project_path',
    })
  }
  expect(await deps.projects.load()).toEqual([])
})

it('refuses a symlink into Ari data even when several descendant folders do not exist', async () => {
  const link = join(dir, 'alias')
  await symlink(deps.userData, link, process.platform === 'win32' ? 'junction' : 'dir')
  await expect(
    createProject(deps, { name: 'Unsafe', path: join(link, 'missing', 'app') }),
  ).rejects.toMatchObject({ code: 'unsafe_project_path' })
  expect(await readdir(deps.userData)).toEqual([])
})

it('adopts an existing folder as is and reopens its registered project', async () => {
  const path = join(dir, 'existing')
  await mkdir(path)
  await writeFile(join(path, 'notes.txt'), 'Keep this')
  const existing = await deps.projects.add(path, 'Existing')
  const result = await createProject(deps, { name: 'Existing', path })
  expect(result).toEqual({ projectId: existing.id, name: 'Existing', path, created: false })
  expect(deps.projects.get(existing.id)?.open).toBe(true)
  expect(await readdir(path)).toEqual(['notes.txt'])
  expect(await readFile(join(path, 'notes.txt'), 'utf8')).toBe('Keep this')
})

it('rejects an existing file instead of registering it', async () => {
  const path = join(dir, 'file')
  await writeFile(path, 'Keep this')
  await expect(createProject(deps, { name: 'File', path })).rejects.toMatchObject({
    code: 'invalid_request',
  })
  expect(await readFile(path, 'utf8')).toBe('Keep this')
})

it('initializes a newly named folder with an empty commit that supports isolated workers', async () => {
  const result = await createProject(deps, { name: 'App', path: join(dir, 'nested', 'app') })
  expect(result.created).toBe(true)
  expect((await stat(join(result.path, '.git'))).isDirectory()).toBe(true)
  const head = await git.runPlumbing(result.path, ['rev-parse', '--verify', 'HEAD'])
  expect(head.ok).toBe(true)
  const tree = await git.runPlumbing(result.path, ['ls-tree', '--name-only', 'HEAD'])
  expect(tree).toMatchObject({ ok: true, value: { stdout: '' } })
  const parent: Session = {
    id: 'lead',
    projectId: result.projectId,
    title: 'Lead',
    driverKind: 'claude',
    modelId: null,
    permissionMode: 'ask',
    status: 'idle',
    createdAt: 1,
    updatedAt: 1,
  }
  const workspaces = new ManagedWorkspaces(join(dir, 'worktrees'))
  const workspace = await workspaces.isolate(parent, result.path, 'worker', 'Worker')
  expect(workspace.kind).toBe('managed-worktree')
  await workspaces.release('worker')
})

it('leaves an existing repository and its HEAD untouched, including new folders inside it', async () => {
  const existing = await createProject(deps, { name: 'Existing', path: join(dir, 'repo') })
  const head = await git.runPlumbing(existing.path, ['rev-parse', 'HEAD'])
  const config = await readFile(join(existing.path, '.git', 'config'), 'utf8')
  expect(await createProject(deps, { name: 'Existing', path: existing.path })).toMatchObject({
    created: false,
  })
  const progress: Readonly<ProjectCreationProgress>[] = []
  const nested = await createProject(
    {
      ...deps,
      onProgress: async (snapshot) => {
        progress.push(snapshot)
      },
    },
    { name: 'Nested', path: join(existing.path, 'nested') },
  )
  expect(progress.map((snapshot) => snapshot.phase)).toEqual([
    'folder_ready',
    'repository_check',
    'registering',
    'registered',
  ])
  expect(nested.created).toBe(true)
  expect(await readdir(nested.path)).toEqual([])
  expect(await git.runPlumbing(existing.path, ['rev-parse', 'HEAD'])).toEqual(head)
  expect(await readFile(join(existing.path, '.git', 'config'), 'utf8')).toBe(config)
})
