import { randomUUID } from 'node:crypto'
import { lstat, realpath, rm } from 'node:fs/promises'
import { relative, resolve, isAbsolute, sep } from 'node:path'
import type { GitMutation, GitMutationOutcome, SourceControlError } from '@ari/contracts/rpc'
import { err, ok, type Result } from '@ari/shared/result'
import { createLogger } from '@ari/shared/logger'
import type { GitReviewService } from './git-review'

const log = createLogger('engine:git-mutations')

/** Serializes reviewed Git mutations and refuses stale state or an active writer. */
export class GitMutationService {
  #tail: Promise<unknown> = Promise.resolve()
  constructor(readonly review: GitReviewService, readonly isBusy: () => Promise<boolean>) {}

  run(input: GitMutation): Promise<Result<GitMutationOutcome, SourceControlError>> {
    const task = this.#tail.then(() => this.#apply(input)).catch((error: unknown) => {
      log.warn('Git mutation failed', { kind: input.kind, error: String(error) })
      return err<SourceControlError>({ code: 'failed', message: 'The Git operation failed. Refresh to inspect repository state.' })
    })
    this.#tail = task.catch(() => undefined)
    return task
  }

  async #apply(input: GitMutation): Promise<Result<GitMutationOutcome, SourceControlError>> {
    if (await this.isBusy()) return err({ code: 'busy', message: 'Stop the agent before changing this worktree.' })
    const saved = this.review.getSnapshot(input.snapshotId)
    if (!saved || !['working-tree', 'staged', 'unstaged'].includes(saved.comparison.kind)) {
      return err({ code: 'stale', message: 'Review the current working tree before this action.' })
    }
    const current = await this.review.manifest(saved.comparison)
    if (!current.ok) return current
    if (current.value.id !== input.snapshotId) return err({ code: 'stale', message: 'Files, index or HEAD changed. Refresh and review before retrying.' })
    const status = await this.review.status()
    if (!status.ok) return status
    if (status.value.operation) return err({ code: 'busy', message: `Finish the active ${status.value.operation} before changing source control.` })
    const git = this.review.git
    const prefix = await git.run(['rev-parse', '--show-prefix'])
    if (!prefix.ok) return prefix
    if (prefix.value.trim()) return err({ code: 'unsupported', message: 'Open the repository root to change source control; this project is a subdirectory.' })
    const selected = 'paths' in input ? [...new Set(input.paths)] : []
    if (selected.some((path) => !status.value.files.some((file) => file.path === path))) {
      return err({ code: 'stale', message: 'A selected file is no longer changed.' })
    }
    let args: string[]
    let stdin: string | undefined
    let recoveryRef: string | undefined
    let removePaths: string[] = []
    if (input.kind === 'stage' || input.kind === 'unstage') {
      const paths = selected.flatMap((path) => {
        const file = status.value.files.find((file) => file.path === path)
        return file?.oldPath ? [file.oldPath, path] : [path]
      })
      stdin = paths.join('\0') + '\0'
      args = input.kind === 'stage' ? ['add', '--pathspec-from-file=-', '--pathspec-file-nul'] :
        status.value.headOid ? ['restore', '--staged', '--pathspec-from-file=-', '--pathspec-file-nul'] :
          ['rm', '--cached', '--ignore-unmatch', '--pathspec-from-file=-', '--pathspec-file-nul']
    } else if (input.kind === 'discard') {
      const capture = await this.review.checkpoints.captureCheckpoint(this.review.cwd, 'recovery', randomUUID())
      if (!capture.ok || !capture.value) return err({ code: 'failed', message: 'Could not create a recovery checkpoint. Nothing was discarded.' })
      recoveryRef = capture.value
      const tracked = selected.filter((path) => status.value.files.find((file) => file.path === path)?.kind !== 'untracked')
      for (const path of selected) {
        const target = resolve(this.review.cwd, path)
        const info = await lstat(target).catch(() => null)
        if (info?.isDirectory()) return err({ code: 'unsupported', message: 'Directory changes must be reviewed in their own repository.' })
        const parent = await realpath(resolve(target, '..'))
        const root = await realpath(this.review.cwd)
        const part = relative(root, parent)
        if (part === '..' || part.startsWith(`..${sep}`) || isAbsolute(part)) return err({ code: 'invalid-input', message: 'The selected file is outside this worktree.' })
      }
      removePaths = selected.filter((path) => !tracked.includes(path))
      args = tracked.length ? ['restore', '--worktree', '--pathspec-from-file=-', '--pathspec-file-nul'] : []
      stdin = tracked.join('\0') + '\0'
    } else if (input.kind === 'commit') {
      if (!status.value.files.some((file) => file.staged)) return err({ code: 'invalid-input', message: 'Stage at least one file before committing.' })
      args = ['commit', '-F', '-']; stdin = input.message
    } else if (input.kind === 'push' || input.kind === 'fetch') {
      if (!status.value.remotes.some((remote) => remote.name === input.remote)) return err({ code: 'invalid-input', message: 'Choose a configured Git remote.' })
      if (input.kind === 'push' && !status.value.branch) return err({ code: 'invalid-input', message: 'Create a branch before pushing detached HEAD.' })
      args = input.kind === 'push' ? ['push', '--set-upstream', input.remote, 'HEAD'] : ['fetch', '--prune', input.remote]
    } else if (input.kind === 'stash') {
      args = ['stash', 'push', '--include-untracked', '-m', input.message || 'Ari saved work']
    } else {
      if (status.value.files.length) return err({ code: 'busy', message: 'Commit or stash changes before switching, pulling or applying a stash.' })
      if (input.kind === 'pull') args = ['pull', '--ff-only']
      else if (input.kind === 'branch') args = ['switch', ...(input.create ? ['-c'] : []), input.name]
      else {
        const stashes = await git.run(['stash', 'list', '--format=%H'])
        if (!stashes.ok) return stashes
        if (!stashes.value.split('\n').includes(input.oid)) return err({ code: 'stale', message: 'This stash no longer exists.' })
        args = ['stash', 'apply', '--index', input.oid]
      }
    }
    if (await this.isBusy()) return err({ code: 'busy', message: 'An agent started writing. Stop it and review again.' })
    const fresh = await this.review.manifest(saved.comparison)
    if (!fresh.ok) return fresh
    if (fresh.value.id !== input.snapshotId) return err({ code: 'stale', message: 'The worktree changed while preparing this action. Refresh and review again.' })
    const result = args.length ? await git.run(['--literal-pathspecs', ...args], { input: stdin, timeoutMs: 120_000 }) : ok('')
    if (!result.ok) return err({ ...result.error, message: recoveryRef ? `${result.error.message} Recovery: ${recoveryRef}` : result.error.message })
    const stuck: string[] = []
    for (const path of removePaths) {
      try {
        await rm(resolve(this.review.cwd, path), { force: true })
      } catch (error) {
        log.warn('discard removal failed', { path, error: String(error) })
        stuck.push(path)
      }
    }
    if (stuck.length > 0) {
      const detail = `Could not remove ${stuck.join(', ')}.`
      return err({ code: 'failed', message: recoveryRef ? `${detail} Recovery: ${recoveryRef}` : detail })
    }
    return ok({ ...(recoveryRef ? { recoveryRef } : {}), message: input.kind === 'commit' ? 'Committed locally. Push when ready.' : `${input.kind} completed.` })
  }
}
