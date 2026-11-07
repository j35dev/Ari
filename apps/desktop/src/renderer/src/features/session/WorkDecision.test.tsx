import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OrchestrationRequest } from '@ari/contracts/orchestration'
import { WorkDecision } from './WorkDecision'

const rpcMocks = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('../../lib/rpc', () => ({ rpc: rpcMocks }))
afterEach(() => {
  cleanup()
  rpcMocks.invoke.mockReset()
})
const question: OrchestrationRequest = {
  requestId: 'input-1',
  childSessionId: 'worker-1',
  turnId: 'turn-1',
  title: 'Search API',
  kind: 'question',
  owner: 'human',
  prompt: 'Which search order?',
  toolName: null,
  summaryJson: null,
  choicesJson: null,
  options: [],
  actionable: true,
  unavailableReason: null,
}

describe('WorkDecision', () => {
  it('retries a failed question response with the same request and receipt', async () => {
    rpcMocks.invoke
      .mockRejectedValueOnce(new Error('Connection lost'))
      .mockResolvedValueOnce({ answered: true })
    render(<WorkDecision sessionId="lead" request={question} onChanged={vi.fn()} />)
    await userEvent.type(screen.getByRole('textbox'), 'Newest first')
    await userEvent.click(screen.getByRole('button', { name: 'Submit' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Connection lost')
    await userEvent.click(screen.getByRole('button', { name: 'Retry answer' }))
    await waitFor(() => expect(rpcMocks.invoke).toHaveBeenCalledTimes(2))
    expect(rpcMocks.invoke.mock.calls[1]?.[1]).toEqual(rpcMocks.invoke.mock.calls[0]?.[1])
    expect(await screen.findByRole('status')).toHaveTextContent('Answer sent')
  })
  it('dismisses a live question with an explicit empty answer', async () => {
    rpcMocks.invoke.mockResolvedValue({ answered: true })
    render(<WorkDecision sessionId="lead" request={question} onChanged={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: 'Skip' }))
    expect(rpcMocks.invoke).toHaveBeenCalledWith(
      'orchestration.answer',
      expect.objectContaining({
        requestId: 'input-1',
        childSessionId: 'worker-1',
        kind: 'question',
        value: '',
      }),
    )
  })
})
