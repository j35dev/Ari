import type { GitPullRequest, GitShipAction, GitSummary } from '@ari/contracts/rpc'

/** Branches a pull request merges into, where Ari offers no PR of their own. */
const DEFAULT_BRANCHES = new Set(['main', 'master', 'trunk', 'develop'])

export type QuickAction =
  | { kind: 'ship'; action: GitShipAction; label: string; commits: boolean }
  | { kind: 'view-pr'; label: string; url: string }
  | { kind: 'disabled'; label: string; reason: string }

export interface MenuAction {
  id: 'commit' | 'push' | 'pull' | 'pr'
  label: string
  /** Why the item cannot run now; null when it can. */
  reason: string | null
}

const commits = (action: GitShipAction): boolean => action.startsWith('commit')

function ship(action: GitShipAction, label: string): QuickAction {
  return { kind: 'ship', action, label, commits: commits(action) }
}

/** The one thing the Git button does next, from branch state alone. */
export function quickAction(summary: GitSummary, pr: GitPullRequest | null): QuickAction {
  const { branch, changedFiles, upstream, ahead, behind, hasRemote, operation } = summary
  if (operation)
    return { kind: 'disabled', label: 'Commit', reason: `Finish the ${operation} first.` }
  const onDefault = branch !== null && DEFAULT_BRANCHES.has(branch)
  const openPr = pr?.state === 'open' ? pr : null
  if (changedFiles > 0) {
    if (!hasRemote || !branch) return ship('commit', 'Commit')
    if (openPr || onDefault) return ship('commit_push', 'Commit & push')
    return summary.canCreateRequest === false
      ? ship('commit_push', 'Commit & push')
      : ship(
          'commit_push_pr',
          summary.requestKind === 'merge' ? 'Commit, push & MR' : 'Commit, push & PR',
        )
  }
  if (!branch)
    return {
      kind: 'disabled',
      label: 'Push',
      reason: 'HEAD is detached. Check out a branch first.',
    }
  if (ahead > 0 && behind > 0)
    return {
      kind: 'disabled',
      label: 'Push',
      reason: 'This branch has diverged from its upstream. Rebase or merge first.',
    }
  if (behind > 0) return ship('pull', 'Pull')
  if (hasRemote && (ahead > 0 || !upstream))
    return openPr || onDefault || summary.canCreateRequest === false
      ? ship('push', 'Push')
      : ship('push_pr', summary.requestKind === 'merge' ? 'Push & create MR' : 'Push & create PR')
  if (openPr) return { kind: 'view-pr', label: 'View PR', url: openPr.url }
  if (hasRemote && upstream && !onDefault && summary.canCreateRequest !== false)
    return ship('create_pr', summary.requestKind === 'merge' ? 'Create MR' : 'Create PR')
  return {
    kind: 'disabled',
    label: 'Up to date',
    reason: 'No changes to commit and nothing to push.',
  }
}

/** The menu's individual steps, each with the reason it is unavailable. */
export function menuActions(summary: GitSummary, pr: GitPullRequest | null): MenuAction[] {
  const { branch, changedFiles, upstream, ahead, behind, hasRemote, operation } = summary
  const busy = operation ? `Finish the ${operation} first.` : null
  const openPr = pr?.state === 'open' ? pr : null
  return [
    {
      id: 'commit',
      label: 'Commit…',
      reason: busy ?? (changedFiles === 0 ? 'There are no changes to commit.' : null),
    },
    {
      id: 'push',
      label: upstream ? 'Push' : 'Publish branch',
      reason:
        busy ??
        (!hasRemote
          ? 'Add a Git remote to push.'
          : !branch
            ? 'HEAD is detached.'
            : ahead > 0 && behind > 0
              ? 'This branch has diverged from its upstream.'
              : upstream && ahead === 0
                ? 'No local commits to push.'
                : null),
    },
    {
      id: 'pull',
      label: 'Pull',
      reason:
        busy ??
        (!upstream ? 'This branch has no upstream.' : behind === 0 ? 'Already up to date.' : null),
    },
    {
      id: 'pr',
      label: openPr
        ? `View ${summary.requestKind === 'merge' ? 'MR' : 'PR'} #${openPr.number}`
        : summary.requestKind === 'merge'
          ? 'Create MR'
          : 'Create PR',
      reason: openPr
        ? null
        : summary.canCreateRequest === false
          ? 'Connect this hosting instance in Source control settings.'
          : !hasRemote
            ? 'Add a Git remote to open a pull request.'
            : branch !== null && DEFAULT_BRANCHES.has(branch)
              ? 'Switch to a feature branch to open a pull request.'
              : !upstream
                ? 'Push the branch first.'
                : null,
    },
  ]
}

/** Whether running `action` publishes to a default branch (worth a confirm). */
export function pushesToDefault(summary: GitSummary, action: GitShipAction): boolean {
  return (
    summary.branch !== null &&
    DEFAULT_BRANCHES.has(summary.branch) &&
    (action === 'commit_push' || action === 'push')
  )
}
