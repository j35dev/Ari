import type { GitError } from '@ari/engine/git'
import type { Result } from '@ari/shared/result'

export interface TurnDiffParams {
  /** Workspace root containing the session's git checkpoints. */
  path: string
  sessionId: string
  turnId: string
}

export interface TurnDiffResult {
  /** Unified diff against the turn's checkpoint; null when unavailable. */
  diffText: string | null
  error?: string
}

/**
 * Per-turn diff query (M8.4 over IPC): diffs the current worktree against
 * the turn's hidden checkpoint ref `refs/ari/<sessionId>/<turnId>`. A null
 * diffText means the query failed — no checkpoint captured for that turn,
 * outside a repo, or git missing — with the reason in `error`.
 */
export async function queryTurnDiff(
  diffForRef: (cwd: string, gitRef: string) => Promise<Result<string, GitError>>,
  params: TurnDiffParams,
): Promise<TurnDiffResult> {
  const result = await diffForRef(params.path, `refs/ari/${params.sessionId}/${params.turnId}`)
  if (!result.ok) return { diffText: null, error: result.error.message }
  return { diffText: result.value }
}
