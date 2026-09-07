import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { Session } from '@ari/contracts/session'
import { ManagedWorkspaces } from './managed-workspaces'

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
