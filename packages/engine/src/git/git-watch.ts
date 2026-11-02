import { watch } from 'chokidar'
import { resolve } from 'node:path'
import { RepositoryGit } from './repository-git'
import type { SourceControlError } from '@ari/contracts/rpc'
import { err, ok, type Result } from '@ari/shared/result'
import { createLogger } from '@ari/shared/logger'

const log = createLogger('engine:git-watch')

/**
 * Watches a worktree's Git metadata (HEAD, index, refs), ignoring object churn.
 * The worktree itself is not watched: chokidar walking a large repo took 30s+
 * and stalled the main process for seconds. Worktree edits refresh through
 * turn checkpoints and window focus instead.
 */
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
    await metadata.close()
  }
  metadata.on('all', changed)
  metadata.on('error', (error: unknown) => {
    log.warn('Git watcher failed', { error: String(error) })
    if (!closed) onChange('Live refresh is unavailable. Refresh manually to retry.')
  })
  try {
    await new Promise<void>((resolve, reject) => {
      metadata.once('ready', resolve)
      metadata.once('error', reject)
    })
    return ok(close)
  } catch {
    await close()
    return err({ code: 'unavailable', message: 'Live Git refresh could not start.' })
  }
}
