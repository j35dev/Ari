import { DIFF_MAX_BYTES, RepositoryGit, parseReviewFiles, type GitService } from '@ari/engine/git'
import { sourceControlSchemas, type GitTurnDiffSummary } from '@ari/contracts/rpc'

export interface TurnDiffParams {
  /** Workspace root containing the session's git checkpoints. */
  path: string
  turnId: string
  /** The session's checkpoints in capture order. */
  checkpoints: readonly { turnId: string; gitRef: string; endRef?: string; endError?: string }[]
}

export interface TurnDiffResult {
  /** Complete unified diff; null when summarized or unavailable. */
  diffText: string | null
  summary?: GitTurnDiffSummary
  error?: string
}

/**
 * Diffs immutable before/after snapshots. Legacy turns without an end capture
 * retain the next-checkpoint/live fallback; failed new captures never pretend
 * that later work belongs to the turn.
 */
export async function queryTurnDiff(
  git: Pick<GitService, 'isRepo' | 'diffForRef' | 'worktreeTree'>,
  params: TurnDiffParams,
): Promise<TurnDiffResult> {
  const at = params.checkpoints.findIndex((c) => c.turnId === params.turnId)
  const start = params.checkpoints[at]
  if (start === undefined) return { diffText: null }
  // A workspace can stop being a repository after a checkpoint was captured.
  const inside = await git.isRepo(params.path)
  if (!inside.ok) return { diffText: null, error: inside.error.message }
  if (!inside.value) return { diffText: null }
  if (start.endError) return { diffText: null, error: start.endError }
  let end = start.endRef ?? params.checkpoints[at + 1]?.gitRef
  if (end === undefined) {
    const tree = await git.worktreeTree(params.path)
    if (!tree.ok) return { diffText: null, error: tree.error.message }
    end = tree.value
  }
  const result = await git.diffForRef(params.path, start.gitRef, end)
  if (!result.ok) {
    if (result.error.code === 'diff_too_large') {
      return summarizeTurnDiff(params.path, start.gitRef, end)
    }
    return { diffText: null, error: result.error.message }
  }
  return { diffText: result.value }
}

/** Read metadata, never a truncated patch; pin lazy file reads to the same trees. */
async function summarizeTurnDiff(
  path: string,
  base: string,
  head: string,
): Promise<TurnDiffResult> {
  const git = new RepositoryGit(path)
  const baseTree = await git.run(['rev-parse', '--verify', '--end-of-options', `${base}^{tree}`])
  if (!baseTree.ok) return { diffText: null, error: baseTree.error.message }
  const headTree = await git.run(['rev-parse', '--verify', '--end-of-options', `${head}^{tree}`])
  if (!headTree.ok) return { diffText: null, error: headTree.error.message }
  const baseOid = baseTree.value.trim()
  const headOid = headTree.value.trim()
  const prefix = await git.run(['rev-parse', '--show-prefix'])
  if (!prefix.ok) return { diffText: null, error: prefix.error.message }
  const args = [
    'diff',
    '--no-ext-diff',
    '--no-textconv',
    '--no-color',
    '--relative',
    prefix.value.trim() ? '--no-renames' : '--find-renames',
  ]
  const [names, counts] = await Promise.all([
    git.run([...args, '--name-status', '-z', baseOid, headOid, '--']),
    git.run([...args, '--numstat', '-z', baseOid, headOid, '--']),
  ])
  if (!names.ok) return { diffText: null, error: names.error.message }
  if (!counts.ok) return { diffText: null, error: counts.error.message }
  return {
    diffText: null,
    summary: { baseOid, headOid, files: parseReviewFiles(names.value, counts.value, []) },
  }
}

/** One complete, bounded patch from the trees returned by the turn summary. */
export async function queryTurnDiffFile(
  workspace: string,
  params: { baseOid: string; headOid: string; path: string; oldPath?: string },
): Promise<{ diffText: string | null; tooLarge?: boolean; error?: string }> {
  const baseOid = sourceControlSchemas.oid.parse(params.baseOid)
  const headOid = sourceControlSchemas.oid.parse(params.headOid)
  const path = sourceControlSchemas.path.parse(params.path)
  const oldPath = sourceControlSchemas.path.optional().parse(params.oldPath)
  const result = await new RepositoryGit(workspace).run(
    [
      '--literal-pathspecs',
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--no-color',
      '--relative',
      '--find-renames',
      baseOid,
      headOid,
      '--',
      path,
      ...(oldPath ? [oldPath] : []),
    ],
    { maxBytes: DIFF_MAX_BYTES },
  )
  if (!result.ok) {
    return result.error.code === 'too-large'
      ? { diffText: null, tooLarge: true }
      : { diffText: null, error: result.error.message }
  }
  return { diffText: result.value }
}
