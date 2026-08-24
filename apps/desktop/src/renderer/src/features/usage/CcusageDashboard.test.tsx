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
  it('renders the hero cost, date range, and totals instead of raw log text', () => {
    render(<CcusageDashboard report={REPORT} />)

    expect(screen.getByText('$391')).toBeInTheDocument()
    expect(screen.getByText('2026-08-11 to 2026-08-25')).toBeInTheDocument()
    expect(screen.getByText('2 days · API estimate')).toBeInTheDocument()
    expect(screen.getByText('Processed tokens')).toBeInTheDocument()
    // 10,000 + 1,000 + 50 + 500 = 11,550 → 11.6K
    expect(screen.getByText('11.6K')).toBeInTheDocument()
  })

  it('renders a cost chart and a cost-ranked model breakdown', () => {
    render(<CcusageDashboard report={REPORT} />)

    expect(screen.getByRole('img', { name: 'Daily cost chart' })).toBeInTheDocument()
    const rows = screen.getAllByRole('row').slice(1)
    expect(rows[0]).toHaveTextContent('gpt-5.6-sol')
    expect(rows[0]).toHaveTextContent('97.6%')
    expect(rows[1]).toHaveTextContent('claude-opus-5')
  })

  it('omits the breakdown when no model data is present', () => {
    render(<CcusageDashboard report={{ daily: [], totals: REPORT.totals }} />)
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    expect(screen.getByText('All recorded days')).toBeInTheDocument()
  })
})
