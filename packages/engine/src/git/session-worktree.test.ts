import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GitService } from './git-service'
import {
  ensureSessionWorktree,
  isValidSessionId,
  SESSION_WORKTREE_ROOT,
  sessionWorktreeBranch,
  sessionWorktreePath,
} from './session-worktree'

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

function gitOut(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

async function initRepo(): Promise<string> {
  const dir = await makeDir('ari-wt-')
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
  git(dir, 'add', '.')
  git(dir, 'commit', '-m', 'fixture')
  return dir
}

suite('session worktrees (M19.3)', () => {
  it('derives deterministic paths and branches from the session id', () => {
    expect(isValidSessionId('sess_9f1c')).toBe(true)
    expect(isValidSessionId('bad id')).toBe(false)
    expect(isValidSessionId('-leading-dash')).toBe(false)
    expect(isValidSessionId('.lock')).toBe(false)
    expect(sessionWorktreePath(join('repo', 'root'), 'sess_x')).toMatch(
      /repo[\\/]root[\\/]\.ari[\\/]worktrees[\\/]sess_x$/,
    )
    expect(sessionWorktreeBranch('sess_x')).toBe('ari/sess_x')
    expect(SESSION_WORKTREE_ROOT).toBe('.ari/worktrees')
  })

  it('creates an ignored worktree on branch ari/<sessionId>', async () => {
    const repo = await initRepo()
    const sessionId = 'sess_create'

    const ensured = await ensureSessionWorktree(service, repo, sessionId)
    expect(ensured).toBe(sessionWorktreePath(repo, sessionId))
    if (ensured === null) return
    expect((await stat(ensured)).isDirectory()).toBe(true)

    // Checked out on its own branch at HEAD — agent commits stay off main.
    expect(gitOut(ensured, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(
      sessionWorktreeBranch(sessionId),
    )
    expect(gitOut(ensured, 'rev-parse', 'HEAD')).toBe(gitOut(repo, 'rev-parse', 'HEAD'))

    // `.ari/` is excluded via info/exclude — never via .gitignore.
    const exclude = await readFile(join(repo, '.git', 'info', 'exclude'), 'utf8')
    expect(exclude.split(/\r?\n/).map((l) => l.trim())).toContain(SESSION_WORKTREE_ROOT)
    expect(await readFile(join(repo, '.gitignore'), 'utf8').catch(() => '')).not.toContain('.ari')
  }, 30000)

  it('isolates agent writes: the main checkout stays clean', async () => {
    const repo = await initRepo()
    const sessionId = 'sess_iso'
    const wt = await ensureSessionWorktree(service, repo, sessionId)
    if (wt === null) throw new Error('worktree was not created')

    await writeFile(join(wt, 'agent-output.txt'), 'only in the worktree\n', 'utf8')

    const mainStatus = await service.status(repo)
    expect(mainStatus.ok).toBe(true)
    if (mainStatus.ok) {
      expect(mainStatus.value.files).toEqual([])
      expect(['main', 'master']).toContain(mainStatus.value.branch)
    }

    const wtStatus = await service.status(wt)
    expect(wtStatus.ok).toBe(true)
    if (wtStatus.ok) {
      expect(wtStatus.value.files).toEqual([
        { path: 'agent-output.txt', staged: false, kind: 'untracked' },
      ])
    }
  }, 30000)

  it('reuses an existing worktree instead of adding a duplicate', async () => {
    const repo = await initRepo()
    const first = await ensureSessionWorktree(service, repo, 'sess_reuse')
    const second = await ensureSessionWorktree(service, repo, 'sess_reuse')
    expect(second).toBe(first)

    const list = await service.listWorktrees(repo)
    if (list.ok) expect(list.value).toHaveLength(2) // main + one session worktree

    // Exclusion line stays single even after repeated ensures.
    const exclude = await readFile(join(repo, '.git', 'info', 'exclude'), 'utf8')
    expect(exclude.split(/\r?\n/).filter((l) => l.trim() === SESSION_WORKTREE_ROOT)).toHaveLength(1)
  }, 30000)

  it('resolves null outside repos and for malformed session ids', async () => {
    const repo = await initRepo()
    const plain = await makeDir('ari-plain-')

    expect(await ensureSessionWorktree(service, plain, 'sess_ok')).toBeNull()
    expect(await ensureSessionWorktree(service, repo, '../escape')).toBeNull()
    expect(await ensureSessionWorktree(service, repo, 'has space')).toBeNull()
    // Nothing materialized from rejected ids.
    await expect(stat(join(repo, '.ari'))).rejects.toThrow()
  }, 30000)

  it('attaches to a surviving session branch when the checkout was removed', async () => {
    const repo = await initRepo()
    git(repo, 'branch', 'ari/sess_taken', 'HEAD') // branch exists, no worktree

    const ensured = await ensureSessionWorktree(service, repo, 'sess_taken')
    expect(ensured).toBe(sessionWorktreePath(repo, 'sess_taken'))
    if (ensured === null) return
    // Attached to the existing branch — prior agent work stays reachable.
    expect(gitOut(ensured, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('ari/sess_taken')
  }, 30000)

  it('falls back to null (never throws) when the target path is unusable', async () => {
    const repo = await initRepo()
    // A plain occupied directory blocks `git worktree add` outright.
    const blocked = sessionWorktreePath(repo, 'sess_stuck')
    await mkdir(blocked, { recursive: true })
    await writeFile(join(blocked, 'occupied.txt'), 'not a worktree\n', 'utf8')

    const ensured = await ensureSessionWorktree(service, repo, 'sess_stuck')
    expect(ensured).toBeNull()
  }, 30000)

  it('keeps exclusion working when info/exclude is missing or unnormalized', async () => {
    const repo = await initRepo()
    // Simulate setups where the file was removed: ensure must recreate it.
    await rm(join(repo, '.git', 'info'), { recursive: true, force: true })
    const wt = await ensureSessionWorktree(service, repo, 'sess_noinfo')
    expect(wt).not.toBeNull()
    const exclude = await readFile(join(repo, '.git', 'info', 'exclude'), 'utf8')
    expect(exclude.split(/\r?\n/).map((l) => l.trim())).toContain(SESSION_WORKTREE_ROOT)
  }, 30000)

  it('removes the worktree cleanly through GitService after an ensure', async () => {
    const repo = await initRepo()
    const wt = await ensureSessionWorktree(service, repo, 'sess_gone')
    if (wt === null) throw new Error('worktree was not created')

    const removed = await service.removeWorktree(repo, wt)
    expect(removed.ok).toBe(true)

    const again = await ensureSessionWorktree(service, repo, 'sess_gone')
    expect(again).toBe(wt) // recreates on demand for follow-up turns
  }, 30000)

  it('works when the project folder itself is a linked worktree', async () => {
    const main = await initRepo()
    const linked = join(await makeDir('ari-linked-'), 'checkout')
    git(main, 'worktree', 'add', linked, '-b', 'feature/linked')

    const wt = await ensureSessionWorktree(service, linked, 'sess_nested')
    expect(wt).toBe(sessionWorktreePath(linked, 'sess_nested'))
    if (wt !== null) {
      expect(gitOut(wt, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('ari/sess_nested')
    }
  }, 30000)
})

describe('session id validation without git', () => {
  it('accepts ULID-style and uuid-style ids', () => {
    expect(isValidSessionId('01J9ZK3P4Q7R8S9T0U1V2W3X4Y')).toBe(true)
    expect(isValidSessionId('sess_123e4567-e89b-12d3-a456-426614174000')).toBe(true)
    expect(isValidSessionId('')).toBe(false)
  })
})
