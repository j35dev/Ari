// @vitest-environment node
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, parse } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { ProjectStore } from '@ari/engine/projects'
import { GitService, ManagedWorkspaces } from '@ari/engine/git'
import type { Session } from '@ari/contracts/session'
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
  dir = await mkdtemp(join(tmpdir(), 'ari-project-create-'))
  deps = {
    home: join(dir, 'home'),
    userData: join(dir, 'ari-data'),
    projects: new ProjectStore({ dir: join(dir, 'ari-data') }),
  }
  await mkdir(deps.home)
  await mkdir(deps.userData)
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 3 })
})

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
  const nested = await createProject(deps, { name: 'Nested', path: join(existing.path, 'nested') })
  expect(nested.created).toBe(true)
  expect(await readdir(nested.path)).toEqual([])
  expect(await git.runPlumbing(existing.path, ['rev-parse', 'HEAD'])).toEqual(head)
  expect(await readFile(join(existing.path, '.git', 'config'), 'utf8')).toBe(config)
})
