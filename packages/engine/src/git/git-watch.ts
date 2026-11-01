import { watch } from 'chokidar'
import { relative, resolve } from 'node:path'
import { RepositoryGit } from './repository-git'
import type { SourceControlError } from '@ari/contracts/rpc'
import { err, ok, type Result } from '@ari/shared/result'
import { createLogger } from '@ari/shared/logger'

const log = createLogger('engine:git-watch')
const excluded = new Set([
  '.git',
  '.ari',
  '.worktrees',
  'node_modules',
  'dist',
  'out',
  'build',
  'coverage',
  'target',
  '.venv',
  'vendor',
  '.next',
  '.turbo',
])

/** Watches one visible worktree and its Git metadata, ignoring snapshot/object churn. */
export async function watchGitChanges(
  cwd: string,
  onChange: (error?: string) => void,
): Promise<Result<() => Promise<void>, SourceControlError>> {
  const result = await new RepositoryGit(cwd).run(['rev-parse', '--git-dir', '--git-common-dir'])
  if (!result.ok) return result
  const [gitDir, commonDir] = result.value
    .trim()
    .split('\n')
    .map((path) => resolve(cwd, path))
  if (!gitDir || !commonDir)
    return err({ code: 'unavailable', message: 'Git metadata is unavailable.' })
  let timer: ReturnType<typeof setTimeout> | undefined
  let closed = false
  const changed = (): void => {
    if (closed || timer) return
    timer = setTimeout(() => {
      timer = undefined
      if (!closed) onChange()
    }, 300)
  }
  const files = watch(cwd, {
    ignoreInitial: true,
    followSymlinks: false,
    ignored: (path) =>
      relative(cwd, path)
        .split(/[\\/]/)
        .some((part) => excluded.has(part)),
  })
  const metadata = watch(
    [
      ...[
        'HEAD',
        'index',
        'MERGE_HEAD',
        'CHERRY_PICK_HEAD',
        'REVERT_HEAD',
        'rebase-merge',
        'rebase-apply',
      ].map((path) => resolve(gitDir, path)),
      ...['refs/heads', 'refs/remotes', 'refs/stash', 'packed-refs', 'config'].map((path) =>
        resolve(commonDir, path),
      ),
    ],
    { ignoreInitial: true, followSymlinks: false },
  )
  const close = async (): Promise<void> => {
    closed = true
    clearTimeout(timer)
    await Promise.all([files.close(), metadata.close()])
  }
  const ready = (watcher: typeof files): Promise<void> =>
    new Promise((resolve, reject) => {
      watcher.once('ready', resolve)
      watcher.once('error', reject)
    })
  for (const watcher of [files, metadata]) {
    watcher.on('all', changed)
    watcher.on('error', (error: unknown) => {
      log.warn('Git watcher failed', { error: String(error) })
      if (!closed) onChange('Live refresh is unavailable. Refresh manually to retry.')
    })
  }
  try {
    await Promise.all([ready(files), ready(metadata)])
    return ok(close)
  } catch {
    await close()
    return err({ code: 'unavailable', message: 'Live Git refresh could not start.' })
  }
}

/**
 * Watches `refs/heads/<branch>` in the repository at `cwd` and calls
 * `onCommit` once each time the branch moves to a commit it was not on. Work
 * tree edits, staging, and other branches never reach it.
 */
export async function watchBranchHead(
  cwd: string,
  branch: string,
  onCommit: (sha: string) => void,
): Promise<Result<() => Promise<void>, SourceControlError>> {
  const git = new RepositoryGit(cwd)
  const common = await git.run(['rev-parse', '--git-common-dir'])
  if (!common.ok) return common
  const commonDir = resolve(cwd, common.value.trim())
  const head = async (): Promise<string | null> => {
    const result = await git.run([
      'rev-parse',
      '--verify',
      '--quiet',
      `refs/heads/${branch}^{commit}`,
    ])
    return result.ok ? result.value.trim() : null
  }
  let seen = await head()
  let reading = Promise.resolve()
  let closed = false
  // Branch updates always land as a loose ref, even for a packed branch. One
  // path only: with several, chokidar reports ready before it scans them all.
  const watcher = watch(resolve(commonDir, 'refs/heads'), {
    ignoreInitial: true,
    followSymlinks: false,
  })
  watcher.on('all', () => {
    reading = reading.then(async () => {
      const sha = await head()
      if (closed || sha === null || sha === seen) return
      seen = sha
      onCommit(sha)
    })
  })
  watcher.on('error', (error: unknown) => {
    log.warn('Branch watcher failed', { branch, error: String(error) })
  })
  const close = async (): Promise<void> => {
    closed = true
    await watcher.close()
  }
  try {
    await new Promise<void>((resolve, reject) => {
      watcher.once('ready', () => resolve())
      watcher.once('error', reject)
    })
    return ok(close)
  } catch {
    await close()
    return err({ code: 'unavailable', message: 'Branch watch could not start.' })
  }
}
