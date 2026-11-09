import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile, utimes } from 'node:fs/promises'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Session } from '@ari/contracts/session'
import { ManagedWorkspaces } from './managed-workspaces'

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof fs>()
  return { ...original, rm: vi.fn(original.rm) }
})

const actualFs = await vi.importActual<typeof fs>('node:fs/promises')

let dir: string
let repo: string
let manager: ManagedWorkspaces
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
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim()

beforeEach(async () => {
  vi.mocked(fs.rm).mockReset().mockImplementation(actualFs.rm)
  dir = await mkdtemp(join(tmpdir(), 'ari-managed-'))
  repo = join(dir, 'parent space')
  await mkdir(repo)
  git(repo, 'init', '-q')
  git(repo, 'config', 'core.autocrlf', 'false')
  git(repo, 'config', 'user.name', 'Test')
  git(repo, 'config', 'user.email', 'test@example.com')
  await writeFile(join(repo, 'file.txt'), 'base\n')
  await writeFile(join(repo, '.gitignore'), '*.ignored\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-qm', 'base')
  manager = new ManagedWorkspaces(join(dir, 'worktrees'))
})
afterEach(async () => {
  vi.restoreAllMocks()
  vi.mocked(fs.rm).mockReset().mockImplementation(actualFs.rm)
  await rm(dir, { recursive: true, force: true, maxRetries: 3 })
})

it('captures committed, deleted, renamed and binary worker files without importing ignored files', async () => {
  const workspace = await manager.isolate(root, repo, 'binary-child')
  if (workspace.kind !== 'managed-worktree') throw new Error('expected managed workspace')
  const child = { ...root, id: 'binary-child', parentSessionId: root.id, workspace }
  await writeFile(join(workspace.path, 'renamed.txt'), 'base\n')
  await rm(join(workspace.path, 'file.txt'))
  await writeFile(join(workspace.path, 'binary.dat'), Buffer.from([0, 1, 2, 0, 255]))
  git(workspace.path, 'add', '.')
  git(workspace.path, 'commit', '-qm', 'worker changes')
  await writeFile(join(workspace.path, 'new untracked.txt'), 'after commit\n')
  await writeFile(join(workspace.path, 'private.ignored'), 'not integrated')
  const diff = (await manager.diff(child, true)) as {
    currentSnapshotCommit: string
    files: { path: string; status: string; binary: boolean }[]
  }
  expect(diff.files.find((file) => file.path === 'file.txt')?.status).toBe('D')
  expect(diff.files.find((file) => file.path === 'renamed.txt')?.status).toBe('A')
  expect(diff.files.find((file) => file.path === 'binary.dat')?.binary).toBe(true)
  expect(await manager.integrate(root, repo, child, diff.currentSnapshotCommit)).toMatchObject({
    status: 'integrated',
  })
  expect(await readFile(join(repo, 'binary.dat'))).toEqual(Buffer.from([0, 1, 2, 0, 255]))
  expect(await readFile(join(repo, 'new untracked.txt'), 'utf8')).toBe('after commit\n')
  await expect(readFile(join(repo, 'file.txt'))).rejects.toThrow()
  await expect(readFile(join(repo, 'private.ignored'))).rejects.toThrow()
}, 30_000)

it('isolates staged, unstaged and untracked state without changing the parent index or HEAD', async () => {
  await writeFile(join(repo, 'file.txt'), 'staged\n')
  git(repo, 'add', 'file.txt')
  await writeFile(join(repo, 'file.txt'), 'unstaged\n')
  await writeFile(join(repo, 'new.txt'), 'untracked\n')
  await writeFile(join(repo, 'secret.ignored'), 'ignored\n')
  const before = git(repo, 'status', '--porcelain=v1')
  const index = await readFile(join(repo, '.git', 'index'))
  const head = git(repo, 'rev-parse', 'HEAD')
  const workspace = await manager.isolate(root, repo, 'child')
  expect(await readFile(join(repo, '.git', 'index'))).toEqual(index)
  if (workspace.kind !== 'managed-worktree') throw new Error('expected managed workspace')
  expect(await readFile(join(workspace.path, 'file.txt'), 'utf8')).toBe('unstaged\n')
  expect(await readFile(join(workspace.path, 'new.txt'), 'utf8')).toBe('untracked\n')
  await expect(readFile(join(workspace.path, 'secret.ignored'))).rejects.toThrow()
  expect(git(repo, 'status', '--porcelain=v1')).toBe(before)
  expect(git(repo, 'rev-parse', 'HEAD')).toBe(head)
  // Git status may refresh cache timestamps; compare immediately after taking a fresh copy.
  expect(git(repo, 'show', ':file.txt')).toBe('staged')
  expect(index.length).toBeGreaterThan(0)
}, 20_000)

it('diffs untracked files and integrates exact snapshots incrementally into a dirty parent', async () => {
  const workspace = await manager.isolate(root, repo, 'child')
  if (workspace.kind !== 'managed-worktree') throw new Error('expected managed workspace')
  const child = { ...root, id: 'child', parentSessionId: root.id, workspace }
  await writeFile(join(workspace.path, 'new.txt'), 'worker\n')
  await writeFile(join(repo, 'parent.txt'), 'parent work\n')
  const diff = (await manager.diff(child, true)) as { currentSnapshotCommit: string; patch: string }
  expect(diff.patch).toContain('new.txt')
  expect(
    ((await manager.diff(child, false)) as { currentSnapshotCommit: string }).currentSnapshotCommit,
  ).toBe(diff.currentSnapshotCommit)
  expect(await manager.integrate(root, repo, child, diff.currentSnapshotCommit)).toMatchObject({
    status: 'integrated',
  })
  expect(await readFile(join(repo, 'new.txt'), 'utf8')).toBe('worker\n')
  expect(await readFile(join(repo, 'parent.txt'), 'utf8')).toBe('parent work\n')
  await writeFile(join(workspace.path, 'new.txt'), 'worker update\n')
  const next = (await manager.diff(child, false)) as { currentSnapshotCommit: string }
  expect(
    await manager.integrate(
      root,
      repo,
      child,
      next.currentSnapshotCommit,
      diff.currentSnapshotCommit,
    ),
  ).toMatchObject({ status: 'integrated' })
  expect(await readFile(join(repo, 'new.txt'), 'utf8')).toBe('worker update\n')
}, 30_000)

it('returns conflicts while preserving parent working files and index', async () => {
  const workspace = await manager.isolate(root, repo, 'child')
  if (workspace.kind !== 'managed-worktree') throw new Error('expected managed workspace')
  const child = { ...root, id: 'child', parentSessionId: root.id, workspace }
  await writeFile(join(workspace.path, 'file.txt'), 'worker\n')
  await writeFile(join(repo, 'file.txt'), 'parent\n')
  const index = await readFile(join(repo, '.git', 'index'))
  const diff = (await manager.diff(child, false)) as { currentSnapshotCommit: string }
  expect(await manager.integrate(root, repo, child, diff.currentSnapshotCommit)).toMatchObject({
    status: 'conflict',
    files: ['file.txt'],
  })
  expect(await readFile(join(repo, 'file.txt'), 'utf8')).toBe('parent\n')
  expect(await readFile(join(repo, '.git', 'index'))).toEqual(index)
}, 20_000)

it('names an isolated branch after the child title and releases a collision too', async () => {
  const id = 'sess_c2825b69-d75a-415c-aef6-1deba05b3ded'
  git(repo, 'branch', 'ari/edit-queued-message-c2825b69')
  const workspace = await manager.isolate(root, repo, id, 'Edit queued message')
  if (workspace.kind !== 'managed-worktree') throw new Error('expected managed workspace')
  expect(workspace.branch).toBe('ari/edit-queued-message-c2825b69-2')
  await manager.release(id)
  expect(git(repo, 'branch', '--list', 'ari/edit-queued-message-c2825b69')).toBe('')
  expect(git(repo, 'branch', '--list', workspace.branch)).toBe('')
}, 30_000)

it('releases the worktree, branch and orchestration refs and is idempotent', async () => {
  const workspace = await manager.isolate(root, repo, 'child')
  if (workspace.kind !== 'managed-worktree') throw new Error('expected managed workspace')
  const child = { ...root, id: 'child', parentSessionId: root.id, workspace }
  await writeFile(join(workspace.path, 'new.txt'), 'worker\n')
  await manager.diff(child, false)
  expect(git(repo, 'for-each-ref', 'refs/ari/orchestration/child/')).not.toBe('')
  await manager.release('child')
  await expect(readFile(join(workspace.path, 'new.txt'))).rejects.toThrow()
  expect(git(repo, 'worktree', 'list', '--porcelain')).not.toContain(workspace.path)
  expect(git(repo, 'branch', '--list', workspace.branch)).toBe('')
  expect(git(repo, 'for-each-ref', 'refs/ari/orchestration/child/')).toBe('')
  await manager.release('child')
  await manager.release('missing-child')
}, 30_000)

it('preserves shared dependency directories linked into a released worktree', async () => {
  const workspace = await manager.isolate(root, repo, 'linked-dependencies')
  if (workspace.kind !== 'managed-worktree') throw new Error('expected managed workspace')
  const shared = join(dir, 'shared dependencies')
  await mkdir(join(shared, '.bin'), { recursive: true })
  await writeFile(join(shared, '.bin', 'tool.cmd'), 'shared tool\n')
  await mkdir(join(workspace.path, 'packages', 'engine'), { recursive: true })
  const modules = join(workspace.path, 'node_modules')
  await mkdir(join(modules, '.pnpm', 'fixture', 'node_modules', 'fixture'), { recursive: true })
  await writeFile(
    join(modules, '.pnpm', 'fixture', 'node_modules', 'fixture', 'index.js'),
    'export {}\n',
  )
  await symlink(shared, join(modules, 'shared'), process.platform === 'win32' ? 'junction' : 'dir')
  await symlink(
    shared,
    join(workspace.path, 'packages', 'engine', 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir',
  )

  await manager.release('linked-dependencies')
  expect(await readFile(join(shared, '.bin', 'tool.cmd'), 'utf8')).toBe('shared tool\n')
  expect(git(repo, 'worktree', 'list', '--porcelain')).not.toContain(workspace.path)
  await expect(fs.lstat(workspace.path)).rejects.toMatchObject({ code: 'ENOENT' })
  await manager.release('linked-dependencies')
}, 30_000)

it('removes remaining files even when Git reports a successful removal', async () => {
  const workspace = await manager.isolate(root, repo, 'leftovers')
  if (workspace.kind !== 'managed-worktree') throw new Error('expected managed workspace')
  await mkdir(join(workspace.path, 'node_modules', 'fixture'), { recursive: true })
  await writeFile(join(workspace.path, 'node_modules', 'fixture', 'index.js'), 'fixture\n')
  vi.spyOn(manager.git, 'removeWorktree').mockResolvedValue({ ok: true, value: undefined })
  const remove = vi.mocked(fs.rm)
  await manager.release('leftovers')
  expect(remove).toHaveBeenCalledWith(
    workspace.path,
    expect.objectContaining({ maxRetries: 6, retryDelay: 200 }),
  )
  await expect(fs.lstat(workspace.path)).rejects.toMatchObject({ code: 'ENOENT' })
}, 30_000)

it('retries a failed removal on the next manager, including Git refs after .git is gone', async () => {
  const workspace = await manager.isolate(root, repo, 'retry-child')
  if (workspace.kind !== 'managed-worktree') throw new Error('expected managed workspace')
  vi.spyOn(manager.git, 'removeWorktree').mockImplementation(async () => {
    await rm(join(workspace.path, '.git'))
    return { ok: true, value: undefined }
  })
  vi.mocked(fs.rm).mockImplementation(async (path, options) => {
    if (path === workspace.path) throw Object.assign(new Error('busy'), { code: 'EBUSY' })
    return actualFs.rm(path, options)
  })
  await expect(manager.release('retry-child')).rejects.toMatchObject({ code: 'EBUSY' })
  const pending = JSON.parse(
    await readFile(join(manager.rootDir, '.pending-releases.json'), 'utf8'),
  ) as Record<string, string[]>
  expect(pending['retry-child']?.map((path) => resolve(path))).toEqual([repo])
  vi.restoreAllMocks()
  vi.mocked(fs.rm).mockImplementation(actualFs.rm)
  const stop = vi.fn(async () => undefined)
  await new ManagedWorkspaces(manager.rootDir).retryReleases(stop)
  expect(stop).toHaveBeenCalledWith('retry-child')
  await expect(fs.lstat(workspace.path)).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(fs.lstat(join(manager.rootDir, '.pending-releases.json'))).rejects.toMatchObject({
    code: 'ENOENT',
  })
  expect(git(repo, 'branch', '--list', workspace.branch)).toBe('')
  expect(git(repo, 'for-each-ref', 'refs/ari/orchestration/retry-child/')).toBe('')
  expect(git(repo, 'worktree', 'list', '--porcelain')).not.toContain(
    workspace.path.replaceAll('\\', '/'),
  )
}, 30_000)

it('sweeps only unregistered orphans while preserving live folders and external junction targets', async () => {
  const workspace = await manager.isolate(root, repo, 'registered-orphan')
  if (workspace.kind !== 'managed-worktree') throw new Error('expected managed workspace')
  await rm(join(workspace.path, '.git'))
  const project = join(manager.rootDir, root.projectId)
  const orphan = join(project, 'old-child')
  const live = join(project, 'live-child')
  const external = join(dir, 'external')
  for (const path of [orphan, live, external]) await mkdir(path, { recursive: true })
  await writeFile(join(external, 'keep.txt'), 'keep\n')
  await writeFile(join(orphan, 'leftover.txt'), 'old\n')
  await writeFile(join(live, 'keep.txt'), 'live\n')
  await symlink(external, join(orphan, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
  await symlink(
    external,
    join(project, 'external-child'),
    process.platform === 'win32' ? 'junction' : 'dir',
  )
  await symlink(
    external,
    join(manager.rootDir, 'external-project'),
    process.platform === 'win32' ? 'junction' : 'dir',
  )
  const old = new Date(Date.now() - 10 * 60_000)
  await utimes(orphan, old, old)
  await utimes(live, old, old)
  await manager.sweepOrphans(async (id) => id === 'live-child', [repo])
  await expect(fs.lstat(orphan)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readFile(join(live, 'keep.txt'), 'utf8')).toBe('live\n')
  expect(await readFile(join(external, 'keep.txt'), 'utf8')).toBe('keep\n')
  expect((await fs.lstat(workspace.path)).isDirectory()).toBe(true)
  await manager.release('external-child')
  await expect(fs.lstat(join(project, 'external-child'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readFile(join(external, 'keep.txt'), 'utf8')).toBe('keep\n')
  await expect(manager.release('../external')).rejects.toMatchObject({ code: 'invalid_request' })
}, 30_000)

it('skips failed repositories without aborting the orphan sweep or losing known registrations', async () => {
  const project = join(manager.rootDir, root.projectId)
  const registered = join(project, 'registered')
  const orphan = join(project, 'orphan')
  await mkdir(registered, { recursive: true })
  await mkdir(orphan)
  const old = new Date(Date.now() - 10 * 60_000)
  await utimes(orphan, old, old)
  const failure = {
    ok: false as const,
    error: { code: 'command_failed' as const, message: 'unavailable' },
  }
  const isRepo = vi
    .spyOn(manager.git, 'isRepo')
    .mockResolvedValueOnce(failure)
    .mockResolvedValue({ ok: true, value: true })
  const list = vi
    .spyOn(manager.git, 'listWorktrees')
    .mockResolvedValueOnce(failure)
    .mockResolvedValueOnce({
      ok: true,
      value: [
        {
          path: registered,
          head: '',
          branch: null,
          bare: false,
          detached: false,
        },
      ],
    })
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  try {
    await manager.sweepOrphans(async () => false, ['missing', 'broken', repo])
    expect(isRepo).toHaveBeenCalledTimes(3)
    expect(list).toHaveBeenCalledTimes(2)
    expect(warn).toHaveBeenCalledTimes(2)
    expect((await fs.lstat(registered)).isDirectory()).toBe(true)
    await expect(fs.lstat(orphan)).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    isRepo.mockRestore()
    list.mockRestore()
    warn.mockRestore()
  }
})

it('keeps fresh folders and rechecks live session ids immediately before removal', async () => {
  const project = join(manager.rootDir, root.projectId)
  const fresh = join(project, 'fresh-spawn')
  const raced = join(project, 'raced-spawn')
  const orphan = join(project, 'old-orphan')
  for (const path of [fresh, raced, orphan]) await mkdir(path, { recursive: true })
  const old = new Date(Date.now() - 10 * 60_000)
  for (const path of [raced, orphan]) await utimes(path, old, old)
  let checks = 0
  await manager.sweepOrphans(async (id) => id === 'raced-spawn' && ++checks === 2, [])
  expect(checks).toBe(2)
  expect((await fs.lstat(fresh)).isDirectory()).toBe(true)
  expect((await fs.lstat(raced)).isDirectory()).toBe(true)
  await expect(fs.lstat(orphan)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('aborts an orphan sweep while repository inspection is in flight', async () => {
  const orphan = join(manager.rootDir, root.projectId, 'old-orphan')
  await mkdir(orphan, { recursive: true })
  const old = new Date(Date.now() - 10 * 60_000)
  await utimes(orphan, old, old)
  const controller = new AbortController()
  const inspect = vi.spyOn(manager.git, 'isRepo').mockImplementationOnce(async () => {
    controller.abort()
    return { ok: true, value: false }
  })
  try {
    await manager.sweepOrphans(async () => false, [repo], controller.signal)
    expect((await fs.lstat(orphan)).isDirectory()).toBe(true)
  } finally {
    inspect.mockRestore()
  }
})

it('prunes snapshots keeping only the current commit', async () => {
  const workspace = await manager.isolate(root, repo, 'child')
  if (workspace.kind !== 'managed-worktree') throw new Error('expected managed workspace')
  const child = { ...root, id: 'child', parentSessionId: root.id, workspace }
  await writeFile(join(workspace.path, 'new.txt'), 'v1\n')
  const first = (await manager.diff(child, false)) as { currentSnapshotCommit: string }
  await writeFile(join(workspace.path, 'new.txt'), 'v2\n')
  const second = (await manager.diff(child, false)) as { currentSnapshotCommit: string }
  expect(second.currentSnapshotCommit).not.toBe(first.currentSnapshotCommit)
  await manager.pruneSnapshots('child', second.currentSnapshotCommit)
  const snapshots = git(
    repo,
    'for-each-ref',
    '--format=%(refname)',
    'refs/ari/orchestration/child/snapshots/',
  )
    .split('\n')
    .filter(Boolean)
  expect(snapshots).toEqual([
    `refs/ari/orchestration/child/snapshots/${second.currentSnapshotCommit}`,
  ])
  expect(git(repo, 'rev-parse', '--verify', 'refs/ari/orchestration/child/base')).toBeTruthy()
  expect(git(repo, 'rev-parse', '--verify', 'refs/ari/orchestration/child/current')).toBe(
    second.currentSnapshotCommit,
  )
}, 30_000)

it('leaves a single snapshot ref after many diffs and prune', async () => {
  const workspace = await manager.isolate(root, repo, 'child')
  if (workspace.kind !== 'managed-worktree') throw new Error('expected managed workspace')
  const child = { ...root, id: 'child', parentSessionId: root.id, workspace }
  let current = ''
  for (let i = 0; i < 5; i++) {
    await writeFile(join(workspace.path, 'new.txt'), `v${i}\n`)
    current = ((await manager.diff(child, false)) as { currentSnapshotCommit: string })
      .currentSnapshotCommit
  }
  await manager.pruneSnapshots('child', current)
  const snapshots = git(
    repo,
    'for-each-ref',
    '--format=%(refname)',
    'refs/ari/orchestration/child/snapshots/',
  )
    .split('\n')
    .filter(Boolean)
  expect(snapshots).toEqual([`refs/ari/orchestration/child/snapshots/${current}`])
}, 30_000)
