import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { ChildSessionActivity } from './ChildSessionActivity'

it('replays lifecycle records and navigates only when the child is clicked', async () => {
  const open = vi.fn()
  render(
    <ChildSessionActivity
      onOpen={open}
      events={[
        {
          type: 'child.session.spawned',
          seq: 1,
          at: 1,
          sessionId: 'root',
          childSessionId: 'child',
          title: 'Worker',
          driverKind: 'claude',
          modelId: null,
          workspaceKind: 'managed-worktree',
          branch: 'ari/worker',
        },
        {
          type: 'child.session.integrated',
          seq: 2,
          at: 2,
          sessionId: 'root',
          childSessionId: 'child',
          snapshotCommit: 'a'.repeat(40),
          result: 'conflict',
          conflictFiles: ['file.ts'],
        },
      ]}
    />,
  )
  expect(open).not.toHaveBeenCalled()
  expect(screen.getByText('Integration conflict: file.ts')).toBeInTheDocument()
  await userEvent.click(screen.getAllByRole('button', { name: 'Worker' })[0]!)
  expect(open).toHaveBeenCalledWith('child')
})
