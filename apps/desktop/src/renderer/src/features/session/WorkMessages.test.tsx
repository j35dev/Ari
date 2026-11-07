import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkMessages } from './WorkMessages'

const rpcMocks = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('../../lib/rpc', () => ({ rpc: rpcMocks }))
afterEach(() => {
  cleanup()
  rpcMocks.invoke.mockReset()
})
const message = {
  messageId: 'message-1',
  senderSessionId: 'lead',
  recipientSessionId: 'worker',
  senderTitle: 'Lead',
  recipientTitle: 'Search API',
  text: 'Use the existing search contract.',
  createdAt: 1,
  status: 'pending',
  turnId: null,
  consumedAt: null,
  textTruncated: false,
}

describe('WorkMessages', () => {
  it('shows inbox delivery state without acknowledging on behalf of the agent', async () => {
    rpcMocks.invoke.mockResolvedValue({ total: 1, messages: [message] })
    render(<WorkMessages sessionId="lead" taskId="task-1" observedAt={1} />)
    expect(await screen.findByText('Use the existing search contract.')).toBeInTheDocument()
    expect(screen.getByText(/In inbox/)).toBeInTheDocument()
    expect(rpcMocks.invoke).toHaveBeenCalledWith(
      'orchestration.inbox',
      expect.objectContaining({ sessionId: 'lead', taskId: 'task-1', includeConsumed: false }),
    )
    await userEvent.click(screen.getByRole('checkbox', { name: 'Include consumed messages' }))
    await waitFor(() =>
      expect(rpcMocks.invoke).toHaveBeenCalledWith(
        'orchestration.inbox',
        expect.objectContaining({ includeConsumed: true }),
      ),
    )
    expect(rpcMocks.invoke.mock.calls.every((call) => call[0] === 'orchestration.inbox')).toBe(true)
  })
  it('updates delivery from a scoped family refresh and labels uncertain outcomes', async () => {
    rpcMocks.invoke
      .mockResolvedValueOnce({ total: 1, messages: [message] })
      .mockResolvedValueOnce({
        total: 1,
        messages: [{ ...message, status: 'uncertain', textTruncated: true }],
      })
    const { rerender } = render(<WorkMessages sessionId="lead" observedAt={1} />)
    await screen.findByText(/In inbox/)
    rerender(<WorkMessages sessionId="lead" observedAt={2} />)
    expect(await screen.findByText(/Delivery uncertain/)).toBeInTheDocument()
    expect(screen.getByText(/Preview truncated/)).toBeInTheDocument()
  })
})
