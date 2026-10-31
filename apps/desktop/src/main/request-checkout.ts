import { mkdir, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { GitService, type RepositoryGit } from '@ari/engine/git'
import type { RequestCheckout, SourceControlError } from '@ari/contracts/rpc'
import { err, ok, type Result } from '@ari/shared/result'
import { chooseHost } from './host-remote'

const oid = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/
const remoteName = /^(?!.*\.\.)[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/

export type FetchRequestHead = (
  remote: string,
  remoteRef: string,
  localRef: string,
  signal: AbortSignal,
) => Promise<Result<string, SourceControlError>>

/** Fetches a pull or merge request head into an Ari ref. Does not move HEAD. */
export function fetchRequestHead(git: RepositoryGit): FetchRequestHead {
  return async (remote, remoteRef, localRef, signal) => {
    const fetched = await git.run(['fetch', '--no-tags', remote, `${remoteRef}:${localRef}`], {
      signal,
      timeoutMs: 60_000,
    })
    if (!fetched.ok) {
      return err({
        code: fetched.error.code === 'unavailable' ? 'unavailable' : 'failed',
        message:
          fetched.error.code === 'unavailable'
            ? fetched.error.message
            : 'Could not fetch the request. Check the hosting login and try again.',
      })
    }
    return readCommit(git, localRef, signal)
  }
}

export async function checkoutChangeRequest(
  git: RepositoryGit,
  remotes: readonly { name: string; url: string }[],
  number: number,
  options: { rootDir: string; fetchHead: FetchRequestHead; worktrees?: GitService },
  signal: AbortSignal,
): Promise<Result<RequestCheckout, SourceControlError>> {
  if (!Number.isInteger(number) || number < 1 || number > 1_000_000) {
    return err({ code: 'invalid-input', message: 'A request number is required.' })
  }
  const host = chooseHost(remotes)
  if (!host) {
    return err({
      code: 'unsupported',
      message: 'No recognized hosting remote. Ari does not guess a private host.',
    })
  }
  if (!host.listable || (host.provider !== 'github' && host.provider !== 'gitlab')) {
    return err({
      code: 'unsupported',
      message: `${host.label} is recognized. Checkout into a worktree is not connected.`,
    })
  }
  if (!remoteName.test(host.remote)) {
    return err({ code: 'invalid-input', message: 'The hosting remote name is not safe to fetch.' })
  }
  const provider = host.provider
  const remoteRef =
    provider === 'github' ? `refs/pull/${number}/head` : `refs/merge-requests/${number}/head`
  const localRef = `refs/ari/requests/${provider}/${number}`
  const branch = `ari/request/${provider}/${number}`
  const slug =
    host.name
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'repository'
  const parent = join(options.rootDir, slug)
  const target = join(parent, `${provider}-${number}`)
  const worktrees = options.worktrees ?? new GitService({ timeoutMs: 60_000 })
  const listed = await worktrees.listWorktrees(git.cwd)
  if (!listed.ok) return err({ code: 'failed', message: 'Could not list worktrees.' })
  const existing = await findWorktree(listed.value, target)
  if (existing) {
    if (!oid.test(existing.head) || existing.branch !== `refs/heads/${branch}`) {
      return err({
        code: 'failed',
        message: 'A different checkout already uses this request path.',
      })
    }
    return ok({ path: target, branch, commit: existing.head, number, created: false })
  }
  if (await stat(target).catch(() => null)) {
    return err({ code: 'failed', message: 'The request worktree path is already in use.' })
  }
  const before = await readPair(git, signal)
  if (!before.ok) return before
  const fetched = await options.fetchHead(host.remote, remoteRef, localRef, signal)
  if (!fetched.ok) return fetched
  if (!oid.test(fetched.value)) {
    return err({ code: 'failed', message: 'The fetched request did not resolve to a commit.' })
  }
  await mkdir(parent, { recursive: true })
  const added = await worktrees.addWorktree(git.cwd, target, branch, 'create-branch', fetched.value)
  if (!added.ok) {
    const text = added.error.message.toLowerCase()
    return err({
      code: 'failed',
      message:
        text.includes('already') || text.includes('checked out')
          ? 'This request branch is already checked out in another worktree.'
          : 'Could not create the request worktree.',
    })
  }
  const after = await readPair(git, signal)
  if (
    !after.ok ||
    after.value.head !== before.value.head ||
    after.value.branch !== before.value.branch
  ) {
    if (inside(options.rootDir, target)) await worktrees.removeWorktree(git.cwd, target)
    return err({
      code: 'failed',
      message: 'Checkout moved the current worktree and was rolled back.',
    })
  }
  return ok({ path: target, branch, commit: fetched.value, number, created: true })
}

async function readCommit(
  git: RepositoryGit,
  ref: string,
  signal: AbortSignal,
): Promise<Result<string, SourceControlError>> {
  const parsed = await git.run(['rev-parse', '--verify', `${ref}^{commit}`], { signal })
  if (!parsed.ok) return parsed
  const commit = parsed.value.trim()
  return oid.test(commit)
    ? ok(commit)
    : err({ code: 'failed', message: 'The fetched request did not resolve to a commit.' })
}

async function readPair(
  git: RepositoryGit,
  signal: AbortSignal,
): Promise<Result<{ head: string; branch: string }, SourceControlError>> {
  const head = await git.run(['rev-parse', '--verify', 'HEAD'], { signal })
  if (!head.ok) return head
  const branch = await git.run(['rev-parse', '--abbrev-ref', 'HEAD'], { signal })
  if (!branch.ok) return branch
  return ok({ head: head.value.trim(), branch: branch.value.trim() })
}

async function findWorktree(
  rows: readonly { path: string; head: string; branch: string | null }[],
  target: string,
): Promise<(typeof rows)[number] | undefined> {
  const wanted = await canonicalize(target)
  for (const row of rows) {
    if (await samePath(row.path, wanted)) return row
  }
  return undefined
}

/** git reports the real path. macOS tmp is /var -> /private/var, and Windows may use an 8.3 name. */
async function canonicalize(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch {
    return resolve(path)
  }
}

async function samePath(left: string, right: string): Promise<boolean> {
  const a = await canonicalize(left)
  const b = await canonicalize(right)
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

function inside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child))
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel)
}
