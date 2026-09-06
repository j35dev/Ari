// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { parseAllowance } from './allowance-windows'

describe('account allowance windows', () => {
  it('reads Grok weekly credits using the same extension as /usage', () => {
    expect(
      parseAllowance('grok', {
        config: {
          creditUsagePercent: 23,
          currentPeriod: {
            type: 'USAGE_PERIOD_TYPE_WEEKLY',
            end: '2026-09-11T20:50:42Z',
          },
        },
      }),
    ).toEqual([{ label: 'Weekly', usedPercent: 23, resetsAt: Date.parse('2026-09-11T20:50:42Z') }])
    expect(parseAllowance('grok', { config: null })).toEqual([])
  })
  it('preserves monthly periods and never invents a zero for missing data', () => {
    expect(
      parseAllowance('grok', { config: { monthlyLimit: { val: 200 }, used: { val: 40 } } })[0],
    ).toMatchObject({ label: 'Monthly', usedPercent: 20 })
    expect(parseAllowance('grok', { config: {} })).toEqual([])
    expect(() => parseAllowance('grok', { config: { creditUsagePercent: -1 } })).toThrow()
    expect(() => parseAllowance('grok', { config: { creditUsagePercent: 101 } })).toThrow()
  })
  it('reads Codex five-hour and weekly-only plans without guessing missing windows', () => {
    const weekly = { usedPercent: 0, windowDurationMins: 10080, resetsAt: 1800000000 }
    expect(parseAllowance('codex', { rateLimits: { primary: null, secondary: weekly } })).toEqual([
      { label: 'Weekly', usedPercent: 0, resetsAt: 1800000000000 },
    ])
    expect(
      parseAllowance('codex', {
        rateLimits: { primary: { ...weekly, windowDurationMins: 300 }, secondary: null },
      })[0]?.label,
    ).toBe('5h')
    expect(() =>
      parseAllowance('codex', {
        rateLimits: { primary: { ...weekly, usedPercent: NaN }, secondary: null },
      }),
    ).toThrow()
  })
  it('accepts Claude quota lines but excludes context and cost totals', () => {
    expect(
      parseAllowance(
        'claude',
        '**5-hour limit** — **12%** · Resets Sep 6, 1:30 PM\n**Weekly · all models** — **50%**',
      ),
    ).toEqual([
      { label: '5h', usedPercent: 12, resetsAt: null, resetText: 'Sep 6, 1:30 PM' },
      { label: 'Weekly', usedPercent: 50, resetsAt: null },
    ])
    expect(
      parseAllowance('claude', 'Usage: 0 input, 0 output\nContext: 12%\nTotal cost: $0'),
    ).toEqual([])
  })
})
