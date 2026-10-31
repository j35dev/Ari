// @vitest-environment node
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RepositoryGit } from '@ari/engine/git'
import { err, ok } from '@ari/shared/result'
import { checkoutChangeRequest, fetchRequestHead, type FetchRequestHead } from './request-checkout'

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
