import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ToastProvider } from '@ari/ui/toast'
import { BranchesDialog } from './BranchesDialog'

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), subscribe: vi.fn(() => () => undefined) }))
vi.mock('../../lib/rpc', () => ({ rpc: mocks }))
const snapshot = 'a'.repeat(64)
const stash = 'c'.repeat(40)
beforeEach(() => {
  mocks.invoke.mockReset()
  mocks.invoke.mockImplementation(async (method: string) =>
    method === 'scm.status'
      ? {
          ok: true,
          value: {
            status: {
              branch: 'main',
              files: [{ path: 'a.ts', staged: false, unstaged: true }],
              remotes: [{ name: 'origin', url: 'https://example.com/repo' }],
            },
            refs: ['feature', 'main', 'origin/main'],
            commits: [],
            stashes: [{ oid: stash, subject: 'WIP on main', author: 'me', at: '' }],
            turns: [],
          },
        }
      : method === 'scm.review'
        ? { ok: true, value: { id: snapshot, files: [] } }
        : { ok: true, value: { message: 'Done.' } },
  )
})

const open = () =>
  render(
    <ToastProvider>
      <BranchesDialog scope={{ projectId: 'p' }} onClose={vi.fn()} refresh={vi.fn()} />
    </ToastProvider>,
  )

describe('Branches and stashes', () => {
  it('creates a branch against a fresh working-tree snapshot', async () => {
    const user = userEvent.setup()
    open()
    const name = await screen.findByRole('textbox', { name: 'New branch name' })
    await waitFor(() => expect(name).toBeEnabled())
    await user.type(name, 'feature/next')
    await user.click(screen.getByRole('button', { name: 'Create' }))
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith('scm.mutate', {
        projectId: 'p',
        action: {
          kind: 'branch',
          snapshotId: snapshot,
          name: 'feature/next',
          create: true,
          confirmed: true,
        },
      }),
    )
  })

  it('asks before applying a stash', async () => {
    const user = userEvent.setup()
    open()
    const apply = await screen.findByRole('button', { name: 'Apply · WIP on main' })
    await waitFor(() => expect(apply).toBeEnabled())
    await user.click(apply)
    expect(screen.getByText(/Restore these saved changes/)).toBeInTheDocument()
    expect(mocks.invoke).not.toHaveBeenCalledWith('scm.mutate', expect.anything())
    await user.click(screen.getByRole('button', { name: 'Continue' }))
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith('scm.mutate', {
        projectId: 'p',
        action: { kind: 'apply-stash', snapshotId: snapshot, oid: stash, confirmed: true },
      }),
    )
  })
})
