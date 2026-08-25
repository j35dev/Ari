import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { CcusageDashboard } from './CcusageDashboard'
import type { CcusageReport } from './parse-ccusage'

const REPORT: CcusageReport = {
  daily: [
    {
      date: '2026-08-11',
      inputTokens: 1000,
      outputTokens: 200,
      cacheCreationTokens: 50,
      cacheReadTokens: 400,
      totalTokens: 1650,
      totalCost: 1.5,
      modelsUsed: ['gpt-5.6-sol'],
      modelBreakdowns: [
        { modelName: 'gpt-5.6-sol', inputTokens: 1000, outputTokens: 200, totalCost: 1.5 },
      ],
    },
    {
      date: '2026-08-25',
      inputTokens: 9000,
      outputTokens: 800,
      cacheCreationTokens: 0,
      cacheReadTokens: 100,
      totalTokens: 9900,
      totalCost: 389.26,
      modelsUsed: ['gpt-5.6-sol', 'claude-opus-5'],
      modelBreakdowns: [
        { modelName: 'gpt-5.6-sol', inputTokens: 8000, outputTokens: 100, totalCost: 380 },
        { modelName: 'claude-opus-5', inputTokens: 1000, outputTokens: 700, totalCost: 9.26 },
      ],
    },
  ],
  totals: {
    inputTokens: 10_000,
    outputTokens: 1_000,
    cacheCreationTokens: 50,
    cacheReadTokens: 500,
    totalCost: 390.76,
    totalTokens: 11_550,
  },
}

describe('CcusageDashboard', () => {
  it('renders the window cost, range, and totals from the filtered days', () => {
    render(<CcusageDashboard report={REPORT} granularity='daily' since={null} />)

    // Window totals come from the day rows, not the unfiltered report totals.
    expect(screen.getByText('$391')).toBeInTheDocument()
    expect(screen.getByText('2026-08-11 to 2026-08-25')).toBeInTheDocument()
    expect(screen.getByText('2 days · API estimate')).toBeInTheDocument()
    expect(screen.getByText('Processed tokens')).toBeInTheDocument()
    // 10,000 + 1,000 + 50 + 500 = 11,550 → 11.6K
    expect(screen.getByText('11.6K')).toBeInTheDocument()
  })

  it('renders one bar per day and a cost-ranked model breakdown', () => {
    render(<CcusageDashboard report={REPORT} granularity='daily' since={null} />)

    expect(screen.getByRole('img', { name: 'daily cost chart' })).toBeInTheDocument()
    // Two daily buckets, each carrying its date as a hover title.
    expect(screen.getByTitle('2026-08-11 · $1.50')).toBeInTheDocument()
    expect(screen.getByTitle('2026-08-25 · $389')).toBeInTheDocument()

    const rows = screen.getAllByRole('row').slice(1)
    expect(rows[0]).toHaveTextContent('gpt-5.6-sol')
    expect(rows[0]).toHaveTextContent('97.6%')
    expect(rows[1]).toHaveTextContent('claude-opus-5')
  })

  it('buckets by month when granularity is monthly', () => {
    render(<CcusageDashboard report={REPORT} granularity='monthly' since={null} />)

    expect(screen.getByRole('img', { name: 'monthly cost chart' })).toBeInTheDocument()
    // Both days collapse into 2026-08, so the axis labels are month keys.
    expect(screen.getAllByText('2026-08')).toHaveLength(2)
    expect(screen.queryByTitle('2026-08-25 · $389')).not.toBeInTheDocument()
  })

  it('drops days before the window start', () => {
    render(<CcusageDashboard report={REPORT} granularity='daily' since='2026-08-20' />)

    // Range line and chart axis both collapse onto the one surviving day.
    expect(screen.getAllByText('2026-08-25').length).toBeGreaterThan(0)
    expect(screen.getByText('1 day · API estimate')).toBeInTheDocument()

    // Only the 08-25 breakdown rows survive the filter.
    const rows = screen.getAllByRole('row').slice(1)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toHaveTextContent('gpt-5.6-sol')
    expect(rows[1]).toHaveTextContent('claude-opus-5')
  })

  it('shows an empty window instead of a chart when nothing matches', () => {
    render(<CcusageDashboard report={REPORT} granularity='daily' since='2026-09-01' />)
    expect(screen.getByText('No usage in this window')).toBeInTheDocument()
    expect(screen.getByText('No recorded usage')).toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })
})
