import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { ToastProvider } from '@ari/ui/toast'
import { ChangesView } from './ChangesView'

const rpcMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  subscribe: vi.fn(() => () => undefined),
}))

vi.mock('../../lib/rpc', () => ({ rpc: rpcMocks }))

const invokeMock = rpcMocks.invoke as unknown as Mock<
  (method: string, params?: unknown) => Promise<unknown>
>

describe('ChangesView', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    invokeMock.mockImplementation(async (method) => {
      if (method === 'project.list')
        return [{ id: 'proj_1', name: 'Demo', path: 'C:\\repos\\demo' }]
      if (method === 'git.status') return { isRepo: true, branch: 'main', files: [] }
      if (method === 'git.diffWorktree') return { diffText: '' }
      if (method === 'session.load')
        return { checkpoints: [{ turnId: 't1', gitRef: 'refs/ari/s1/t1' }] }
      throw new Error(`unexpected method: ${String(method)}`)
    })
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('mounts the active session checkpoint list with revert actions', async () => {
    render(<ToastProvider><ChangesView sessionId="sess_1" projectId="proj_1" /></ToastProvider>)

    expect(await screen.findByRole('region', { name: 'Checkpoints' })).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: 'Revert turn t1' })).toBeInTheDocument()
    expect(invokeMock).toHaveBeenCalledWith('session.load', { sessionId: 'sess_1' })
  })

  it('renders without the checkpoint section when no session is active', async () => {
    render(<ToastProvider><ChangesView /></ToastProvider>)

    expect(await screen.findByText(/Worktree clean/)).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Checkpoints' })).not.toBeInTheDocument()
    expect(invokeMock).not.toHaveBeenCalledWith('session.load', expect.anything())
  })

  it('keeps asking for the first registered project worktree', async () => {
    render(<ToastProvider><ChangesView sessionId="sess_1" projectId="proj_1" /></ToastProvider>)

    await screen.findByRole('button', { name: 'Revert turn t1' })
    expect(invokeMock).toHaveBeenCalledWith('git.status', { path: 'C:\\repos\\demo' })
  })
})
