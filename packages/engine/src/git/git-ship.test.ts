import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ok } from '@ari/shared/result'
import { defaultCommitMessage, ship } from './git-ship'
import { GitReviewService } from './git-review'

let root: string
let repo: string
let remote: string
const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
const noPr = { createPr: vi.fn(async () => ok(null)) }

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ari-ship-'))
  repo = join(root, 'repo')
  remote = join(root, 'remote.git')
  git(root, 'init', '-q', '--bare', '-b', 'main', remote)
  git(root, 'init', '-q', '-b', 'main', repo)
  for (const [key, value] of [
    ['user.name', 'Ari tests'],
    ['user.email', 'test@ari.dev'],
    ['commit.gpgsign', 'false'],
    ['core.autocrlf', 'false'],
  ])
    git(repo, 'config', key!, value!)
  await writeFile(join(repo, 'a.txt'), 'one\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-qm', 'first')
  git(repo, 'remote', 'add', 'origin', remote)
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

describe('ship', { timeout: 30_000 }, () => {
  it('commits every change, untracked files included, and pushes a new branch upstream', async () => {
    await writeFile(join(repo, 'a.txt'), 'two\n')
    await writeFile(join(repo, 'b.txt'), 'new\n')
    const result = await ship(new GitReviewService(repo), { action: 'commit_push' }, noPr)
    expect(result).toEqual(
      ok({ committed: 'Update a.txt and b.txt', pushed: true, pulled: false, prUrl: null }),
    )
    expect(git(repo, 'status', '--porcelain')).toBe('')
    expect(git(repo, 'rev-parse', '--abbrev-ref', '@{u}')).toBe('origin/main')
    expect(git(remote, 'log', '-1', '--format=%s', 'main')).toBe('Update a.txt and b.txt')
  })

  it('commits only the chosen files with the typed message', async () => {
    await writeFile(join(repo, 'a.txt'), 'two\n')
    await writeFile(join(repo, 'b.txt'), 'left out\n')
    const result = await ship(
      new GitReviewService(repo),
      { action: 'commit', message: 'Change a', paths: ['a.txt'] },
      noPr,
    )
    expect(result.ok && result.value.committed).toBe('Change a')
    expect(git(repo, 'show', '--name-only', '--format=', 'HEAD')).toBe('a.txt')
    expect(git(repo, 'status', '--porcelain')).toBe('?? b.txt')
  })

  it('refuses to commit when nothing changed', async () => {
    const result = await ship(new GitReviewService(repo), { action: 'commit' }, noPr)
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid-input' } })
  })

  it('preserves unselected staged files and treats selected pathspec characters literally', async () => {
    await writeFile(join(repo, 'a.txt'), 'staged elsewhere\n')
    git(repo, 'add', 'a.txt')
    await writeFile(join(repo, '[change].txt'), 'selected\n')
    const result = await ship(
      new GitReviewService(repo),
      { action: 'commit', message: 'Selected change', paths: ['[change].txt'] },
      noPr,
    )
    expect(result.ok).toBe(true)
    expect(git(repo, 'show', '--name-only', '--format=', 'HEAD')).toBe('[change].txt')
    expect(git(repo, 'diff', '--cached', '--name-only')).toBe('a.txt')
    expect(git(repo, 'diff', '--cached')).toContain('staged elsewhere')
  })

  it('opens the pull request after pushing and reports its URL', async () => {
    const createPr = vi.fn(async () => ok('https://github.com/o/r/pull/7'))
    git(repo, 'switch', '-q', '-c', 'feature')
    await writeFile(join(repo, 'a.txt'), 'feature\n')
    const result = await ship(
      new GitReviewService(repo),
      { action: 'commit_push_pr' },
      { createPr },
    )
    expect(result.ok && result.value).toMatchObject({
      pushed: true,
      prUrl: 'https://github.com/o/r/pull/7',
    })
    expect(createPr).toHaveBeenCalledOnce()
  })

  it('surfaces why a push was rejected', async () => {
    await ship(new GitReviewService(repo), { action: 'push' }, noPr)
    const other = join(root, 'other')
    git(root, 'clone', '-q', remote, other)
    git(other, 'config', 'user.name', 'x')
    git(other, 'config', 'user.email', 'x@x')
    await writeFile(join(other, 'a.txt'), 'theirs\n')
    git(other, 'commit', '-qam', 'theirs')
    git(other, 'push', '-q')
    await writeFile(join(repo, 'a.txt'), 'mine\n')
    git(repo, 'commit', '-qam', 'mine')
    const result = await ship(new GitReviewService(repo), { action: 'push' }, noPr)
    expect(result.ok).toBe(false)
    expect(!result.ok && result.error.message).toMatch(/rejected|fetch first/)
  })

  it('fast-forwards on pull', async () => {
    await ship(new GitReviewService(repo), { action: 'push' }, noPr)
    const other = join(root, 'other')
    git(root, 'clone', '-q', remote, other)
    git(other, 'config', 'user.name', 'x')
    git(other, 'config', 'user.email', 'x@x')
    await writeFile(join(other, 'c.txt'), 'theirs\n')
    git(other, 'add', '.')
    git(other, 'commit', '-qm', 'theirs')
    git(other, 'push', '-q')
    git(repo, 'fetch', '-q')
    const result = await ship(new GitReviewService(repo), { action: 'pull' }, noPr)
    expect(result.ok && result.value.pulled).toBe(true)
    expect(git(repo, 'log', '-1', '--format=%s')).toBe('theirs')
  })
})

describe('defaultCommitMessage', () => {
  it('names one or two files and counts more', () => {
    expect(defaultCommitMessage(['src/a.ts'])).toBe('Update a.ts')
    expect(defaultCommitMessage(['a', 'b/c'])).toBe('Update a and c')
    expect(defaultCommitMessage(['a', 'b', 'c'])).toBe('Update 3 files')
  })
})
