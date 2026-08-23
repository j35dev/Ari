export { DIFF_MAX_BYTES, GitService, newDefaultCapturer } from './git-service'
export type {
  CheckpointInfo,
  GitError,
  GitErrorCode,
  GitServiceOptions,
  GitStatus,
  StatusEntry,
  StatusKind,
  WorktreeInfo,
} from './git-service'
export {
  ensureSessionWorktree,
  isValidSessionId,
  newDefaultWorktreeSource,
  SESSION_WORKTREE_ROOT,
  sessionWorktreeBranch,
  sessionWorktreePath,
  WORKTREE_BRANCH_PREFIX,
} from './session-worktree'
export type { WorktreeGitOps } from './session-worktree'
