import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal()
  const fs = actual as {
    rm: (path: string, options?: { force?: boolean }) => Promise<void>
  }
  return {
    ...fs,
    rm: async (path: string, options?: { force?: boolean }) => {
      if (String(path).endsWith(`${sep}locked.txt`)) {
        throw Object.assign(new Error('busy'), { code: 'EBUSY' })
      }
      return fs.rm(path, options)
    },
  }
})
import { gitMutationSchema } from '@ari/contracts/rpc'
import { GitReviewService } from './git-review'
import { GitMutationService } from './git-mutations'

const roots: string[] = []
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'ari-mutation-'))
  roots.push(root)
  git(root, 'init', '-b', 'main')
  git(root, 'config', 'user.name', 'Ari tests')
  git(root, 'config', 'user.email', 'test@ari.local')
  git(root, 'config', 'commit.gpgsign', 'false')
  git(root, 'config', 'core.autocrlf', 'false')
  await writeFile(join(root, 'a.txt'), 'old\n')
  git(root, 'add', '.')
  git(root, 'commit', '-m', 'base')
  const review = new GitReviewService(root)
  const mutations = new GitMutationService(review, () => Promise.resolve(false))
  const snapshot = async () => {
    const value = await review.manifest({ kind: 'working-tree' })
    if (!value.ok) throw new Error(value.error.message)
    return value.value.id
  }
  return { root, review, mutations, snapshot }
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })))
})

describe('reviewed Git mutations', { timeout: 120_000 }, () => {
  it('stages selected literal files, unstages and commits only the index', async () => {
    const { root, mutations, snapshot } = await fixture()
    await writeFile(join(root, 'a.txt'), 'changed\n')
    await writeFile(join(root, '[new].txt'), 'new\n')
    expect((await mutations.run({ kind: 'stage', paths: ['[new].txt'], snapshotId: await snapshot() })).ok).toBe(true)
    expect(git(root, 'diff', '--cached', '--name-only')).toBe('[new].txt')
    expect((await mutations.run({ kind: 'unstage', paths: ['[new].txt'], snapshotId: await snapshot() })).ok).toBe(true)
    expect(git(root, 'diff', '--cached', '--name-only')).toBe('')
    await mutations.run({ kind: 'stage', paths: ['a.txt'], snapshotId: await snapshot() })
    expect((await mutations.run({ kind: 'commit', message: 'Selected file only', snapshotId: await snapshot() })).ok).toBe(true)
    expect(git(root, 'show', 'HEAD:a.txt')).toBe('changed')
    expect(git(root, 'status', '--porcelain')).toContain('?? [new].txt')
  })

  it('refuses stale, unknown and actively written worktrees', async () => {
    const { root, review, mutations, snapshot } = await fixture()
    const id = await snapshot()
    await writeFile(join(root, 'a.txt'), 'newer\n')
    expect(await mutations.run({ kind: 'stage', paths: ['a.txt'], snapshotId: id })).toMatchObject({ ok: false, error: { code: 'stale' } })
    expect(await mutations.run({ kind: 'stage', paths: ['a.txt'], snapshotId: 'missing' })).toMatchObject({ ok: false, error: { code: 'stale' } })
    expect(await new GitMutationService(review, () => Promise.resolve(true)).run({ kind: 'stage', paths: ['a.txt'], snapshotId: await snapshot() })).toMatchObject({ ok: false, error: { code: 'busy' } })
    expect(git(root, 'diff', '--cached', '--name-only')).toBe('')
  })

  it('discards unstaged content while keeping staging and a recoverable snapshot', async () => {
    const { root, mutations, snapshot } = await fixture()
    await writeFile(join(root, 'a.txt'), 'staged\n')
    git(root, 'add', 'a.txt')
    await writeFile(join(root, 'a.txt'), 'unstaged\n')
    await writeFile(join(root, 'new.txt'), 'recover me\n')
    const result = await mutations.run({ kind: 'discard', paths: ['a.txt', 'new.txt'], confirmed: true, snapshotId: await snapshot() })
    if (!result.ok) throw new Error(result.error.message)
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('staged\n')
    expect(git(root, 'show', ':a.txt')).toBe('staged')
    expect(git(root, 'show', `${result.value.recoveryRef}:new.txt`)).toBe('recover me')
    expect(git(root, 'show', `${result.value.recoveryRef}:a.txt`)).toBe('unstaged')
  })

  it('keeps the recovery ref when an untracked discard cannot be removed', async () => {
    const { root, mutations, snapshot } = await fixture()
    await writeFile(join(root, 'locked.txt'), 'keep me\n')
    const result = await mutations.run({
      kind: 'discard',
      paths: ['locked.txt'],
      confirmed: true,
      snapshotId: await snapshot(),
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.message).toMatch(/Could not remove locked\.txt\. Recovery: /)
    expect(await readFile(join(root, 'locked.txt'), 'utf8')).toBe('keep me\n')
  })

  it('switches a clean branch, stashes, and reapplies without dropping the stash', async () => {
    const { root, mutations, snapshot } = await fixture()
    expect((await mutations.run({ kind: 'branch', name: 'feature/test', create: true, confirmed: true, snapshotId: await snapshot() })).ok).toBe(true)
    await writeFile(join(root, 'a.txt'), 'saved\n')
    expect((await mutations.run({ kind: 'stash', message: 'saved work', confirmed: true, snapshotId: await snapshot() })).ok).toBe(true)
    const oid = git(root, 'rev-parse', 'refs/stash')
    expect((await mutations.run({ kind: 'apply-stash', oid, confirmed: true, snapshotId: await snapshot() })).ok).toBe(true)
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('saved\n')
    expect(git(root, 'rev-parse', 'refs/stash')).toBe(oid)
    expect(await mutations.run({ kind: 'pull', confirmed: true, snapshotId: await snapshot() })).toMatchObject({ ok: false, error: { code: 'busy' } })
  })

  it('pushes only to an explicitly configured remote and refuses nested project writes', async () => {
    const { root, mutations, snapshot } = await fixture()
    expect(await mutations.run({ kind: 'push', remote: 'unknown', confirmed: true, snapshotId: await snapshot() })).toMatchObject({ ok: false, error: { code: 'invalid-input' } })
    const remote = await mkdtemp(join(tmpdir(), 'ari-bare-'))
    roots.push(remote)
    git(remote, 'init', '--bare')
    git(root, 'remote', 'add', 'origin', remote)
    expect((await mutations.run({ kind: 'push', remote: 'origin', confirmed: true, snapshotId: await snapshot() })).ok).toBe(true)
    expect((await mutations.run({ kind: 'fetch', remote: 'origin', snapshotId: await snapshot() })).ok).toBe(true)
    expect((await mutations.run({ kind: 'pull', confirmed: true, snapshotId: await snapshot() })).ok).toBe(true)
    await mkdir(join(root, 'nested'))
    await writeFile(join(root, 'nested', 'x.txt'), 'x')
    const nested = new GitReviewService(join(root, 'nested'))
    const manifest = await nested.manifest({ kind: 'working-tree' })
    if (!manifest.ok) throw new Error(manifest.error.message)
    expect(await new GitMutationService(nested, () => Promise.resolve(false)).run({ kind: 'stage', paths: ['x.txt'], snapshotId: manifest.value.id })).toMatchObject({ ok: false, error: { code: 'unsupported' } })
  })

  it('validates required destructive confirmation and rejects injected arguments', () => {
    const snapshotId = 'a'.repeat(64)
    expect(gitMutationSchema.safeParse({ kind: 'discard', paths: ['a.txt'], snapshotId }).success).toBe(false)
    expect(gitMutationSchema.safeParse({ kind: 'stage', paths: ['../secret'], snapshotId }).success).toBe(false)
    expect(gitMutationSchema.safeParse({ kind: 'push', remote: '--force', confirmed: true, snapshotId }).success).toBe(false)
  })
})
