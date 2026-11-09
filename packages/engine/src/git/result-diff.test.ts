import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Session } from '@ari/contracts/session'
import { ManagedWorkspaces } from './managed-workspaces'
import { RepositoryGit } from './repository-git'

let dir: string, repo: string, manager: ManagedWorkspaces, child: Session
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  }).trim()
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ari-result-diff-'))
  repo = join(dir, 'repo')
  await mkdir(repo)
  git(repo, 'init', '-q')
  git(repo, 'config', 'core.autocrlf', 'false')
  git(repo, 'config', 'user.name', 'Test')
  git(repo, 'config', 'user.email', 'test@example.com')
  await writeFile(join(repo, 'file.txt'), 'base\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-qm', 'base')
  const parent: Session = {
    id: 'root',
    projectId: 'p',
    title: 'Root',
    driverKind: 'claude',
    modelId: null,
    permissionMode: 'ask',
    status: 'idle',
    createdAt: 1,
    updatedAt: 1,
  }
  manager = new ManagedWorkspaces(join(dir, 'workers'))
  const workspace = await manager.isolate(parent, repo, 'child')
  child = { ...parent, id: 'child', parentSessionId: 'root', workspace }
}, 60_000)
afterEach(async () => {
  vi.restoreAllMocks()
  await rm(dir, { recursive: true, force: true, maxRetries: 3 })
})
const cwd = () => {
  if (child.workspace?.kind !== 'managed-worktree') throw new Error('expected isolated workspace')
  return child.workspace.path
}

it('keeps a small selected file reviewable above 2 MB aggregate and never reads the aggregate patch', async () => {
  await writeFile(join(cwd(), 'file.txt'), 'selected small change\n')
  for (let at = 0; at < 5; at++)
    await writeFile(join(cwd(), `large-${at}.txt`), 'large line\n'.repeat(60_000))
  const snapshot = (await manager.diff(child, false)).currentSnapshotCommit
  const base = child.workspace!.kind === 'managed-worktree' ? child.workspace!.baseCommit : ''
  // Reproduce the previous preview cutoff against actual Git output.
  expect(git(cwd(), 'diff', base, snapshot, '--').length).toBeGreaterThan(2_000_000)
  const run = vi.spyOn(RepositoryGit.prototype, 'run')
  const capture = vi.spyOn(manager, 'snapshot')
  const before = git(cwd(), 'status', '--porcelain=v2')
  const index = git(cwd(), 'write-tree')
  const refs = git(cwd(), 'show-ref')
  const manifest = await manager.readResultDiff(child, snapshot, { kind: 'files' })
  expect(manifest.kind).toBe('files')
  expect(manifest).not.toHaveProperty('patch')
  const patch = await manager.readResultDiff(child, snapshot, {
    kind: 'file',
    baseCommit: base,
    path: 'file.txt',
  })
  expect(patch).toMatchObject({ kind: 'file', currentSnapshotCommit: snapshot, baseCommit: base })
  if (patch.kind !== 'file') throw new Error('expected file')
  expect(patch.patch).toContain('+selected small change')
  const patches = run.mock.calls.filter(([args]) => args.includes('-U3'))
  expect(patches).toHaveLength(1)
  expect(patches[0]![0].slice(-2)).toEqual(['--', 'file.txt'])
  expect(
    run.mock.calls
      .filter(([args]) => args.includes('diff'))
      .every(
        ([args]) =>
          args.includes('--name-status') || args.includes('--numstat') || args.includes('-U3'),
      ),
  ).toBe(true)
  expect(capture).not.toHaveBeenCalled()
  expect(git(cwd(), 'status', '--porcelain=v2')).toBe(before)
  expect(git(cwd(), 'write-tree')).toBe(index)
  expect(git(cwd(), 'show-ref')).toBe(refs)
}, 60_000)

it('reads historical immutable contents after current snapshot and working files change', async () => {
  await writeFile(join(cwd(), 'file.txt'), 'historical\n')
  const first = (await manager.diff(child, false)).currentSnapshotCommit
  const manifest = await manager.readResultDiff(child, first, { kind: 'files' })
  await writeFile(join(cwd(), 'file.txt'), 'current\n')
  const second = (await manager.diff(child, false)).currentSnapshotCommit
  expect(second).not.toBe(first)
  const patch = await manager.readResultDiff(child, first, {
    kind: 'file',
    baseCommit: manifest.baseCommit,
    path: 'file.txt',
  })
  if (patch.kind !== 'file') throw new Error('expected file')
  expect(patch.patch).toContain('+historical')
  expect(patch.patch).not.toContain('+current')
  if (child.workspace?.kind !== 'managed-worktree') throw new Error('expected isolated workspace')
  await expect(
    manager.readResultDiff(
      { ...child, workspace: { ...child.workspace, baseCommit: second } },
      first,
      { kind: 'files' },
    ),
  ).rejects.toMatchObject({ code: 'stale_snapshot' })
  await expect(
    manager.readResultDiff(child, first, { kind: 'file', baseCommit: second, path: 'file.txt' }),
  ).rejects.toMatchObject({ code: 'stale_snapshot' })
}, 60_000)

it('preserves renamed literal paths, deletions, binary and empty comparisons', async () => {
  await writeFile(join(repo, 'delete.txt'), 'delete me\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-qm', 'another parent file')
  // file.txt was in the original isolated base and can be recognized as a rename.
  await rm(join(cwd(), 'file.txt'))
  await writeFile(join(cwd(), 'renamed [日本語].txt'), 'base\n')
  await writeFile(join(cwd(), 'delete.txt'), 'delete me\n')
  git(cwd(), 'add', '.')
  git(cwd(), 'commit', '-qm', 'worker rename')
  await writeFile(join(cwd(), 'binary.dat'), Buffer.from([0, 255, 0]))
  const snapshot = (await manager.diff(child, false)).currentSnapshotCommit
  const manifest = await manager.readResultDiff(child, snapshot, { kind: 'files' })
  if (manifest.kind !== 'files') throw new Error('expected files')
  expect(manifest.files).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        path: 'renamed [日本語].txt',
        oldPath: 'file.txt',
        status: 'renamed',
      }),
      expect.objectContaining({ path: 'binary.dat', binary: true }),
    ]),
  )
  const rename = await manager.readResultDiff(child, snapshot, {
    kind: 'file',
    baseCommit: manifest.baseCommit,
    path: 'renamed [日本語].txt',
    oldPath: 'file.txt',
  })
  if (rename.kind !== 'file') throw new Error('expected file')
  expect(rename.patch).toContain('rename from file.txt')
  const binary = await manager.readResultDiff(child, snapshot, {
    kind: 'file',
    baseCommit: manifest.baseCommit,
    path: 'binary.dat',
  })
  if (binary.kind !== 'file') throw new Error('expected file')
  expect(binary.patch).toContain('Binary files')
  await rm(join(cwd(), 'renamed [日本語].txt'))
  const deletionSnapshot = (await manager.diff(child, false)).currentSnapshotCommit
  const deletion = await manager.readResultDiff(child, deletionSnapshot, {
    kind: 'file',
    baseCommit: manifest.baseCommit,
    path: 'file.txt',
  })
  if (deletion.kind !== 'file') throw new Error('expected file')
  expect(deletion.patch).toContain('deleted file mode')
}, 60_000)

it('bounds one-file output and reports unavailable snapshots and invalid selections', async () => {
  const empty = (await manager.diff(child, false)).currentSnapshotCommit
  expect(await manager.readResultDiff(child, empty, { kind: 'files' })).toMatchObject({
    files: [],
    totals: { files: 0 },
  })
  await expect(
    manager.readResultDiff(child, empty, { kind: 'files' }, AbortSignal.abort()),
  ).rejects.toMatchObject({ code: 'unavailable', message: 'Git request cancelled.' })
  await writeFile(join(cwd(), 'file.txt'), 'large\n'.repeat(200_000))
  const snapshot = (await manager.diff(child, false)).currentSnapshotCommit
  const manifest = await manager.readResultDiff(child, snapshot, { kind: 'files' })
  await expect(
    manager.readResultDiff(child, snapshot, {
      kind: 'file',
      baseCommit: manifest.baseCommit,
      path: 'file.txt',
    }),
  ).rejects.toMatchObject({ code: 'too-large' })
  await expect(
    manager.readResultDiff(child, snapshot, {
      kind: 'file',
      baseCommit: manifest.baseCommit,
      path: 'unknown',
    }),
  ).rejects.toMatchObject({ code: 'invalid_file' })
  await expect(
    manager.readResultDiff(child, snapshot, {
      kind: 'file',
      baseCommit: manifest.baseCommit,
      path: 'file.txt',
      oldPath: 'other',
    }),
  ).rejects.toMatchObject({ code: 'invalid_file' })
  git(cwd(), 'update-ref', '-d', `refs/ari/orchestration/child/snapshots/${snapshot}`)
  await expect(manager.readResultDiff(child, snapshot, { kind: 'files' })).rejects.toMatchObject({
    code: 'snapshot_unavailable',
  })
  await expect(
    manager.readResultDiff({ ...child, workspace: { kind: 'project' } }, empty, { kind: 'files' }),
  ).rejects.toMatchObject({ code: 'scope_denied' })
}, 60_000)
