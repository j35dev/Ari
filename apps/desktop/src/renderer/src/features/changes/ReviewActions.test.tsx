import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReviewControlsState } from './ReviewWorkspace'
import { ReviewActions } from './ReviewActions'

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('../../lib/rpc', () => ({ rpc: mocks }))
const snapshot = 'a'.repeat(64)
const props = (): ReviewControlsState => ({
  scope: { sessionId: 'child-worktree' },
  context: {
    status: {
      branch: 'feature',
      upstream: 'origin/feature',
      remotes: [{ name: 'origin', url: 'https://github.com/team/demo' }],
      files: [{ path: 'src/[file].ts', staged: true, unstaged: true }],
    },
    refs: [],
    stashes: [],
  } as unknown as ReviewControlsState['context'],
  manifest: {
    id: snapshot,
    comparison: { kind: 'working-tree' },
  } as ReviewControlsState['manifest'],
  paths: ['src/[file].ts'],
  loading: false,
  refresh: vi.fn(),
})
beforeEach(() =>
  mocks.invoke.mockReset().mockResolvedValue({ ok: true, value: { message: 'Completed.' } }),
)

describe('review Git controls', () => {
  it('stages the selected literal paths against the reviewed child snapshot', async () => {
    const user = userEvent.setup()
    const state = props()
    render(<ReviewActions {...state} />)
    await user.click(screen.getByRole('button', { name: 'Stage' }))
    expect(mocks.invoke).toHaveBeenCalledWith('scm.mutate', {
      sessionId: 'child-worktree',
      action: { kind: 'stage', snapshotId: snapshot, paths: ['src/[file].ts'] },
    })
    await waitFor(() => expect(state.refresh).toHaveBeenCalled())
  })

  it('requires confirmation before discard and preserves a failed commit message', async () => {
    const user = userEvent.setup()
    render(<ReviewActions {...props()} />)
    await user.click(screen.getByRole('button', { name: 'Discard selected changes' }))
    expect(mocks.invoke).not.toHaveBeenCalled()
    expect(screen.getByText(/recovery checkpoint first/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    await user.click(screen.getByRole('button', { name: 'Commit staged (1)' }))
    await user.type(
      screen.getByRole('textbox', { name: 'Commit staged message' }),
      'Keep this message',
    )
    mocks.invoke.mockResolvedValueOnce({
      ok: false,
      error: { code: 'stale', message: 'HEAD changed. Refresh.' },
    })
    await user.click(screen.getByRole('button', { name: 'Commit' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('HEAD changed')
    expect(screen.getByRole('textbox', { name: 'Commit staged message' })).toHaveValue(
      'Keep this message',
    )
  })
})
