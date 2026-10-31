import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { GitActions } from './GitActions'
import type { ReviewControlsState } from './ReviewWorkspace'

const invoke = vi.hoisted(() => vi.fn())
vi.mock('../../lib/rpc', () => ({ rpc: { invoke } }))
const file = {
  path: 'a.ts',
  kind: 'modified' as const,
  additions: 1,
  deletions: 1,
  binary: false,
  staged: true,
  unstaged: true,
}
const props: ReviewControlsState = {
  scope: { sessionId: 's' },
  paths: ['a.ts'],
  loading: false,
  refresh: vi.fn(),
  context: {
    status: {
      branch: 'feature/test',
      headOid: 'a'.repeat(40),
      upstream: 'origin/feature/test',
      ahead: 1,
      behind: 0,
      files: [file],
      remotes: [{ name: 'origin', url: 'https://example.org/repo.git' }],
      operation: null,
    },
    refs: [],
    commits: [],
    stashes: [],
    turns: [],
  },
  manifest: {
    id: 'a'.repeat(64),
    comparison: { kind: 'working-tree' },
    baseOid: 'b'.repeat(40),
    headOid: 'c'.repeat(40),
    baseLabel: 'HEAD',
    headLabel: 'Working tree',
    branch: 'feature/test',
    live: true,
    files: [file],
    truncated: false,
    checkedAt: 1,
  },
}
beforeEach(() => {
  invoke.mockReset()
  invoke.mockResolvedValue({ ok: true, value: { message: 'Committed locally. Push when ready.' } })
})

describe('explicit Git actions', () => {
  it('stages only selected paths and commits without implicitly staging or pushing', async () => {
    const user = userEvent.setup()
    render(<GitActions {...props} />)
    await user.click(screen.getByRole('button', { name: 'Stage selected' }))
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('scm.mutate', {
        sessionId: 's',
        action: { kind: 'stage', paths: ['a.ts'], snapshotId: props.manifest!.id },
      }),
    )
    invoke.mockClear()
    await user.type(screen.getByRole('textbox', { name: 'Commit message' }), 'Reviewed change')
    await user.click(screen.getByRole('button', { name: 'Commit' }))
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1))
    expect(invoke).toHaveBeenCalledWith('scm.mutate', {
      sessionId: 's',
      action: { kind: 'commit', message: 'Reviewed change', snapshotId: props.manifest!.id },
    })
    expect(await screen.findByRole('status')).toHaveTextContent('Committed locally')
  })

  it('requires confirmation for remote writes and leaves local commits intact on failed push', async () => {
    const user = userEvent.setup()
    invoke.mockResolvedValue({
      ok: false,
      error: { code: 'failed', message: 'Credentials unavailable' },
    })
    render(<GitActions {...props} />)
    await user.click(screen.getByRole('button', { name: 'Push' }))
    expect(invoke).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog')).toHaveTextContent('feature/test to origin')
    await user.click(screen.getByRole('button', { name: 'Confirm push' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('local commits are unchanged')
  })

  it('rejects stale confirmations and disables unseen staging in staged-only comparisons', async () => {
    const user = userEvent.setup()
    const { rerender } = render(<GitActions {...props} />)
    await user.click(screen.getByRole('button', { name: 'Discard selected' }))
    rerender(<GitActions {...props} manifest={{ ...props.manifest!, id: 'd'.repeat(64) }} />)
    expect(screen.getByRole('button', { name: 'Confirm discard' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    rerender(
      <GitActions {...props} manifest={{ ...props.manifest!, comparison: { kind: 'staged' } }} />,
    )
    expect(screen.getByRole('button', { name: 'Stage selected' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Unstage selected' })).toBeEnabled()
    expect(invoke).not.toHaveBeenCalled()
  })
})
