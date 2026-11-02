import type { SourceControlError, SourceControlStatus } from '@ari/contracts/rpc'
import { err, ok, type Result } from '@ari/shared/result'
import type { RepositoryGit } from './repository-git'

/** What ship reads and runs Git through; GitReviewService satisfies it. */
export interface ShipRepository {
  readonly git: RepositoryGit
  /** Status with scope-relative paths and the in-progress operation, if any. */
  status(signal?: AbortSignal): Promise<Result<SourceControlStatus, SourceControlError>>
}

/** One-click Git flows, in the order they run: commit, then push, then the pull request. */
export type ShipAction =
  'commit' | 'commit_push' | 'commit_push_pr' | 'push' | 'push_pr' | 'pull' | 'create_pr'

export interface ShipInput {
  action: ShipAction
  /** Blank means a message is written from the file list. */
  message?: string
  /** Files to commit; omitted commits every change. */
  paths?: string[]
}

export interface ShipOutcome {
  /** Subject of the commit made, when one was. */
  committed: string | null
  pushed: boolean
  pulled: boolean
  prUrl: string | null
}

export interface ShipDeps {
  /** Opens a pull request for the pushed branch and answers its URL. */
  createPr(signal?: AbortSignal): Promise<Result<string | null, SourceControlError>>
}

const NETWORK_MS = 120_000

/** Runs a commit / push / pull / PR flow as one action, stopping at the first failure. */
export async function ship(
  repository: ShipRepository,
  input: ShipInput,
  deps: ShipDeps,
  signal?: AbortSignal,
): Promise<Result<ShipOutcome, SourceControlError>> {
  const git = repository.git
  const read = await repository.status(signal)
  if (!read.ok) return read
  const status = read.value
  if (status.operation)
    return err({ code: 'busy', message: `Finish the ${status.operation} in progress first.` })
  const outcome: ShipOutcome = { committed: null, pushed: false, pulled: false, prUrl: null }
  const action = input.action

  if (action === 'commit' || action === 'commit_push' || action === 'commit_push_pr') {
    const chosen = input.paths
      ? status.files.filter((file) => input.paths!.includes(file.path))
      : status.files
    if (chosen.length === 0) return err({ code: 'invalid-input', message: 'Nothing to commit.' })
    if (input.paths) {
      const reset = await git.run(['reset', '-q'], { signal, detail: true })
      if (!reset.ok) return reset
      const added = await git.run(['add', '-A', '--', ...chosen.map((file) => file.path)], {
        signal,
        detail: true,
      })
      if (!added.ok) return added
    } else {
      const added = await git.run(['add', '-A', '--', '.'], { signal, detail: true })
      if (!added.ok) return added
    }
    const message = input.message?.trim() || defaultCommitMessage(chosen.map((file) => file.path))
    const committed = await git.run(['commit', '-F', '-'], {
      signal,
      input: message,
      timeoutMs: NETWORK_MS,
      detail: true,
    })
    if (!committed.ok) return committed
    outcome.committed = message.split('\n')[0] ?? message
  }

  if (action === 'pull') {
    if (!status.upstream)
      return err({ code: 'invalid-input', message: 'This branch has no upstream to pull from.' })
    const pulled = await git.run(['pull', '--ff-only'], {
      signal,
      timeoutMs: NETWORK_MS,
      detail: true,
    })
    if (!pulled.ok) return pulled
    outcome.pulled = true
    return ok(outcome)
  }

  if (action !== 'commit' && action !== 'create_pr') {
    if (!status.branch)
      return err({ code: 'invalid-input', message: 'Create a branch before pushing.' })
    let args = ['push']
    if (!status.upstream) {
      const remotes = await git.run(['remote'], { signal })
      if (!remotes.ok) return remotes
      const names = remotes.value
        .split('\n')
        .map((name) => name.trim())
        .filter(Boolean)
      const remote = names.includes('origin') ? 'origin' : names[0]
      if (!remote)
        return err({ code: 'invalid-input', message: 'Add a Git remote before pushing.' })
      args = ['push', '--set-upstream', remote, 'HEAD']
    }
    const pushed = await git.run(args, { signal, timeoutMs: NETWORK_MS, detail: true })
    if (!pushed.ok) return pushed
    outcome.pushed = true
  }

  if (action === 'commit_push_pr' || action === 'push_pr' || action === 'create_pr') {
    const pr = await deps.createPr(signal)
    if (!pr.ok) return pr
    outcome.prUrl = pr.value
  }
  return ok(outcome)
}

/** A plain commit subject from the files it covers, for when none was typed. */
export function defaultCommitMessage(paths: readonly string[]): string {
  const names = paths.map((path) => path.split(/[\\/]/).pop() ?? path)
  if (names.length === 1) return `Update ${names[0]}`
  if (names.length === 2) return `Update ${names[0]} and ${names[1]}`
  return `Update ${names.length} files`
}
