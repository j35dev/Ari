import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { ToastProvider } from '@ari/ui/toast'
import { CheckpointList } from './CheckpointList'

const rpcMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  subscribe: vi.fn(() => () => undefined),
}))

vi.mock('../../lib/rpc', () => ({ rpc: rpcMocks }))

const invokeMock = rpcMocks.invoke as unknown as Mock<
  (method: string, params?: unknown) => Promise<unknown>
>

function renderList(): void {
  render(
    <ToastProvider>
      <CheckpointList projectId="proj_1" sessionId="sess_1" />
    </ToastProvider>,
  )
}

const CHECKPOINTS = [
  { turnId: 't1', gitRef: 'r1' },
  { turnId: 't2', gitRef: 'r2' },
]

describe('CheckpointList', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    invokeMock.mockImplementation(async (method) => {
      if (method === 'session.load') return { checkpoints: structuredClone(CHECKPOINTS) }
      if (method === 'command.dispatch') return { accepted: true }
      throw new Error(`unexpected method: ${String(method)}`)
    })
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('renders one mono row per checkpoint returned by session.load', async () => {
    renderList()

    expect(await screen.findByText('t1')).toBeInTheDocument()
    expect(screen.getByText('t2')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Revert turn t1' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Revert turn t2' })).toBeInTheDocument()
    expect(invokeMock).toHaveBeenCalledWith('session.load', { sessionId: 'sess_1' })
  })

  it('confirm flow dispatches the right command payload and toasts success', async () => {
    const user = userEvent.setup()
    renderList()
    await screen.findByText('t1')

    await user.click(screen.getByRole('button', { name: 'Revert turn t1' }))
    expect(
      screen.getByText(/Are you sure\? Revert workspace to this checkpoint/),
    ).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Confirm revert t1' }))
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('command.dispatch', {
        command: { type: 'checkpoint.revert', sessionId: 'sess_1', turnId: 't1' },
      })
    })
    expect(await screen.findByText('Workspace reverted')).toBeInTheDocument()
    expect(await screen.findByRole('alert')).toHaveTextContent(/reverted to t1/)
  })

  it('cancel backs out without dispatching anything', async () => {
    const user = userEvent.setup()
    renderList()
    await screen.findByText('t1')

    await user.click(screen.getByRole('button', { name: 'Revert turn t1' }))
    await user.click(screen.getByRole('button', { name: 'Cancel revert t1' }))

    expect(screen.getByRole('button', { name: 'Revert turn t1' })).toBeInTheDocument()
    expect(invokeMock).toHaveBeenCalledTimes(1)
    expect(invokeMock).toHaveBeenCalledWith('session.load', { sessionId: 'sess_1' })
  })

  it('disables actions while a revert is in flight, re-enables after settle', async () => {
    let resolveDispatch!: (value: { accepted: boolean }) => void
    invokeMock.mockImplementation(async (method) => {
      if (method === 'session.load') return { checkpoints: structuredClone(CHECKPOINTS) }
      if (method === 'command.dispatch') {
        return new Promise((resolve) => {
          resolveDispatch = resolve
        })
      }
      throw new Error(`unexpected method: ${String(method)}`)
    })

    const user = userEvent.setup()
    renderList()
    await screen.findByText('t1')

    await user.click(screen.getByRole('button', { name: 'Revert turn t1' }))
    await user.click(screen.getByRole('button', { name: 'Confirm revert t1' }))

    expect(screen.getByRole('button', { name: 'Confirm revert t1' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Cancel revert t1' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Revert turn t2' })).toBeDisabled()

    act(() => resolveDispatch({ accepted: true }))

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Revert turn t1' })).toBeEnabled()
    })
    expect(screen.getByRole('button', { name: 'Revert turn t2' })).toBeEnabled()
  })
})
