import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import type * as FsPromises from 'node:fs/promises'
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GitReviewService } from './git-review'
import { GitService } from './git-service'

// CopyFileW preserves mtime on Windows. Exercise the POSIX copy behavior on
// every runner using real files and Git, without mocking stat or Git results.
vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof FsPromises>()
  return {
    ...fs,
    copyFile: async (...args: Parameters<typeof fs.copyFile>) => {
      await fs.copyFile(...args)
      const now = new Date()
      await fs.utimes(args[1], now, now)
    },
  }
})

const roots: string[] = []
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim()
const blob = (cwd: string, ref: string, path: string) =>
  execFileSync('git', ['cat-file', 'blob', `${ref}:${path}`], { cwd, windowsHide: true })

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })),
  )
})

async function repository(nested = false) {
  const root = await mkdtemp(join(tmpdir(), 'ari-racy-snapshot-'))
  roots.push(root)
  git(root, 'init', '-b', 'main')
  git(root, 'config', 'user.name', 'Ari tests')
  git(root, 'config', 'user.email', 'test@ari.local')
  git(root, 'config', 'commit.gpgsign', 'false')
  git(root, 'config', 'core.autocrlf', 'false')
  // The fixture reads the documented v2 index layout, including cached stats.
  git(root, 'config', 'index.version', '2')
  const cwd = nested ? join(root, 'nested') : root
  if (nested) await mkdir(cwd)
  await writeFile(join(cwd, 'app.ts'), 'one\n')
  await writeFile(join(cwd, 'other.ts'), 'old\n')
  await writeFile(join(root, 'script.sh'), 'echo base\n')
  git(root, 'add', '.')
  git(root, 'commit', '-m', 'base')
  await chmod(join(root, 'script.sh'), 0o755)
  git(root, 'update-index', '--chmod=+x', 'script.sh')
  git(root, 'write-tree')
  return { root, cwd, prefix: nested ? 'nested/' : '', index: join(root, '.git', 'index') }
}

function entries(index: Buffer) {
  expect(index.subarray(0, 4).toString()).toBe('DIRC')
  expect(index.readUInt32BE(4)).toBe(2)
  const offsets = new Map<string, number>()
  let at = 12
  for (let entry = 0; entry < index.readUInt32BE(8); entry++) {
    const flags = index.readUInt16BE(at + 60)
    expect(flags & 0x4000).toBe(0)
    const end = index.indexOf(0, at + 62)
    if ((flags & 0x3000) === 0) offsets.set(index.subarray(at + 62, end).toString(), at)
    at += Math.ceil((end + 1 - at) / 8) * 8
  }
  return offsets
}

async function racilyClean(
  repo: Awaited<ReturnType<typeof repository>>,
  contents: [string, string],
  timestamp: number,
) {
  const original = await readFile(repo.index)
  const paths = ['app.ts', 'other.ts'].map((path) => repo.prefix + path)
  for (const [at, path] of paths.entries()) {
    expect(blob(repo.root, '', path).length).toBe(Buffer.byteLength(contents[at]!))
    await writeFile(join(repo.root, path), contents[at]!)
    await utimes(join(repo.root, path), timestamp, timestamp)
  }
  git(repo.root, 'add', '--', ...paths)
  const refreshed = await readFile(repo.index)
  const oldEntries = entries(original)
  const newEntries = entries(refreshed)
  for (const path of paths) {
    const oldAt = oldEntries.get(path)!
    const newAt = newEntries.get(path)!
    // Keep the original staged OIDs, modes, stages and cache tree; use real
    // Git stat data for the edited, equal-size files to force a cached match.
    refreshed.copy(original, oldAt, newAt, newAt + 24)
    refreshed.copy(original, oldAt + 28, newAt + 28, newAt + 40)
  }
  createHash('sha1')
    .update(original.subarray(0, -20))
    .digest()
    .copy(original, original.length - 20)
  await writeFile(repo.index, original)
  await utimes(repo.index, timestamp, timestamp)
  return original
}

describe('racy snapshot capture with fresh scratch-index mtimes', { timeout: 60_000 }, () => {
  it.each([1577836800, 1577836800.250123])(
    'captures exact equal-size edits at timestamp %s',
    async (timestamp) => {
      const repo = await repository()
      const index = await racilyClean(repo, ['two\n', 'old\n'], timestamp)
      const head = git(repo.root, 'rev-parse', 'HEAD')
      const scratch = join(repo.root, '.git', 'diagnostic-index')
      await copyFile(repo.index, scratch)
      expect((await stat(scratch)).mtimeMs).toBeGreaterThan((await stat(repo.index)).mtimeMs)
      const env = { ...process.env, GIT_INDEX_FILE: scratch }
      execFileSync('git', ['add', '--all'], { cwd: repo.root, env, windowsHide: true })
      const stale = execFileSync('git', ['write-tree'], {
        cwd: repo.root,
        env,
        encoding: 'utf8',
        windowsHide: true,
      }).trim()
      expect(blob(repo.root, stale, 'app.ts')).toEqual(Buffer.from('one\n'))
      expect(git(repo.root, '--no-optional-locks', 'diff-files', '--name-only')).toBe('app.ts')
      expect(await readFile(repo.index)).toEqual(index)

      const worktree = await new GitService().worktreeTree(repo.cwd)
      if (!worktree.ok) throw new Error(worktree.error.message)
      expect(blob(repo.root, worktree.value, 'app.ts')).toEqual(Buffer.from('two\n'))
      expect(await readFile(repo.index)).toEqual(index)

      const service = new GitReviewService(repo.cwd)
      const first = await service.manifest({ kind: 'working-tree' })
      expect(await readFile(repo.index)).toEqual(index)
      const secondIndex = await racilyClean(repo, ['two\n', 'now\n'], timestamp)
      const second = await new GitReviewService(repo.cwd).manifest({ kind: 'working-tree' })
      expect(await readFile(repo.index)).toEqual(secondIndex)
      const lastIndex = await racilyClean(repo, ['six\n', 'now\n'], timestamp)
      const third = await service.manifest({ kind: 'working-tree' })
      if (!first.ok || !second.ok || !third.ok) throw new Error('review unavailable')
      for (const [manifest, bytes] of [
        [first.value, 'two\n'],
        [second.value, 'two\n'],
        [third.value, 'six\n'],
      ] as const) {
        expect(manifest.files.map((file) => file.path)).toContain('app.ts')
        expect(blob(repo.root, manifest.headOid, 'app.ts')).toEqual(Buffer.from(bytes))
      }
      const app = (manifest: typeof first.value) =>
        manifest.files.find((file) => file.path === 'app.ts')!
      expect(app(first.value).contentId).toMatch(/^[a-f0-9]{64}$/)
      expect(app(second.value).contentId).toBe(app(first.value).contentId)
      expect(app(third.value).contentId).not.toBe(app(first.value).contentId)
      expect(app(third.value).additions).toBe(app(first.value).additions)
      expect(app(third.value).deletions).toBe(app(first.value).deletions)
      expect(second.value.id).not.toBe(first.value.id)
      expect(third.value.id).not.toBe(second.value.id)
      expect(second.value.reviewScopeId).toBe(first.value.reviewScopeId)
      expect(third.value.reviewScopeId).toBe(first.value.reviewScopeId)
      expect(blob(repo.root, second.value.headOid, 'other.ts')).toEqual(Buffer.from('now\n'))
      expect(blob(repo.root, first.value.headOid, 'other.ts')).toEqual(Buffer.from('old\n'))
      expect(await readFile(repo.index)).toEqual(lastIndex)
      expect(git(repo.root, 'rev-parse', 'HEAD')).toBe(head)
    },
  )

  it.each([false, true])(
    'captures checkpoints from nested=%s without changing staging',
    async (nested) => {
      const repo = await repository(nested)
      const staged = git(repo.root, 'write-tree')
      const index = await racilyClean(repo, ['two\n', 'now\n'], 1577836800.250123)
      const head = git(repo.root, 'rev-parse', 'HEAD')
      const checkpoint = await new GitService().captureCheckpoint(repo.cwd, 'racy', 'turn')
      if (!checkpoint.ok || checkpoint.value === null) throw new Error('checkpoint unavailable')
      expect(blob(repo.root, checkpoint.value, repo.prefix + 'app.ts')).toEqual(
        Buffer.from('two\n'),
      )
      expect(blob(repo.root, `${checkpoint.value}^`, repo.prefix + 'app.ts')).toEqual(
        Buffer.from('one\n'),
      )
      expect(git(repo.root, 'rev-parse', `${checkpoint.value}^^{tree}`)).toBe(staged)
      expect(git(repo.root, 'ls-tree', checkpoint.value, 'script.sh')).toMatch(/^100755 /)
      expect(await readFile(repo.index)).toEqual(index)
      expect(git(repo.root, 'rev-parse', 'HEAD')).toBe(head)
      if (nested) {
        const review = await new GitReviewService(repo.cwd).manifest({ kind: 'working-tree' })
        if (!review.ok) throw new Error(review.error.message)
        expect(review.value.files.map((file) => file.path)).toEqual(['app.ts', 'other.ts'])
        expect(blob(repo.root, review.value.headOid, 'nested/app.ts')).toEqual(Buffer.from('two\n'))
        expect(await readFile(repo.index)).toEqual(index)
      }
    },
  )

  it('captures conflict bytes without changing the real unmerged index or HEAD', async () => {
    const repo = await repository()
    const oid = git(repo.root, 'rev-parse', 'HEAD:app.ts')
    execFileSync('git', ['update-index', '--index-info'], {
      cwd: repo.root,
      input: [1, 2, 3].map((stage) => `100644 ${oid} ${stage}\tconflict.ts\n`).join(''),
      windowsHide: true,
    })
    await writeFile(join(repo.root, 'conflict.ts'), '<<<<<<< ours\n=======\n>>>>>>> theirs\n')
    const unmerged = git(repo.root, 'ls-files', '--unmerged')
    const index = await racilyClean(repo, ['two\n', 'now\n'], 1577836800)
    const head = git(repo.root, 'rev-parse', 'HEAD')
    const checkpoint = await new GitService().captureCheckpoint(repo.cwd, 'racy', 'conflict')
    if (!checkpoint.ok || checkpoint.value === null) throw new Error('checkpoint unavailable')
    expect(blob(repo.root, checkpoint.value, 'app.ts')).toEqual(Buffer.from('two\n'))
    expect(blob(repo.root, checkpoint.value, 'conflict.ts')).toEqual(
      await readFile(join(repo.root, 'conflict.ts')),
    )
    expect(
      git(repo.root, 'rev-list', '--parents', '-n', '1', checkpoint.value).split(' '),
    ).toHaveLength(1)
    expect(git(repo.root, 'ls-files', '--unmerged')).toBe(unmerged)
    expect(await readFile(repo.index)).toEqual(index)
    expect(git(repo.root, 'rev-parse', 'HEAD')).toBe(head)
  })
})
