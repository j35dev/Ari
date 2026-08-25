import { describe, expect, it } from 'vitest'
import {
  bucketDays,
  daysSince,
  formatRange,
  formatTokens,
  formatUsd,
  isoDate,
  modelShares,
  normalizeDate,
  parseCcusageJson,
  type CcusageDay,
} from './parse-ccusage'

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
    const shares = modelShares(report.daily)
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

describe('window helpers', () => {
  const day = (date: string, totalCost = 1): CcusageDay => ({
    date,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    totalTokens: 0,
    totalCost,
    modelsUsed: [],
    modelBreakdowns: [],
  })

  it('normalizes dashed and legacy compact dates, rejecting junk', () => {
    expect(normalizeDate('2026-08-11')).toBe('2026-08-11')
    expect(normalizeDate('20260811')).toBe('2026-08-11')
    expect(normalizeDate('nope')).toBeNull()
    expect(normalizeDate('2026-13-99')).toBeNull()
  })

  it('keeps days on or after the window start; null keeps all', () => {
    const days = [day('2026-08-10'), day('2026-08-11'), day('2026-08-25')]
    expect(daysSince(days, null)).toHaveLength(3)
    expect(daysSince(days, '2026-08-11').map((d) => d.date)).toEqual(['2026-08-11', '2026-08-25'])
  })

  it('buckets daily rows one-to-one with normalized labels', () => {
    const buckets = bucketDays([day('20260811')], 'daily')
    expect(buckets).toHaveLength(1)
    expect(buckets[0]?.label).toBe('2026-08-11')
  })

  it('buckets weeks from Monday and months by calendar key', () => {
    // 2026-08-11 is a Tuesday; its week starts Monday 2026-08-10.
    const days = [day('2026-08-10'), day('2026-08-11'), day('2026-08-17'), day('2026-09-01')]
    const weeks = bucketDays(days, 'weekly')
    expect(weeks.map((b) => b.key)).toEqual(['2026-08-10', '2026-08-17', '2026-08-31'])
    expect(weeks[0]?.days).toHaveLength(2)

    const months = bucketDays(days, 'monthly')
    expect(months.map((b) => b.key)).toEqual(['2026-08', '2026-09'])
    expect(months[0]?.days).toHaveLength(3)
  })

  it('computes local ISO dates', () => {
    expect(isoDate(new Date(2026, 7, 5))).toBe('2026-08-05')
  })
})
