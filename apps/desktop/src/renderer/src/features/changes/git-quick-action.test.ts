import { describe, expect, it } from 'vitest'
import type { GitPullRequest, GitSummary } from '@ari/contracts/rpc'
import { menuActions, pushesToDefault, quickAction } from './git-quick-action'

const base: GitSummary = {
  branch: 'feature',
  changedFiles: 0,
  upstream: 'origin/feature',
  ahead: 0,
  behind: 0,
  hasRemote: true,
  operation: null,
}
const pr: GitPullRequest = {
  number: 7,
  title: 'x',
  url: 'https://g/pr/7',
  state: 'open',
  isDraft: false,
}
const label = (summary: Partial<GitSummary>, open: GitPullRequest | null = null) =>
  quickAction({ ...base, ...summary }, open).label

describe('quickAction', () => {
  it('commits, pushes and opens a PR from a feature branch with changes', () => {
    expect(quickAction({ ...base, changedFiles: 3 }, null)).toEqual({
      kind: 'ship',
      action: 'commit_push_pr',
      label: 'Commit, push & PR',
      commits: true,
    })
  })

  it('only commits and pushes once a PR is open or on the default branch', () => {
    expect(label({ changedFiles: 1 }, pr)).toBe('Commit & push')
    expect(label({ changedFiles: 1, branch: 'main', upstream: 'origin/main' })).toBe(
      'Commit & push',
    )
  })

  it('only commits without a remote', () => {
    expect(label({ changedFiles: 1, hasRemote: false, upstream: null })).toBe('Commit')
  })

  it('pushes local commits, publishing a new branch with its PR', () => {
    expect(label({ ahead: 2 })).toBe('Push & create PR')
    expect(label({ upstream: null })).toBe('Push & create PR')
    expect(label({ ahead: 2 }, pr)).toBe('Push')
  })

  it('pulls when behind and refuses when diverged', () => {
    expect(label({ behind: 1 })).toBe('Pull')
    expect(quickAction({ ...base, ahead: 1, behind: 1 }, null)).toMatchObject({ kind: 'disabled' })
  })

  it('views an open PR, or offers one, when clean and in sync', () => {
    expect(quickAction(base, pr)).toEqual({ kind: 'view-pr', label: 'View PR', url: pr.url })
    expect(label({})).toBe('Create PR')
    expect(label({ branch: 'main', upstream: 'origin/main' })).toBe('Up to date')
  })

  it('waits out a merge or rebase', () => {
    expect(quickAction({ ...base, changedFiles: 2, operation: 'rebase' }, null)).toMatchObject({
      kind: 'disabled',
      reason: 'Finish the rebase first.',
    })
  })
})

describe('menuActions', () => {
  it('explains every step that cannot run', () => {
    const items = menuActions({ ...base, branch: 'main', upstream: 'origin/main' }, null)
    expect(Object.fromEntries(items.map((item) => [item.id, item.reason]))).toEqual({
      commit: 'There are no changes to commit.',
      push: 'No local commits to push.',
      pull: 'Already up to date.',
      pr: 'Switch to a feature branch to open a pull request.',
    })
  })
})

describe('pushesToDefault', () => {
  it('flags pushes to main only', () => {
    expect(pushesToDefault({ ...base, branch: 'main' }, 'commit_push')).toBe(true)
    expect(pushesToDefault(base, 'commit_push')).toBe(false)
    expect(pushesToDefault({ ...base, branch: 'main' }, 'commit')).toBe(false)
  })
})
