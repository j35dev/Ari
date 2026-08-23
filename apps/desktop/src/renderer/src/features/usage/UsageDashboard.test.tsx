import { render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { UsageSummary } from '@ari/contracts/rpc'
import { UsageDashboard } from './UsageDashboard'

const { invokeFn } = vi.hoisted(() => ({ invokeFn: vi.fn() }))

vi.mock('../../lib/rpc', () => ({
  rpc: {
    invoke: invokeFn,
    subscribe: vi.fn(() => () => undefined),
  },
}))

const EMPTY_SUMMARY: UsageSummary = {
  rows: [],
  totals: { inputTokens: 0, outputTokens: 0, costUsd: null },
}

const DATA_SUMMARY: UsageSummary = {
  rows: [
    {
      sessionId: 'sess_2',
      title: 'Second session',
      driverKind: 'codex',
      updatedAt: 3_000,
      inputTokens: 12_000,
      outputTokens: 800,
      costUsd: 0.03,
    },
    {
      sessionId: 'sess_1',
      title: 'First session',
      driverKind: 'claude',
      updatedAt: 1_000,
      inputTokens: 3_000,
      outputTokens: 200,
      costUsd: null,
    },
  ],
  totals: { inputTokens: 15_000, outputTokens: 1_000, costUsd: 0.03 },
}

describe('UsageDashboard', () => {
  beforeEach(() => {
    invokeFn.mockReset()
  })

  it('shows the empty state when no session recorded usage', async () => {
    invokeFn.mockResolvedValueOnce(EMPTY_SUMMARY)
    render(<UsageDashboard />)

    expect(await screen.findByText(/No usage recorded yet/)).toBeInTheDocument()
    expect(invokeFn).toHaveBeenCalledWith('usage.summary')
    expect(screen.queryByText('Cost')).not.toBeInTheDocument()
  })

  it('renders totals, per-session rows with driver chips, and share bars', async () => {
    invokeFn.mockResolvedValueOnce(DATA_SUMMARY)
    render(<UsageDashboard />)

    expect(await screen.findByText('Second session')).toBeInTheDocument()
    expect(screen.getByText('Input tokens')).toBeInTheDocument()
    expect(screen.getByText('Output tokens')).toBeInTheDocument()
    expect(screen.getByText('Cost')).toBeInTheDocument()

    const busiest = screen.getByText('Second session').closest('li')
    if (busiest === null) throw new Error('missing row for Second session')
    expect(within(busiest).getByText('codex')).toBeInTheDocument()
    expect(within(busiest).getByText('↑ 12.0K')).toBeInTheDocument()
    expect(within(busiest).getByText('↓ 800')).toBeInTheDocument()

    const quieter = screen.getByText('First session').closest('li')
    if (quieter === null) throw new Error('missing row for First session')
    // Sub-10k counts stay exact instead of switching to K formatting.
    expect(within(quieter).getByText('↑ 3000')).toBeInTheDocument()
    // Share bar scales against the busiest session (3,200 of 12,800 tokens).
    expect(quieter.querySelector('.bg-accent')).toHaveStyle({ width: '25%' })
  })

  it('hides the cost column until a row carries a price', async () => {
    invokeFn.mockResolvedValueOnce({
      rows: [
        {
          sessionId: 'sess_1',
          title: 'Only session',
          driverKind: 'claude',
          updatedAt: 1_000,
          inputTokens: 500,
          outputTokens: 100,
          costUsd: null,
        },
      ],
      totals: { inputTokens: 500, outputTokens: 100, costUsd: null },
    })
    render(<UsageDashboard />)

    expect(await screen.findByText('Only session')).toBeInTheDocument()
    expect(screen.queryByText('Cost', { selector: 'p' })).not.toBeInTheDocument()
  })

  it('surfaces a load failure as an alert instead of a blank pane', async () => {
    invokeFn.mockRejectedValueOnce(new Error('rpc down'))
    render(<UsageDashboard />)

    expect(await screen.findByRole('alert')).toHaveTextContent('Usage summary failed to load.')
  })
})
