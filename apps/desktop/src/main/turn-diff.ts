import type { GitService } from '@ari/engine/git'

export interface TurnDiffParams {
  /** Workspace root containing the session's git checkpoints. */
  path: string
  turnId: string
  /** The session's checkpoints in capture order. */
  checkpoints: readonly { turnId: string; gitRef: string }[]
}

export interface TurnDiffResult {
  /** Unified diff of what the turn changed; null when unavailable. */
  diffText: string | null
  error?: string
}

/**
 * Per-turn diff query (M8.4 over IPC): diffs the turn's checkpoint against the
 * next turn's checkpoint, or against the current working tree for the newest
 * turn, so the card shows only what that turn changed. A null diffText means
 * the query failed — no checkpoint for that turn, or git failed — with the
 * reason in `error`.
 */
export async function queryTurnDiff(
  git: Pick<GitService, 'diffForRef' | 'worktreeTree'>,
  params: TurnDiffParams,
): Promise<TurnDiffResult> {
  const at = params.checkpoints.findIndex((c) => c.turnId === params.turnId)
  const start = params.checkpoints[at]
  if (start === undefined) return { diffText: null, error: 'no checkpoint for that turn' }
  let end = params.checkpoints[at + 1]?.gitRef
  if (end === undefined) {
    const tree = await git.worktreeTree(params.path)
    if (!tree.ok) return { diffText: null, error: tree.error.message }
    end = tree.value
  }
  const result = await git.diffForRef(params.path, start.gitRef, end)
  if (!result.ok) return { diffText: null, error: result.error.message }
  return { diffText: result.value }
}
