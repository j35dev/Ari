import { execFileSync } from 'node:child_process'
import { appendFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newTypedId } from '@ari/shared/ids'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
  vi.unstubAllEnvs()
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

function gitOut(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
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

async function capture(dir: string, sessionId: string, turnId: string): Promise<string> {
  const captured = await service.captureCheckpoint(dir, sessionId, turnId)
  if (!captured.ok || captured.value === null) throw new Error('checkpoint not captured')
  return captured.value
}

async function listedRefs(dir: string, sessionId: string): Promise<string[]> {
  const list = await service.listCheckpoints(dir, sessionId)
  if (!list.ok) throw new Error(list.error.message)
  return list.value.map((c) => c.ref).sort()
}

suite('GitService', () => {
  // Every test here shells out to real git; under a fully parallel verify the
  // machine saturates and 5s (vitest default) is not enough for even `init`.
  const GIT_TIMEOUT = 30_000

  it('detects repos vs plain directories', { timeout: GIT_TIMEOUT }, async () => {
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
  }, 30000)

  it('resolves captureCheckpoint to null outside a repo', async () => {
    const plain = await makeDir('ari-plain-')
    const result = await service.captureCheckpoint(plain, 'sess-x', 'turn-01')
    expect(result).toEqual({ ok: true, value: null })
  })

  it('answers turn diffs with an empty string outside a repo instead of failing', async () => {
    const plain = await makeDir('ari-plain-')
    const result = await service.diffForRef(plain, 'refs/ari/sess-x/turn-01')
    expect(result).toEqual({ ok: true, value: '' })
  })

  it('revert restores the checkpointed working tree without moving HEAD or the index', async () => {
    const dir = await initRepo()
    await writeFile(join(dir, 'fixture.txt'), 'uncommitted\n', 'utf8')
    await writeFile(join(dir, 'kept.txt'), 'untracked before\n', 'utf8')
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' })
    const cp = await service.captureCheckpoint(dir, 'sess-r', 'turn-01')
    expect(cp.ok).toBe(true)

    await writeFile(join(dir, 'fixture.txt'), 'rewritten\n', 'utf8')
    await rm(join(dir, 'extra.txt'))
    await rm(join(dir, 'kept.txt'))
    await writeFile(join(dir, 'created.txt'), 'new since checkpoint\n', 'utf8')

    const reverted = await service.revertToRef(dir, 'refs/ari/sess-r/turn-01')
    expect(reverted.ok).toBe(true)

    expect(await readFile(join(dir, 'fixture.txt'), 'utf8')).toBe('uncommitted\n')
    expect(await readFile(join(dir, 'extra.txt'), 'utf8')).toBe('extra\n')
    expect(await readFile(join(dir, 'kept.txt'), 'utf8')).toBe('untracked before\n')
    await expect(readFile(join(dir, 'created.txt'), 'utf8')).rejects.toThrow()
    expect(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' })).toBe(head)

    const status = await service.status(dir)
    expect(status.ok).toBe(true)
    if (!status.ok) return
    expect(status.value.files).toEqual([
      { path: 'fixture.txt', staged: false, kind: 'modified' },
      { path: 'kept.txt', staged: false, kind: 'untracked' },
    ])
  })

  it('captures a checkpoint before the first commit', async () => {
    const dir = await makeDir('ari-git-')
    git(dir, 'init')
    await writeFile(join(dir, 'draft.txt'), 'draft\n', 'utf8')
    const cp = await service.captureCheckpoint(dir, 'sess-0', 'turn-01')
    expect(cp).toEqual({ ok: true, value: 'refs/ari/sess-0/turn-01' })
    await writeFile(join(dir, 'draft.txt'), 'changed\n', 'utf8')
    expect((await service.revertToRef(dir, 'refs/ari/sess-0/turn-01')).ok).toBe(true)
    expect(await readFile(join(dir, 'draft.txt'), 'utf8')).toBe('draft\n')
  })

  it('revert drops what the agent staged and keeps the pre-turn staging', async () => {
    const dir = await initRepo()
    await writeFile(join(dir, 'extra.txt'), 'user staged edit\n', 'utf8')
    await writeFile(join(dir, 'user.txt'), 'user staged file\n', 'utf8')
    git(dir, 'add', 'extra.txt', 'user.txt')
    const staged = gitOut(dir, 'diff', '--cached')
    expect((await service.captureCheckpoint(dir, 'sess-i', 'turn-01')).ok).toBe(true)

    await writeFile(join(dir, 'agent.txt'), 'agent work\n', 'utf8')
    git(dir, 'add', 'agent.txt')

    expect((await service.revertToRef(dir, 'refs/ari/sess-i/turn-01')).ok).toBe(true)

    await expect(readFile(join(dir, 'agent.txt'), 'utf8')).rejects.toThrow()
    expect(gitOut(dir, 'status', '--porcelain')).toBe('M  extra.txt\nA  user.txt\n')
    expect(gitOut(dir, 'diff', '--cached')).toBe(staged)
  })

  it('captures and reverts while the index has merge conflicts', async () => {
    const dir = await initRepo()
    git(dir, 'checkout', '-b', 'side')
    await writeFile(join(dir, 'fixture.txt'), 'side\n', 'utf8')
    git(dir, 'commit', '-am', 'side')
    git(dir, 'checkout', '-')
    await writeFile(join(dir, 'fixture.txt'), 'main\n', 'utf8')
    git(dir, 'commit', '-am', 'main')
    expect(() => git(dir, 'merge', 'side')).toThrow()
    const conflicted = await readFile(join(dir, 'fixture.txt'), 'utf8')
    expect((await service.captureCheckpoint(dir, 'sess-m', 'turn-01')).ok).toBe(true)

    await writeFile(join(dir, 'fixture.txt'), 'resolved by agent\n', 'utf8')

    expect((await service.revertToRef(dir, 'refs/ari/sess-m/turn-01')).ok).toBe(true)
    expect(await readFile(join(dir, 'fixture.txt'), 'utf8')).toBe(conflicted)
  })

  it('revert from a subdirectory workspace leaves the rest of the repo alone', async () => {
    const dir = await initRepo()
    const pkg = join(dir, 'pkg')
    await mkdir(pkg)
    await writeFile(join(pkg, 'a.txt'), 'pkg a\n', 'utf8')
    await writeFile(join(dir, 'root.txt'), 'root\n', 'utf8')
    git(dir, 'add', '.')
    git(dir, 'commit', '-m', 'pkg')
    expect((await service.captureCheckpoint(pkg, 'sess-p', 'turn-01')).ok).toBe(true)

    await writeFile(join(pkg, 'a.txt'), 'agent edit\n', 'utf8')
    await writeFile(join(pkg, 'new.txt'), 'agent file\n', 'utf8')
    git(pkg, 'add', 'new.txt')
    await writeFile(join(dir, 'user-notes.txt'), 'user notes\n', 'utf8')
    await writeFile(join(dir, 'root.txt'), 'root user edit\n', 'utf8')
    git(dir, 'add', 'root.txt')

    expect((await service.revertToRef(pkg, 'refs/ari/sess-p/turn-01')).ok).toBe(true)

    expect(await readFile(join(pkg, 'a.txt'), 'utf8')).toBe('pkg a\n')
    await expect(readFile(join(pkg, 'new.txt'), 'utf8')).rejects.toThrow()
    expect(await readFile(join(dir, 'user-notes.txt'), 'utf8')).toBe('user notes\n')
    expect(await readFile(join(dir, 'root.txt'), 'utf8')).toBe('root user edit\n')
    expect(gitOut(dir, 'status', '--porcelain')).toBe('M  root.txt\n?? user-notes.txt\n')
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

  it('pruneCheckpoints keeps the newest N by capture order and deletes the rest', async () => {
    const dir = await initRepo()
    const turnIds: string[] = []
    const refs: string[] = []
    for (let i = 0; i < 12; i++) {
      const turnId = newTypedId('turn')
      await writeFile(join(dir, 'a.txt'), `turn ${i}\n`)
      turnIds.push(turnId)
      refs.push(await capture(dir, 'sess-gc', turnId))
    }

    const pruned = await service.pruneCheckpoints(dir, 'sess-gc', turnIds, 5)
    expect(pruned.ok && [...pruned.value].sort()).toEqual(refs.slice(0, 7).sort())
    expect(await listedRefs(dir, 'sess-gc')).toEqual(refs.slice(-5).sort())
  }, 30000)

  it('pruneCheckpoints never deletes the just-captured ref', async () => {
    const dir = await initRepo()
    const turnIds: string[] = []
    const refs: string[] = []
    for (let round = 0; round < 20; round++) {
      const turnId = newTypedId('turn')
      turnIds.push(turnId)
      const ref = await capture(dir, 'sess-gc-latest', turnId)
      refs.push(ref)

      expect((await service.pruneCheckpoints(dir, 'sess-gc-latest', turnIds, 3)).ok).toBe(true)
      const listed = await listedRefs(dir, 'sess-gc-latest')
      expect(listed).toContain(ref)
      expect(listed).toEqual(refs.slice(-3).sort())
    }
  }, 30000)

  it('pruneCheckpoints keeps capture order for identical back-to-back captures (same second)', async () => {
    const dir = await initRepo()
    // Checkpoints are commits, so pin their dates to keep every capture in one second.
    vi.stubEnv('GIT_AUTHOR_DATE', '2026-01-01T00:00:00Z')
    vi.stubEnv('GIT_COMMITTER_DATE', '2026-01-01T00:00:00Z')
    const turnIds: string[] = []
    const refs: string[] = []
    for (let i = 0; i < 8; i++) {
      const turnId = newTypedId('turn')
      turnIds.push(turnId)
      refs.push(await capture(dir, 'sess-gc-same', turnId))
    }
    const oids = await service.listCheckpoints(dir, 'sess-gc-same')
    // Same tree, same object: nothing in git can tell these captures apart.
    expect(oids.ok && new Set(oids.value.map((c) => c.oid)).size).toBe(1)

    const pruned = await service.pruneCheckpoints(dir, 'sess-gc-same', turnIds, 3)
    expect(pruned.ok && [...pruned.value].sort()).toEqual(refs.slice(0, 5).sort())
    expect(await listedRefs(dir, 'sess-gc-same')).toEqual(refs.slice(-3).sort())
  }, 30000)

  it('pruneCheckpoints deletes an orphan ref missing from turnIds even under the cap', async () => {
    const dir = await initRepo()
    const [first, omitted, last] = [newTypedId('turn'), newTypedId('turn'), newTypedId('turn')]
    const kept = [await capture(dir, 'sess-gc-orphan', first)]
    const orphan = await capture(dir, 'sess-gc-orphan', omitted)
    kept.push(await capture(dir, 'sess-gc-orphan', last))

    const pruned = await service.pruneCheckpoints(dir, 'sess-gc-orphan', [first, last], 50)
    expect(pruned.ok && pruned.value).toEqual([orphan])
    expect(await listedRefs(dir, 'sess-gc-orphan')).toEqual(kept.sort())
  })

  it('pruneCheckpoints is a no-op at or under the cap and rejects invalid caps', async () => {
    const dir = await initRepo()
    const turnIds = [newTypedId('turn'), newTypedId('turn')]
    for (const turnId of turnIds) await capture(dir, 'sess-gc2', turnId)

    const underCap = await service.pruneCheckpoints(dir, 'sess-gc2', turnIds, 5)
    expect(underCap.ok && underCap.value).toEqual([])

    const exactCap = await service.pruneCheckpoints(dir, 'sess-gc2', turnIds, 2)
    expect(exactCap.ok && exactCap.value).toEqual([])
    const still = await service.listCheckpoints(dir, 'sess-gc2')
    if (still.ok) expect(still.value).toHaveLength(2)

    const zeroCap = await service.pruneCheckpoints(dir, 'sess-gc2', turnIds, 0)
    expect(!zeroCap.ok && zeroCap.error.code).toBe('invalid_ref')

    const badCap = await service.pruneCheckpoints(dir, 'sess-gc2', turnIds, -1)
    expect(!badCap.ok && badCap.error.code).toBe('invalid_ref')

    const fracCap = await service.pruneCheckpoints(dir, 'sess-gc2', turnIds, 1.5)
    expect(!fracCap.ok && fracCap.error.code).toBe('invalid_ref')
  })

  suite('GitService worktrees (M19.3)', () => {
    it('adds a linked worktree on a new branch, lists it, and removes it', async () => {
      const dir = await initRepo()
      const wt = join(dir, 'wt-roundtrip')

      const added = await service.addWorktree(dir, wt, 'ari/sess-rt')
      expect(added).toEqual({ ok: true, value: undefined })
      git(wt, 'rev-parse', '--verify', 'HEAD') // checkout actually materialized

      const list = await service.listWorktrees(dir)
      expect(list.ok).toBe(true)
      if (!list.ok) return
      const canonicalWt = (await realpath(wt)).replace(/\\/g, '/')
      const canonicalDir = (await realpath(dir)).replace(/\\/g, '/')
      const entry = list.value.find((w) => w.path.replace(/\\/g, '/') === canonicalWt)
      expect(entry?.branch).toBe('refs/heads/ari/sess-rt')
      expect(entry?.head).toMatch(/^[0-9a-f]{40}$/)
      expect(entry?.bare).toBe(false)
      expect(entry?.detached).toBe(false)
      // The main checkout row is always present too.
      expect(list.value.some((w) => w.path.replace(/\\/g, '/') === canonicalDir)).toBe(true)

      const removed = await service.removeWorktree(dir, wt)
      expect(removed).toEqual({ ok: true, value: undefined })
      const after = await service.listWorktrees(dir)
      expect(after.ok).toBe(true)
      if (after.ok) {
        expect(after.value.some((w) => w.path.replace(/\\/g, '/') === wt.replace(/\\/g, '/'))).toBe(
          false,
        )
      }
    }, 30000)

    it('removes dirty worktrees (--force) without touching the branch', async () => {
      const dir = await initRepo()
      const wt = join(dir, 'wt-dirty')
      const added = await service.addWorktree(dir, wt, 'ari/sess-dirty')
      expect(added.ok).toBe(true)
      await writeFile(join(wt, 'wip.txt'), 'half-done\n', 'utf8')

      const removed = await service.removeWorktree(dir, wt)
      expect(removed.ok).toBe(true)

      // The session branch survives the checkout removal.
      const branches = execFileSync('git', ['branch', '--list', 'ari/sess-dirty'], {
        cwd: dir,
        encoding: 'utf8',
      })
      expect(branches).toContain('ari/sess-dirty')
    }, 30000)

    it('rejects dash-prefixed paths and unsafe branch names', async () => {
      const dir = await initRepo()

      const badPath = await service.addWorktree(dir, '-oProxyCommand=x', 'ari/x')
      expect(!badPath.ok && badPath.error.code).toBe('invalid_ref')

      const badRemove = await service.removeWorktree(dir, '--force')
      expect(!badRemove.ok && badRemove.error.code).toBe('invalid_ref')

      for (const branch of ['-evil', '../escape', 'a..b']) {
        const badBranch = await service.addWorktree(dir, join(dir, 'wt-bad'), branch)
        expect(!badBranch.ok && badBranch.error.code).toBe('invalid_ref')
      }
      // Nothing was created by the rejected calls.
      const list = await service.listWorktrees(dir)
      if (list.ok) expect(list.value).toHaveLength(1)
    }, 30000)

    it('resolves the repo-local info/exclude path', async () => {
      const dir = await initRepo()
      const resolved = await service.infoExcludePath(dir)
      expect(resolved.ok).toBe(true)
      if (!resolved.ok) return
      expect(resolved.value.replace(/\\/g, '/')).toContain('.git/info/exclude')
    })
  })
})
