// @vitest-environment node
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import type * as FsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GitService, RepositoryGit } from '@ari/engine/git'
import { err, ok } from '@ari/shared/result'
import { checkoutChangeRequest, fetchRequestHead, type FetchRequestHead } from './request-checkout'

/** Makes the checkout's folder check fail as an unreadable drive would. */
const statFault = vi.hoisted(() => ({ code: null as string | null }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof FsPromises>()
  const stat = (async (...args: Parameters<typeof real.stat>) => {
    if (statFault.code) throw Object.assign(new Error('stat failed'), { code: statFault.code })
    return real.stat(...args)
  }) as typeof real.stat
  return { ...real, stat }
})

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) {
    try {
      const list = execFileSync('git', ['worktree', 'list', '--porcelain'], {
        cwd: root,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      for (const line of list.split('\n')) {
        if (!line.startsWith('worktree ')) continue
        const path = line.slice('worktree '.length).trim()
        if (resolve(path).toLowerCase() === resolve(root).toLowerCase()) continue
        execFileSync('git', ['worktree', 'remove', '--force', path], {
          cwd: root,
          stdio: ['pipe', 'pipe', 'pipe'],
        })
      }
    } catch {
      // Already removed.
    }
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim()
}

async function repo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ari-request-checkout-'))
  roots.push(root)
  git(root, 'init', '-q')
  git(root, 'config', 'core.autocrlf', 'false')
  git(root, 'config', 'user.name', 'test')
  git(root, 'config', 'user.email', 'test@ari.dev')
  git(root, 'config', 'commit.gpgsign', 'false')
  await writeFile(join(root, 'a.txt'), 'base\n')
  git(root, 'add', '.')
  git(root, 'commit', '-qm', 'base')
  return root
}

describe('request checkout', () => {
  it('fetches a local request ref without checking it out', async () => {
    const remote = await repo()
    const head = git(remote, 'rev-parse', 'HEAD')
    git(remote, 'update-ref', 'refs/pull/4/head', head)
    const consumer = await repo()
    const stayed = git(consumer, 'rev-parse', 'HEAD')
    const stayedBranch = git(consumer, 'rev-parse', '--abbrev-ref', 'HEAD')
    git(consumer, 'remote', 'add', 'origin', remote)
    const fetched = await fetchRequestHead(new RepositoryGit(consumer))(
      'origin',
      'refs/pull/4/head',
      'refs/ari/requests/github/4',
      new AbortController().signal,
    )
    expect(fetched).toEqual(ok(head))
    expect(git(consumer, 'rev-parse', 'HEAD')).toBe(stayed)
    expect(git(consumer, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(stayedBranch)
  })

  it('re-checks out a force-pushed request after its worktree was removed', async () => {
    const remote = await repo()
    const base = git(remote, 'rev-parse', 'HEAD')
    await writeFile(join(remote, 'a.txt'), 'A\n')
    git(remote, 'commit', '-qam', 'A')
    const a = git(remote, 'rev-parse', 'HEAD')
    git(remote, 'update-ref', 'refs/pull/7/head', a)
    const consumer = await repo()
    git(consumer, 'remote', 'add', 'origin', remote)
    const rootDir = await mkdtemp(join(tmpdir(), 'ari-request-root-'))
    roots.push(rootDir)
    const gitApi = new RepositoryGit(consumer)
    const remotes = [{ name: 'origin', url: 'https://github.com/acme/demo.git' }]
    const options = { rootDir, fetchHead: fetchRequestHead(gitApi) }
    const signal = new AbortController().signal
    const first = await checkoutChangeRequest(gitApi, remotes, 7, options, signal)
    expect(first).toMatchObject({ ok: true, value: { created: true, commit: a } })
    if (!first.ok) return
    git(remote, 'reset', '--hard', base)
    await writeFile(join(remote, 'a.txt'), 'B\n')
    git(remote, 'commit', '-qam', 'B')
    const b = git(remote, 'rev-parse', 'HEAD')
    git(remote, 'update-ref', 'refs/pull/7/head', b)
    git(consumer, 'worktree', 'remove', '--force', first.value.path)
    const second = await checkoutChangeRequest(gitApi, remotes, 7, options, signal)
    expect(second).toMatchObject({ ok: true, value: { created: true, commit: b } })
    if (!second.ok) return
    expect(git(second.value.path, 'rev-parse', 'HEAD')).toBe(b)
  })

  it('refuses, and keeps the worktree, when its folder cannot be read', async () => {
    const remote = await repo()
    git(remote, 'update-ref', 'refs/pull/7/head', git(remote, 'rev-parse', 'HEAD'))
    const consumer = await repo()
    git(consumer, 'remote', 'add', 'origin', remote)
    const rootDir = await mkdtemp(join(tmpdir(), 'ari-request-root-'))
    roots.push(rootDir)
    const gitApi = new RepositoryGit(consumer)
    const remotes = [{ name: 'origin', url: 'https://github.com/acme/demo.git' }]
    const options = { rootDir, fetchHead: fetchRequestHead(gitApi) }
    const signal = new AbortController().signal
    const first = await checkoutChangeRequest(gitApi, remotes, 7, options, signal)
    if (!first.ok) throw new Error(first.error.message)
    await writeFile(join(first.value.path, 'unsaved.txt'), 'work in progress')
    statFault.code = 'EACCES'
    try {
      const again = await checkoutChangeRequest(gitApi, remotes, 7, options, signal)
      expect(again).toMatchObject({
        ok: false,
        error: { message: expect.stringMatching(/Could not read/) },
      })
    } finally {
      statFault.code = null
    }
    expect(await readFile(join(first.value.path, 'unsaved.txt'), 'utf8')).toBe('work in progress')
  })

  it('refuses to reset a request branch that has local commits', async () => {
    const remote = await repo()
    await writeFile(join(remote, 'a.txt'), 'A\n')
    git(remote, 'commit', '-qam', 'A')
    const a = git(remote, 'rev-parse', 'HEAD')
    git(remote, 'update-ref', 'refs/pull/7/head', a)
    const consumer = await repo()
    git(consumer, 'remote', 'add', 'origin', remote)
    const rootDir = await mkdtemp(join(tmpdir(), 'ari-request-root-'))
    roots.push(rootDir)
    const gitApi = new RepositoryGit(consumer)
    const remotes = [{ name: 'origin', url: 'https://github.com/acme/demo.git' }]
    const options = { rootDir, fetchHead: fetchRequestHead(gitApi) }
    const signal = new AbortController().signal
    const first = await checkoutChangeRequest(gitApi, remotes, 7, options, signal)
    expect(first).toMatchObject({ ok: true, value: { created: true, commit: a } })
    if (!first.ok) return
    await writeFile(join(first.value.path, 'local.txt'), 'local\n')
    git(first.value.path, 'add', '.')
    git(first.value.path, 'commit', '-qm', 'local')
    const local = git(first.value.path, 'rev-parse', 'HEAD')
    git(consumer, 'worktree', 'remove', '--force', first.value.path)
    const second = await checkoutChangeRequest(gitApi, remotes, 7, options, signal)
    expect(second).toMatchObject({ ok: false, error: { code: 'failed' } })
    if (second.ok) return
    expect(second.error.message).toContain('local commits')
    expect(git(consumer, 'rev-parse', 'refs/heads/ari/request/github/7')).toBe(local)
  })

  it('refuses a request branch with local commits when the old request ref is gone', async () => {
    const remote = await repo()
    await writeFile(join(remote, 'a.txt'), 'A\n')
    git(remote, 'commit', '-qam', 'A')
    const a = git(remote, 'rev-parse', 'HEAD')
    git(remote, 'update-ref', 'refs/pull/7/head', a)
    const consumer = await repo()
    git(consumer, 'remote', 'add', 'origin', remote)
    const rootDir = await mkdtemp(join(tmpdir(), 'ari-request-root-'))
    roots.push(rootDir)
    const gitApi = new RepositoryGit(consumer)
    const remotes = [{ name: 'origin', url: 'https://github.com/acme/demo.git' }]
    const options = { rootDir, fetchHead: fetchRequestHead(gitApi) }
    const signal = new AbortController().signal
    const first = await checkoutChangeRequest(gitApi, remotes, 7, options, signal)
    expect(first).toMatchObject({ ok: true, value: { created: true, commit: a } })
    if (!first.ok) return
    await writeFile(join(first.value.path, 'local.txt'), 'local\n')
    git(first.value.path, 'add', '.')
    git(first.value.path, 'commit', '-qm', 'local')
    const local = git(first.value.path, 'rev-parse', 'HEAD')
    git(consumer, 'worktree', 'remove', '--force', first.value.path)
    git(consumer, 'update-ref', '-d', 'refs/ari/requests/github/7')
    const second = await checkoutChangeRequest(gitApi, remotes, 7, options, signal)
    expect(second).toMatchObject({ ok: false, error: { code: 'failed' } })
    if (second.ok) return
    expect(second.error.message).toContain('local commits')
    expect(git(consumer, 'rev-parse', 'refs/heads/ari/request/github/7')).toBe(local)
  })

  it('reports a request branch update failure without blaming another worktree', async () => {
    const remote = await repo()
    git(remote, 'update-ref', 'refs/pull/7/head', git(remote, 'rev-parse', 'HEAD'))
    const consumer = await repo()
    git(consumer, 'remote', 'add', 'origin', remote)
    const rootDir = await mkdtemp(join(tmpdir(), 'ari-request-root-'))
    roots.push(rootDir)
    await mkdir(join(consumer, '.git', 'refs', 'heads', 'ari', 'request', 'github'), {
      recursive: true,
    })
    await writeFile(
      join(consumer, '.git', 'refs', 'heads', 'ari', 'request', 'github', '7.lock'),
      '',
    )
    const gitApi = new RepositoryGit(consumer)
    const result = await checkoutChangeRequest(
      gitApi,
      [{ name: 'origin', url: 'https://github.com/acme/demo.git' }],
      7,
      { rootDir, fetchHead: fetchRequestHead(gitApi) },
      new AbortController().signal,
    )
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'failed', message: 'Could not update the request branch.' },
    })
  })

  it('reports a request branch checked out in another worktree', async () => {
    const remote = await repo()
    await writeFile(join(remote, 'a.txt'), 'A\n')
    git(remote, 'commit', '-qam', 'A')
    const a = git(remote, 'rev-parse', 'HEAD')
    git(remote, 'update-ref', 'refs/pull/7/head', a)
    const consumer = await repo()
    git(consumer, 'remote', 'add', 'origin', remote)
    const rootDir = await mkdtemp(join(tmpdir(), 'ari-request-root-'))
    roots.push(rootDir)
    const gitApi = new RepositoryGit(consumer)
    const remotes = [{ name: 'origin', url: 'https://github.com/acme/demo.git' }]
    const options = { rootDir, fetchHead: fetchRequestHead(gitApi) }
    const signal = new AbortController().signal
    const first = await checkoutChangeRequest(gitApi, remotes, 7, options, signal)
    expect(first).toMatchObject({ ok: true, value: { created: true, commit: a } })
    if (!first.ok) return
    git(consumer, 'worktree', 'remove', '--force', first.value.path)
    git(consumer, 'checkout', '-q', 'ari/request/github/7')
    const second = await checkoutChangeRequest(gitApi, remotes, 7, options, signal)
    expect(second).toMatchObject({ ok: false, error: { code: 'failed' } })
    if (second.ok) return
    expect(second.error.message).toBe(
      'This request branch is already checked out in another worktree.',
    )
    git(consumer, 'checkout', '-q', '-')
  })

  it('recreates a request worktree whose folder was deleted', async () => {
    const remote = await repo()
    await writeFile(join(remote, 'a.txt'), 'A\n')
    git(remote, 'commit', '-qam', 'A')
    const a = git(remote, 'rev-parse', 'HEAD')
    git(remote, 'update-ref', 'refs/pull/7/head', a)
    const consumer = await repo()
    git(consumer, 'remote', 'add', 'origin', remote)
    const realRoot = await mkdtemp(join(tmpdir(), 'ari-request-root-'))
    roots.push(realRoot)
    // Reach the root through a symlink, as macOS /var -> /private/var does, so git lists another spelling.
    let rootDir = realRoot
    if (process.platform !== 'win32') {
      rootDir = `${realRoot}-link`
      await symlink(realRoot, rootDir)
      roots.push(rootDir)
    }
    const gitApi = new RepositoryGit(consumer)
    const remotes = [{ name: 'origin', url: 'https://github.com/acme/demo.git' }]
    const options = { rootDir, fetchHead: fetchRequestHead(gitApi) }
    const signal = new AbortController().signal
    const first = await checkoutChangeRequest(gitApi, remotes, 7, options, signal)
    expect(first).toMatchObject({ ok: true, value: { created: true, commit: a } })
    if (!first.ok) return
    await rm(first.value.path, { recursive: true, force: true })
    const second = await checkoutChangeRequest(gitApi, remotes, 7, options, signal)
    expect(second).toMatchObject({ ok: true, value: { created: true } })
    if (!second.ok) return
    expect(git(second.value.path, 'rev-parse', 'HEAD')).toBe(a)
  })

  it('clears a deleted request worktree by the path git lists', async () => {
    const remote = await repo()
    await writeFile(join(remote, 'a.txt'), 'A\n')
    git(remote, 'commit', '-qam', 'A')
    const a = git(remote, 'rev-parse', 'HEAD')
    git(remote, 'update-ref', 'refs/pull/7/head', a)
    const consumer = await repo()
    git(consumer, 'remote', 'add', 'origin', remote)
    const realRoot = await mkdtemp(join(tmpdir(), 'ari-request-root-'))
    roots.push(realRoot)
    let rootDir = realRoot
    if (process.platform !== 'win32') {
      rootDir = `${realRoot}-link`
      await symlink(realRoot, rootDir)
      roots.push(rootDir)
    }
    // Only removes a worktree by the exact spelling git lists, like a git that cannot map an 8.3 or symlinked path.
    class ListedPathOnly extends GitService {
      override async removeWorktree(repo: string, path: string) {
        const listed = await this.listWorktrees(repo)
        if (!listed.ok || !listed.value.some((row) => row.path === path)) {
          return err({ code: 'invalid_ref' as const, message: `not a listed worktree: ${path}` })
        }
        return super.removeWorktree(repo, path)
      }
    }
    const gitApi = new RepositoryGit(consumer)
    const remotes = [{ name: 'origin', url: 'https://github.com/acme/demo.git' }]
    const options = {
      rootDir,
      fetchHead: fetchRequestHead(gitApi),
      worktrees: new ListedPathOnly({ timeoutMs: 60_000 }),
    }
    const signal = new AbortController().signal
    const first = await checkoutChangeRequest(gitApi, remotes, 7, options, signal)
    expect(first).toMatchObject({ ok: true, value: { created: true, commit: a } })
    if (!first.ok) return
    await rm(first.value.path, { recursive: true, force: true })
    const second = await checkoutChangeRequest(gitApi, remotes, 7, options, signal)
    expect(second).toMatchObject({ ok: true, value: { created: true, commit: a } })
  })

  it('re-checks out a request after its worktree was removed', async () => {
    const remote = await repo()
    await writeFile(join(remote, 'a.txt'), 'A\n')
    git(remote, 'commit', '-qam', 'A')
    const a = git(remote, 'rev-parse', 'HEAD')
    git(remote, 'update-ref', 'refs/pull/7/head', a)
    const consumer = await repo()
    git(consumer, 'remote', 'add', 'origin', remote)
    const rootDir = await mkdtemp(join(tmpdir(), 'ari-request-root-'))
    roots.push(rootDir)
    const gitApi = new RepositoryGit(consumer)
    const remotes = [{ name: 'origin', url: 'https://github.com/acme/demo.git' }]
    const options = { rootDir, fetchHead: fetchRequestHead(gitApi) }
    const signal = new AbortController().signal
    const first = await checkoutChangeRequest(gitApi, remotes, 7, options, signal)
    expect(first).toMatchObject({ ok: true, value: { created: true, commit: a } })
    if (!first.ok) return
    git(consumer, 'worktree', 'remove', '--force', first.value.path)
    const second = await checkoutChangeRequest(gitApi, remotes, 7, options, signal)
    expect(second).toMatchObject({ ok: true, value: { created: true, commit: a } })
  })

  it('leaves an unsupported forge untouched', async () => {
    const root = await repo()
    git(root, 'remote', 'add', 'origin', 'https://codeberg.org/acme/demo.git')
    const fetchHead = vi.fn<FetchRequestHead>()
    const result = await checkoutChangeRequest(
      new RepositoryGit(root),
      [{ name: 'origin', url: 'https://codeberg.org/acme/demo.git' }],
      4,
      { rootDir: join(root, 'out'), fetchHead },
      new AbortController().signal,
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('unsupported')
    expect(result.error.message).toContain('not connected')
    expect(fetchHead).not.toHaveBeenCalled()
  })

  it('reopens an existing request worktree without discarding its edits', async () => {
    const root = await repo()
    await writeFile(join(root, 'a.txt'), 'request\n')
    git(root, 'add', '.')
    git(root, 'commit', '-qm', 'request')
    const request = git(root, 'rev-parse', 'HEAD')
    git(root, 'reset', '--hard', 'HEAD~1')
    git(root, 'remote', 'add', 'origin', 'https://gitlab.com/acme/group/demo.git')
    const rootDir = await mkdtemp(join(tmpdir(), 'ari-request-root-'))
    roots.push(rootDir)
    const fetchHead = vi.fn<FetchRequestHead>(async (_remote, _remoteRef, localRef) => {
      git(root, 'update-ref', localRef, request)
      return ok(request)
    })
    const gitApi = new RepositoryGit(root)
    const signal = new AbortController().signal
    const created = await checkoutChangeRequest(
      gitApi,
      [{ name: 'origin', url: 'https://gitlab.com/acme/group/demo.git' }],
      8,
      { rootDir, fetchHead },
      signal,
    )
    expect(created).toMatchObject({
      ok: true,
      value: { created: true, branch: 'ari/request/gitlab/8', commit: request },
    })
    if (!created.ok) return
    expect(fetchHead).toHaveBeenCalledWith(
      'origin',
      'refs/merge-requests/8/head',
      'refs/ari/requests/gitlab/8',
      signal,
    )
    await writeFile(join(created.value.path, 'local.txt'), 'keep\n')
    const again = await checkoutChangeRequest(
      gitApi,
      [{ name: 'origin', url: 'https://gitlab.com/acme/group/demo.git' }],
      8,
      { rootDir, fetchHead },
      signal,
    )
    expect(again).toMatchObject({ ok: true, value: { created: false, path: created.value.path } })
    expect(await readFile(join(created.value.path, 'local.txt'), 'utf8')).toBe('keep\n')
    expect(fetchHead).toHaveBeenCalledOnce()
  })

  it('reports a failed fetch without creating a worktree', async () => {
    const root = await repo()
    git(root, 'remote', 'add', 'origin', 'https://github.com/acme/demo.git')
    const rootDir = await mkdtemp(join(tmpdir(), 'ari-request-root-'))
    roots.push(rootDir)
    const result = await checkoutChangeRequest(
      new RepositoryGit(root),
      [{ name: 'origin', url: 'https://github.com/acme/demo.git' }],
      4,
      {
        rootDir,
        fetchHead: async () =>
          err({
            code: 'failed',
            message: 'Could not fetch the request. Check the hosting login and try again.',
          }),
      },
      new AbortController().signal,
    )
    expect(result).toMatchObject({ ok: false, error: { code: 'failed' } })
    expect(git(root, 'worktree', 'list')).not.toContain('github-4')
  })
})
