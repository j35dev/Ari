import { execFileSync } from 'node:child_process'
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DIFF_MAX_BYTES, GitService } from './git-service'

let gitAvailable = true
try {
  execFileSync('git', ['--version'], { stdio: 'ignore' })
} catch {
  gitAvailable = false
}

const suite = gitAvailable ? describe : describe.skip

const service = new GitService()

let dirs: string[] = []

beforeEach(() => {
  dirs = []
})

afterEach(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

async function makeDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' })
}

async function initRepo(): Promise<string> {
  const dir = await makeDir('ari-git-')
  try {
    git(dir, 'init', '-b', 'main')
  } catch {
    git(dir, 'init')
  }
  git(dir, 'config', 'user.email', 'test@ari.dev')
  git(dir, 'config', 'user.name', 'Ari Tests')
  git(dir, 'config', 'core.autocrlf', 'false')
  git(dir, 'config', 'commit.gpgsign', 'false')
  await writeFile(join(dir, 'fixture.txt'), 'line-one\n', 'utf8')
  await writeFile(join(dir, 'extra.txt'), 'extra\n', 'utf8')
  git(dir, 'add', '.')
  git(dir, 'commit', '-m', 'fixture')
  return dir
}

suite('GitService', () => {
  it('detects repos vs plain directories', async () => {
    const repo = await initRepo()
    const plain = await makeDir('ari-plain-')

    const inRepo = await service.isRepo(repo)
    expect(inRepo).toEqual({ ok: true, value: true })

    const outside = await service.isRepo(plain)
    expect(outside).toEqual({ ok: true, value: false })
  })

  it('parses porcelain v2 status into branch and typed entries', async () => {
    const dir = await initRepo()
    await writeFile(join(dir, 'fixture.txt'), 'line-one-edited\n', 'utf8')
    await writeFile(join(dir, 'new.txt'), 'new\n', 'utf8')
    git(dir, 'add', 'new.txt')
    await rm(join(dir, 'extra.txt'))
    git(dir, 'add', '-A', 'extra.txt')
    await writeFile(join(dir, 'stray.txt'), 'stray\n', 'utf8')

    const result = await service.status(dir)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(['main', 'master']).toContain(result.value.branch)

    const byPath = new Map(result.value.files.map((f) => [f.path, f]))
    expect(byPath.get('fixture.txt')).toMatchObject({ staged: false, kind: 'modified' })
    expect(byPath.get('new.txt')).toMatchObject({ staged: true, kind: 'added' })
    expect(byPath.get('extra.txt')).toMatchObject({ staged: true, kind: 'deleted' })
    expect(byPath.get('stray.txt')).toMatchObject({ staged: false, kind: 'untracked' })
  })

  it('classifies staged renames via format-2 entries', async () => {
    const dir = await initRepo()
    git(dir, 'mv', 'extra.txt', 'renamed.txt')

    const result = await service.status(dir)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const entry = result.value.files.find((f) => f.path === 'renamed.txt')
    expect(entry).toMatchObject({ staged: true, kind: 'renamed' })
  })

  it('reports an empty file list on a clean repo', async () => {
    const dir = await initRepo()
    const result = await service.status(dir)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(['main', 'master']).toContain(result.value.branch)
    expect(result.value.files).toEqual([])
  })

  it('captures, lists, and diffs checkpoints per turn', async () => {
    const dir = await initRepo()
    const cp1 = await service.captureCheckpoint(dir, 'sess-1', 'turn-01')
    expect(cp1).toEqual({ ok: true, value: 'refs/ari/sess-1/turn-01' })

    await writeFile(join(dir, 'fixture.txt'), 'turn-two-change\n', 'utf8')
    git(dir, 'add', '-A')
    git(dir, 'commit', '-m', 'turn two')
    const cp2 = await service.captureCheckpoint(dir, 'sess-1', 'turn-02')
    expect(cp2.ok).toBe(true)

    const list = await service.listCheckpoints(dir, 'sess-1')
    expect(list.ok).toBe(true)
    if (!list.ok) return
    expect(list.value.map((c) => c.ref)).toEqual([
      'refs/ari/sess-1/turn-01',
      'refs/ari/sess-1/turn-02',
    ])
    expect(list.value[0]?.oid).toMatch(/^[0-9a-f]{40}$/)

    const diff1 = await service.diffForRef(dir, 'refs/ari/sess-1/turn-01')
    expect(diff1.ok).toBe(true)
    if (diff1.ok) expect(diff1.value).toContain('+turn-two-change')

    const diff2 = await service.diffForRef(dir, 'refs/ari/sess-1/turn-02')
    expect(diff2.ok).toBe(true)
    if (diff2.ok) expect(diff2.value).not.toContain('+turn-two-change')
  })

  it('resolves captureCheckpoint to null outside a repo', async () => {
    const plain = await makeDir('ari-plain-')
    const result = await service.captureCheckpoint(plain, 'sess-x', 'turn-01')
    expect(result).toEqual({ ok: true, value: null })
  })

  it('revert restores tracked state at the checkpoint and keeps untracked files', async () => {
    const dir = await initRepo()
    const cp = await service.captureCheckpoint(dir, 'sess-r', 'turn-01')
    expect(cp.ok).toBe(true)

    await writeFile(join(dir, 'fixture.txt'), 'rewritten\n', 'utf8')
    await rm(join(dir, 'extra.txt'))
    await writeFile(join(dir, 'untracked.txt'), 'keep me\n', 'utf8')

    const reverted = await service.revertToRef(dir, 'refs/ari/sess-r/turn-01')
    expect(reverted.ok).toBe(true)

    expect(await readFile(join(dir, 'fixture.txt'), 'utf8')).toBe('line-one\n')
    expect(await readFile(join(dir, 'extra.txt'), 'utf8')).toBe('extra\n')
    expect(await readFile(join(dir, 'untracked.txt'), 'utf8')).toBe('keep me\n')

    const status = await service.status(dir)
    expect(status.ok).toBe(true)
    if (!status.ok) return
    const byPath = new Map(status.value.files.map((f) => [f.path, f]))
    expect(byPath.get('untracked.txt')).toBeDefined()
    expect(byPath.has('fixture.txt')).toBe(false)
  })

  it('fails diffs beyond the 512KB cap with diff_too_large', async () => {
    const dir = await initRepo()
    await appendFile(join(dir, 'fixture.txt'), 'y'.repeat(DIFF_MAX_BYTES + 4096), 'utf8')

    const result = await service.diffForRef(dir, 'HEAD')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('diff_too_large')
  })

  it('rejects unsafe revisions and malformed checkpoint ids', async () => {
    const dir = await initRepo()

    const badDiff = await service.diffForRef(dir, '--all')
    expect(!badDiff.ok && badDiff.error.code).toBe('invalid_ref')

    const badRevert = await service.revertToRef(dir, '../elsewhere')
    expect(!badRevert.ok && badRevert.error.code).toBe('invalid_ref')

    const badCapture = await service.captureCheckpoint(dir, 'bad id', 'turn-01')
    expect(!badCapture.ok && badCapture.error.code).toBe('invalid_ref')

    const badList = await service.listCheckpoints(dir, '..')
    expect(!badList.ok && badList.error.code).toBe('invalid_ref')
  })

  it('pruneCheckpoints keeps the newest N refs and deletes the excess', async () => {
    const dir = await initRepo()
    for (let i = 1; i <= 5; i++) {
      await service.captureCheckpoint(dir, 'sess-gc', `turn-0${i}`)
    }

    const pruned = await service.pruneCheckpoints(dir, 'sess-gc', 3)
    expect(pruned.ok).toBe(true)
    if (pruned.ok) expect(pruned.value).toHaveLength(2)

    const list = await service.listCheckpoints(dir, 'sess-gc')
    expect(list.ok).toBe(true)
    if (list.ok) {
      expect(list.value).toHaveLength(3)
      // Newest survive (monotonic turn ids ⇒ refname sort is recency order).
      expect(list.value.filter((c) => c.ref.endsWith('turn-03'))).toHaveLength(1)
      expect(list.value.some((c) => c.ref.endsWith('turn-01'))).toBe(false)
      expect(list.value.some((c) => c.ref.endsWith('turn-02'))).toBe(false)
      expect(list.value.some((c) => c.ref.endsWith('turn-04'))).toBe(true)
      expect(list.value.some((c) => c.ref.endsWith('turn-05'))).toBe(true)
    }
  })

  it('pruneCheckpoints is a no-op at or under the cap and rejects invalid caps', async () => {
    const dir = await initRepo()
    await service.captureCheckpoint(dir, 'sess-gc2', 'turn-01')
    await service.captureCheckpoint(dir, 'sess-gc2', 'turn-02')

    const underCap = await service.pruneCheckpoints(dir, 'sess-gc2', 5)
    expect(underCap.ok && underCap.value).toEqual([])

    const exactCap = await service.pruneCheckpoints(dir, 'sess-gc2', 2)
    expect(exactCap.ok && exactCap.value).toEqual([])
    const still = await service.listCheckpoints(dir, 'sess-gc2')
    if (still.ok) expect(still.value).toHaveLength(2)

    const badCap = await service.pruneCheckpoints(dir, 'sess-gc2', -1)
    expect(!badCap.ok && badCap.error.code).toBe('invalid_ref')

    const fracCap = await service.pruneCheckpoints(dir, 'sess-gc2', 1.5)
    expect(!fracCap.ok && fracCap.error.code).toBe('invalid_ref')
  })
})
