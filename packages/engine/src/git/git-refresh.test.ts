import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GitReviewService } from './git-review'
import { GitMutationService } from './git-mutations'
import { readGitHistory } from './git-history'
import { watchGitChanges } from './git-watch'

let root: string
const run = (...args: string[]): string =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ari-git-refresh-'))
  run('init', '-q')
  run('config', 'user.name', 'Ari tests')
  run('config', 'user.email', 'test@ari.dev')
  run('config', 'commit.gpgsign', 'false')
  run('config', 'core.autocrlf', 'false')
  await writeFile(join(root, 'a.txt'), 'before\n')
  run('add', '.')
  run('commit', '-qm', 'first')
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

describe('active source-control reads', { timeout: 30_000 }, () => {
  it('guards mutations reviewed in staged scope against unseen working-tree edits', async () => {
    await writeFile(join(root, 'a.txt'), 'staged\n')
    run('add', 'a.txt')
    const review = new GitReviewService(root)
    const snapshot = await review.manifest({ kind: 'staged' })
    if (!snapshot.ok) throw new Error(snapshot.error.message)
    await writeFile(join(root, 'a.txt'), 'unreviewed\n')
    const result = await new GitMutationService(review, async () => false).run({
      kind: 'stage',
      snapshotId: snapshot.value.id,
      paths: ['a.txt'],
    })
    expect(result).toMatchObject({ ok: false, error: { code: 'stale' } })
    expect(run('show', ':a.txt')).toBe('staged')
  })

  it('keeps fixed comparison identity across unrelated commits and strips remote credentials', async () => {
    const review = new GitReviewService(root)
    const oid = run('rev-parse', 'HEAD')
    const original = await review.manifest({ kind: 'commit', ref: oid })
    await writeFile(join(root, 'a.txt'), 'later\n')
    run('commit', '-am', 'later')
    const again = await review.manifest({ kind: 'commit', ref: oid })
    expect(original.ok && original.value.id).toBe(again.ok && again.value.id)
    run('remote', 'add', 'origin', 'https://user:secret@example.org/repo.git?token=hidden#private')
    const status = await review.status()
    expect(status.ok && status.value.remotes).toEqual([
      { name: 'origin', url: 'https://example.org/repo.git' },
    ])
  })

  it('returns bounded history and stashes and supports cancellation', async () => {
    await writeFile(join(root, 'a.txt'), 'saved\n')
    run('stash', 'push', '-m', 'work in progress')
    const review = new GitReviewService(root)
    const status = await review.status()
    if (!status.ok) throw new Error(status.error.message)
    const result = await readGitHistory(review.git, status.value)
    expect(result.ok && result.value.commits[0]?.subject).toBe('first')
    expect(result.ok && result.value.stashes[0]?.subject).toContain('work in progress')
    expect(await review.manifest({ kind: 'working-tree' }, {}, AbortSignal.abort())).toMatchObject({
      ok: false,
      error: { code: 'unavailable' },
    })
  })

  it('coalesces visible file/index changes, ignores object churn and releases watchers', async () => {
    const changed = vi.fn()
    const watched = await watchGitChanges(root, changed)
    if (!watched.ok) throw new Error(watched.error.message)
    try {
      await writeFile(join(root, 'a.txt'), 'changed\n')
      await vi.waitFor(() => expect(changed).toHaveBeenCalled(), { timeout: 5000 })
      changed.mockClear()
      run('add', 'a.txt')
      await vi.waitFor(() => expect(changed).toHaveBeenCalled(), { timeout: 5000 })
      changed.mockClear()
      await mkdir(join(root, '.ari'))
      await writeFile(join(root, '.ari', 'ignored.txt'), 'ignored')
      run('hash-object', '-w', '--stdin')
      await new Promise((resolve) => setTimeout(resolve, 650))
      expect(changed).not.toHaveBeenCalled()
    } finally {
      await watched.value()
    }
    await writeFile(join(root, 'a.txt'), 'after close\n')
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(changed).not.toHaveBeenCalled()
  })
})
