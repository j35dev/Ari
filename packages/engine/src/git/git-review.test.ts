import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { GitReviewService } from './git-review'

const roots: string[] = []
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
async function repository() {
  const root = await mkdtemp(join(tmpdir(), 'ari-review-'))
  roots.push(root)
  git(root, 'init', '-b', 'main')
  git(root, 'config', 'user.name', 'Ari tests')
  git(root, 'config', 'user.email', 'test@ari.local')
  git(root, 'config', 'commit.gpgsign', 'false')
  git(root, 'config', 'core.autocrlf', 'false')
  await writeFile(join(root, 'app.ts'), 'one\n')
  await writeFile(join(root, '.gitignore'), 'ignored.txt\n')
  git(root, 'add', '.')
  git(root, 'commit', '-m', 'base')
  return root
}
afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })),
  )
})

describe('snapshot-backed Git review', { timeout: 60_000 }, () => {
  it('separates staged and unstaged scopes without changing the real index or HEAD', async () => {
    const root = await repository()
    await writeFile(join(root, 'app.ts'), 'one\nstaged\n')
    git(root, 'add', 'app.ts')
    await writeFile(join(root, 'app.ts'), 'one\nstaged\nunstaged\n')
    const before = [git(root, 'write-tree'), git(root, 'rev-parse', 'HEAD')]
    const service = new GitReviewService(root)
    const staged = await service.manifest({ kind: 'staged' })
    const unstaged = await service.manifest({ kind: 'unstaged' })
    if (!staged.ok || !unstaged.ok) throw new Error('review unavailable')
    expect(staged.value.files[0]).toMatchObject({
      path: 'app.ts',
      staged: true,
      unstaged: true,
      additions: 1,
    })
    const stagedPatch = await service.diff(staged.value.id, 'app.ts')
    if (!stagedPatch.ok) throw new Error(stagedPatch.error.message)
    expect(stagedPatch.value).toContain('+staged')
    const patch = await service.diff(unstaged.value.id, 'app.ts')
    if (!patch.ok) throw new Error(patch.error.message)
    expect(patch.value).toContain('+unstaged')
    expect(patch.value).not.toContain('+staged')
    expect([git(root, 'write-tree'), git(root, 'rev-parse', 'HEAD')]).toEqual(before)
  })

  it('includes new literal-path files, excludes ignored files, and keeps old comparisons immutable', async () => {
    const root = await repository()
    await writeFile(join(root, 'new [日本語].ts'), 'fresh\n')
    await writeFile(join(root, 'ignored.txt'), 'private\n')
    const service = new GitReviewService(root)
    const review = await service.manifest({ kind: 'working-tree' })
    if (!review.ok) throw new Error(review.error.message)
    expect(review.value.files.map((file) => file.path)).toEqual(['new [日本語].ts'])
    await writeFile(join(root, 'new [日本語].ts'), 'later edit\n')
    const patch = await service.diff(review.value.id, 'new [日本語].ts')
    if (!patch.ok) throw new Error(patch.error.message)
    expect(patch.value).toContain('+fresh')
    expect(patch.value).not.toContain('later edit')
    expect(git(root, 'status', '--porcelain')).toContain('??')
  })

  it('keeps committed agent changes in branch scope and supports a single commit', async () => {
    const root = await repository()
    git(root, 'switch', '-c', 'feature/review')
    await writeFile(join(root, 'app.ts'), 'committed\n')
    git(root, 'add', 'app.ts')
    git(root, 'commit', '-m', 'agent change')
    await writeFile(join(root, 'fresh.ts'), 'uncommitted\n')
    const service = new GitReviewService(root)
    const branch = await service.manifest({ kind: 'branch' })
    const working = await service.manifest({ kind: 'working-tree' })
    const commit = await service.manifest({ kind: 'commit', ref: 'HEAD' })
    if (!branch.ok || !working.ok || !commit.ok) throw new Error('review unavailable')
    expect(branch.value.files.map((file) => file.path)).toEqual(['app.ts', 'fresh.ts'])
    expect(working.value.files.map((file) => file.path)).toEqual(['fresh.ts'])
    expect(commit.value.files.map((file) => file.path)).toEqual(['app.ts'])
    expect(commit.value.live).toBe(false)
  })

  it('scopes a nested project without exposing sibling changes', async () => {
    const root = await repository()
    await mkdir(join(root, 'nested'))
    await writeFile(join(root, 'nested', 'file.ts'), 'inside\n')
    await writeFile(join(root, 'outside.ts'), 'outside\n')
    const service = new GitReviewService(join(root, 'nested'))
    const review = await service.manifest({ kind: 'working-tree' })
    if (!review.ok) throw new Error(review.error.message)
    expect(review.value.files.map((file) => file.path)).toEqual(['file.ts'])
    expect(await service.diff(review.value.id, '../outside.ts')).toMatchObject({
      ok: false,
      error: { code: 'stale' },
    })
    const patch = await service.diff(review.value.id, 'file.ts')
    if (!patch.ok) throw new Error(patch.error.message)
    expect(patch.value).toContain('+inside')
  })

  it('handles unborn repositories and requires stable turn endpoints', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ari-unborn-review-'))
    roots.push(root)
    git(root, 'init', '-b', 'main')
    await writeFile(join(root, 'first.ts'), 'first\n')
    const service = new GitReviewService(root)
    const review = await service.manifest({ kind: 'working-tree' })
    if (!review.ok) throw new Error(review.error.message)
    expect(review.value.files[0]).toMatchObject({ path: 'first.ts', additions: 1 })
    expect(await service.manifest({ kind: 'turn', turnId: 'turn_1' })).toMatchObject({
      ok: false,
      error: { code: 'unavailable' },
    })
    const controller = new AbortController()
    controller.abort()
    expect(await service.manifest({ kind: 'working-tree' }, {}, controller.signal)).toMatchObject({
      ok: false,
      error: { code: 'unavailable' },
    })
  })

  it('retains rename and binary metadata and enforces the per-file size cap', async () => {
    const root = await repository()
    git(root, 'mv', 'app.ts', 'renamed.ts')
    await writeFile(join(root, 'image.bin'), Buffer.from([0, 1, 2]))
    await writeFile(join(root, 'large.txt'), 'new line\n'.repeat(140_000))
    const service = new GitReviewService(root)
    const review = await service.manifest({ kind: 'working-tree' })
    if (!review.ok) throw new Error(review.error.message)
    expect(review.value.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'renamed.ts', oldPath: 'app.ts', kind: 'renamed' }),
      expect.objectContaining({ path: 'image.bin', binary: true }),
    ]))
    expect(await service.diff(review.value.id, 'large.txt')).toMatchObject({ ok: false, error: { code: 'too-large' } })
    expect((await service.diff(review.value.id, 'renamed.ts')).ok).toBe(true)
  })

  it('keeps session endpoints after commits and turn endpoints after later edits', async () => {
    const root = await repository()
    const base = git(root, 'rev-parse', 'HEAD')
    await writeFile(join(root, 'app.ts'), 'agent edit\n')
    git(root, 'add', 'app.ts')
    git(root, 'commit', '-m', 'agent')
    const head = git(root, 'rev-parse', 'HEAD')
    const service = new GitReviewService(root)
    expect((await service.manifest({ kind: 'session' }, { base })).ok).toBe(true)
    await writeFile(join(root, 'app.ts'), 'manual edit\n')
    const turn = await service.manifest({ kind: 'turn', turnId: 'turn_1' }, { base, head })
    if (!turn.ok) throw new Error(turn.error.message)
    const patch = await service.diff(turn.value.id, 'app.ts')
    if (!patch.ok) throw new Error(patch.error.message)
    expect(patch.value).toContain('+agent edit')
    expect(patch.value).not.toContain('manual edit')
    expect(turn.value.live).toBe(false)
  })

  it('never serves another workspace or an expired comparison', async () => {
    const root = await repository()
    const service = new GitReviewService(root)
    expect(await service.diff('expired', 'app.ts')).toMatchObject({
      ok: false,
      error: { code: 'stale' },
    })
    expect(await new GitReviewService(join(root, 'other')).diff('expired', 'app.ts')).toMatchObject(
      { ok: false, error: { code: 'stale' } },
    )
  })
})
