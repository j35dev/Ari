// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { openCheckedOutWorktree } from './open-request-worktree'

describe('openCheckedOutWorktree', () => {
  it('refreshes projects and starts a session in the new worktree', async () => {
    const open = vi.fn(async () => ({ id: 'project', status: 'ok' }))
    const refreshProjects = vi.fn()
    const startSession = vi.fn()
    await openCheckedOutWorktree('D:\\worktrees\\demo\\github-4', {
      open,
      refreshProjects,
      startSession,
    })
    expect(open).toHaveBeenCalledWith('D:\\worktrees\\demo\\github-4')
    expect(refreshProjects).toHaveBeenCalledOnce()
    expect(startSession).toHaveBeenCalledWith('project')
  })

  it('does not start a session when the folder cannot be opened', async () => {
    const startSession = vi.fn()
    await openCheckedOutWorktree('D:\\missing', {
      open: async () => ({ id: 'project', status: 'missing' }),
      refreshProjects: vi.fn(),
      startSession,
    })
    expect(startSession).not.toHaveBeenCalled()
  })
})
