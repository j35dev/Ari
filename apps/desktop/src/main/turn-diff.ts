import type { GitService } from '@ari/engine/git'

export interface TurnDiffParams {
  /** Workspace root containing the session's git checkpoints. */
  path: string
  turnId: string
  /** The session's checkpoints in capture order. */
  checkpoints: readonly { turnId: string; gitRef: string; endRef?: string; endError?: string }[]
}

export interface TurnDiffResult {
  /** Unified diff of what the turn changed; null when unavailable. */
  diffText: string | null
  error?: string
}

/**
 * Diffs immutable before/after snapshots. Legacy turns without an end capture
 * retain the next-checkpoint/live fallback; failed new captures never pretend
 * that later work belongs to the turn.
 */
export async function queryTurnDiff(
  git: Pick<GitService, 'diffForRef' | 'worktreeTree'>,
  params: TurnDiffParams,
): Promise<TurnDiffResult> {
  const at = params.checkpoints.findIndex((c) => c.turnId === params.turnId)
  const start = params.checkpoints[at]
  if (start === undefined) return { diffText: null, error: 'no checkpoint for that turn' }
  if (start.endError) return { diffText: null, error: start.endError }
  let end = start.endRef ?? params.checkpoints[at + 1]?.gitRef
  if (end === undefined) {
    const tree = await git.worktreeTree(params.path)
    if (!tree.ok) return { diffText: null, error: tree.error.message }
    end = tree.value
  }
  const result = await git.diffForRef(params.path, start.gitRef, end)
  if (!result.ok) return { diffText: null, error: result.error.message }
  return { diffText: result.value }
}
