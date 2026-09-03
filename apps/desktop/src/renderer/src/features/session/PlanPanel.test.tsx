import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { PlanPanel } from './PlanPanel'

const rpcMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  subscribe: vi.fn(() => () => undefined),
}))

vi.mock('../../lib/rpc', () => ({ rpc: rpcMocks }))

describe('PlanPanel', () => {
  beforeEach(() => {
    rpcMocks.invoke.mockReset()
  })

  // Paths stay forward-slashed: esbuild (the vitest JSX transform here)
  // double-escapes backslashes inside JSX string attributes, so a
  // `C:\repo` prop literal would arrive as `C:\\repo` at runtime.

  it('renders nothing when no plan file exists', async () => {
    rpcMocks.invoke.mockResolvedValue({ items: null })
    const { container } = render(<PlanPanel path="C:/repo" sessionId="ses-1" />)
    await waitFor(() => expect(rpcMocks.invoke).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
  })

  it('requests the plan scoped to the session', async () => {
    rpcMocks.invoke.mockResolvedValue({ items: null })
    render(<PlanPanel path="C:/repo" sessionId="ses-1" />)
    await waitFor(() =>
      expect(rpcMocks.invoke).toHaveBeenCalledWith('plan.get', {
        path: 'C:/repo',
        sessionId: 'ses-1',
      }),
    )
  })

  it('refetches when the session changes so siblings never share a plan', async () => {
    rpcMocks.invoke.mockResolvedValue({ items: null })
    const { rerender } = render(<PlanPanel path="C:/repo" sessionId="ses-1" />)
    await waitFor(() =>
      expect(rpcMocks.invoke).toHaveBeenCalledWith('plan.get', {
        path: 'C:/repo',
        sessionId: 'ses-1',
      }),
    )
    rerender(<PlanPanel path="C:/repo" sessionId="ses-2" />)
    await waitFor(() =>
      expect(rpcMocks.invoke).toHaveBeenCalledWith('plan.get', {
        path: 'C:/repo',
        sessionId: 'ses-2',
      }),
    )
    expect(rpcMocks.invoke).toHaveBeenCalledTimes(2)
  })

  it('renders nothing without fetching when the session is unknown', async () => {
    const { container } = render(<PlanPanel path="C:/repo" sessionId={null} />)
    await waitFor(() => expect(container).toBeEmptyDOMElement())
    expect(rpcMocks.invoke).not.toHaveBeenCalled()
  })

  it('renders items with status icons and a progress count', async () => {
    rpcMocks.invoke.mockResolvedValue({
      items: [
        { text: 'parse input', status: 'done' },
        { text: 'refactor loop', status: 'in_progress' },
        { text: 'write tests', status: 'pending' },
      ],
    })
    render(<PlanPanel path="C:/repo" sessionId="ses-1" />)

    expect(await screen.findByText('parse input')).toBeInTheDocument()
    expect(screen.getByText('refactor loop')).toBeInTheDocument()
    expect(screen.getByText('write tests')).toBeInTheDocument()
    expect(screen.getByText('1/3')).toBeInTheDocument()
  })

  it('collapses to the summary row on toggle', async () => {
    rpcMocks.invoke.mockResolvedValue({
      items: [{ text: 'only step', status: 'pending' }],
    })
    const user = userEvent.setup()
    render(<PlanPanel path="C:/repo" sessionId="ses-1" />)

    await screen.findByText('only step')
    await user.click(screen.getByRole('button', { name: /plan/i }))
    expect(screen.queryByText('only step')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /plan/i }))
    expect(screen.getByText('only step')).toBeInTheDocument()
  })

  it('survives invoke failures silently', async () => {
    rpcMocks.invoke.mockRejectedValue(new Error('ipc gone'))
    const { container } = render(<PlanPanel path="C:/repo" sessionId="ses-1" />)
    await waitFor(() => expect(rpcMocks.invoke).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
  })
})
