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

  it('renders nothing when no plan file exists', async () => {
    rpcMocks.invoke.mockResolvedValue({ items: null })
    const { container } = render(<PlanPanel path="C:\\repo" />)
    await waitFor(() => expect(rpcMocks.invoke).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
  })

  it('renders items with status icons and a progress count', async () => {
    rpcMocks.invoke.mockResolvedValue({
      items: [
        { text: 'parse input', status: 'done' },
        { text: 'refactor loop', status: 'in_progress' },
        { text: 'write tests', status: 'pending' },
      ],
    })
    render(<PlanPanel path="C:\\repo" />)

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
    render(<PlanPanel path="C:\\repo" />)

    await screen.findByText('only step')
    await user.click(screen.getByRole('button', { name: /plan/i }))
    expect(screen.queryByText('only step')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /plan/i }))
    expect(screen.getByText('only step')).toBeInTheDocument()
  })

  it('survives invoke failures silently', async () => {
    rpcMocks.invoke.mockRejectedValue(new Error('ipc gone'))
    const { container } = render(<PlanPanel path="C:\\repo" />)
    await waitFor(() => expect(rpcMocks.invoke).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
  })
})
