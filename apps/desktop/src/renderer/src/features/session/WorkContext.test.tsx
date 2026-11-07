import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkContext } from './WorkContext'

const rpcMocks = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('../../lib/rpc', () => ({ rpc: rpcMocks }))
afterEach(() => {
  cleanup()
  rpcMocks.invoke.mockReset()
})

describe('WorkContext', () => {
  it('discards a late preview when the selected files changed during preparation', async () => {
    let resolve: (value: unknown) => void = () => {}
    const response = new Promise((yes) => {
      resolve = yes
    })
    const onPrepared = vi.fn()
    rpcMocks.invoke.mockImplementation((method) =>
      method === 'session.load' ? Promise.resolve({ messages: [] }) : response,
    )
    render(<WorkContext sessionId="lead" tasks={[]} onPrepared={onPrepared} />)
    await userEvent.click(screen.getByText('Context package · Optional'))
    await userEvent.type(
      screen.getByLabelText('Workspace files, one path per line'),
      'src/search.ts',
    )
    await userEvent.click(screen.getByRole('button', { name: 'Build and preview context' }))
    await userEvent.type(
      screen.getByLabelText('Workspace files, one path per line'),
      '\nsrc/order.ts',
    )
    await act(async () => {
      resolve({ contextId: 'old-preview', chars: 10, maxChars: 24000, items: [] })
      await response
    })
    expect(onPrepared).toHaveBeenLastCalledWith(null)
    expect(screen.queryByText('10 / 24,000 characters')).toBeNull()
    expect(screen.getByRole('button', { name: 'Build and preview context' })).toBeEnabled()
  })
  it('builds only selected sources with the limit and invalidates a changed preview', async () => {
    const onPrepared = vi.fn()
    rpcMocks.invoke.mockImplementation(async (method) =>
      method === 'session.load'
        ? {
            messages: [
              {
                id: 'm-1',
                role: 'user',
                parts: [{ type: 'text', text: 'Implement search with pagination' }],
              },
            ],
          }
        : {
            contextId: 'context-1',
            sourceSessionId: 'lead',
            purpose: 'assignment',
            createdAt: 1,
            chars: 12,
            maxChars: 100,
            items: [{ kind: 'message', sourceId: 'm-1', content: 'Implement…', truncated: true }],
          },
    )
    render(<WorkContext sessionId="lead" tasks={[]} onPrepared={onPrepared} />)
    await userEvent.click(screen.getByText('Context package · Optional'))
    await userEvent.click(
      await screen.findByRole('checkbox', { name: 'You: Implement search with pagination' }),
    )
    await userEvent.clear(screen.getByLabelText('Character limit'))
    await userEvent.type(screen.getByLabelText('Character limit'), '100')
    await userEvent.click(screen.getByRole('button', { name: 'Build and preview context' }))
    await waitFor(() =>
      expect(rpcMocks.invoke).toHaveBeenCalledWith(
        'orchestration.context',
        expect.objectContaining({ messageIds: ['m-1'], files: [], resultIds: [], maxChars: 100 }),
      ),
    )
    expect(screen.getByText(/Some selected content was truncated/)).toBeInTheDocument()
    expect(onPrepared).toHaveBeenLastCalledWith(expect.objectContaining({ contextId: 'context-1' }))
    await userEvent.type(
      screen.getByLabelText('Workspace files, one path per line'),
      'src/search.ts',
    )
    expect(onPrepared).toHaveBeenLastCalledWith(null)
    expect(screen.queryByText(/Some selected content was truncated/)).toBeNull()
  })
})
