export { DIFF_MAX_BYTES, GitService, newDefaultCapturer } from './git-service'
export { ManagedWorkspaces } from './managed-workspaces'
export { GitReviewService } from './git-review'
export { RepositoryGit } from './repository-git'
export { GitMutationService } from './git-mutations'
export { readGitHistory } from './git-history'
export { watchGitChanges } from './git-watch'
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
