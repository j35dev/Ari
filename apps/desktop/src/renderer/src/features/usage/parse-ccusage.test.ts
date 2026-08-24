import { describe, expect, it } from 'vitest'
import { formatRange, formatTokens, formatUsd, modelShares, parseCcusageJson } from './parse-ccusage'

const SAMPLE = JSON.stringify({
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
      modelBreakdowns: [{ modelName: 'gpt-5.6-sol', inputTokens: 1000, outputTokens: 200, totalCost: 1.5 }],
    },
    {
      date: '2026-08-25',
      inputTokens: 9000,
      outputTokens: 800,
      cacheCreationTokens: 0,
      cacheReadTokens: 100,
      totalTokens: 9900,
      totalCost: 8.5,
      modelsUsed: ['gpt-5.6-sol', 'claude-opus-5'],
      modelBreakdowns: [
        { modelName: 'gpt-5.6-sol', inputTokens: 8000, outputTokens: 100, totalCost: 7 },
        { modelName: 'claude-opus-5', inputTokens: 1000, outputTokens: 700, totalCost: 1.5 },
      ],
    },
  ],
  totals: {
    inputTokens: 10_000,
    outputTokens: 1000,
    cacheCreationTokens: 50,
    cacheReadTokens: 500,
    totalCost: 10,
    totalTokens: 11_550,
  },
})

describe('parseCcusageJson', () => {
  it('reads daily rows and totals from a clean payload', () => {
    const report = parseCcusageJson(SAMPLE)
    expect(report?.daily).toHaveLength(2)
    expect(report?.totals.totalCost).toBe(10)
    expect(report?.daily[1]?.modelBreakdowns).toHaveLength(2)
  })

  it('strips npx banner text around the JSON object', () => {
    const report = parseCcusageJson(`npm warn something\n${SAMPLE}\n`)
    expect(report?.totals.totalCost).toBe(10)
  })

  it('returns null for empty or non-json output', () => {
    expect(parseCcusageJson('')).toBeNull()
    expect(parseCcusageJson('not json')).toBeNull()
  })
})

describe('modelShares', () => {
  it('ranks models by cost with a share of the total', () => {
    const report = parseCcusageJson(SAMPLE)
    if (report === null) throw new Error('expected parse')
    const shares = modelShares(report)
    expect(shares[0]?.modelName).toBe('gpt-5.6-sol')
    expect(shares[0]?.cost).toBe(8.5)
    expect(shares[0]?.share).toBeCloseTo(0.85, 2)
    expect(shares[1]?.modelName).toBe('claude-opus-5')
  })
})

describe('formatters', () => {
  it('formats usd, tokens, and date ranges', () => {
    expect(formatUsd(390.76)).toBe('$391')
    expect(formatUsd(1.5)).toBe('$1.50')
    expect(formatTokens(153_000_000)).toBe('153.0M')
    const report = parseCcusageJson(SAMPLE)
    expect(formatRange(report?.daily ?? [])).toBe('2026-08-11 to 2026-08-25')
  })
})
