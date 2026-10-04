// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  parseAllowance,
  parseClaudeResetCredits,
  parseCodexResetCredits,
  parsePiAnthropicUsage,
  parsePiCodexUsage,
} from './allowance-windows'

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
  it('reads pi Anthropic OAuth windows without per-model detail', () => {
    expect(
      parsePiAnthropicUsage({
        five_hour: { utilization: 12, resets_at: '2026-09-10T12:00:00Z' },
        seven_day: { utilization: 50, resets_at: 1757500000 },
      }),
    ).toEqual([
      {
        label: 'Anthropic 5h',
        usedPercent: 12,
        resetsAt: Date.parse('2026-09-10T12:00:00Z'),
      },
      { label: 'Anthropic 7d', usedPercent: 50, resetsAt: 1757500000000 },
    ])
    expect(parsePiAnthropicUsage({})).toEqual([])
    expect(parsePiAnthropicUsage(null)).toEqual([])
    expect(() => parsePiAnthropicUsage({ five_hour: { utilization: 101 } })).toThrow()
  })
  it('reads pi Codex wham windows without inventing missing data', () => {
    expect(
      parsePiCodexUsage({
        rate_limit: {
          primary_window: {
            limit_window_seconds: 18000,
            percent_left: 80,
            reset_at: '2026-09-10T12:00:00Z',
          },
          secondary_window: {
            limit_window_seconds: 604800,
            used_percent: 25,
            reset_at: null,
          },
        },
      }),
    ).toEqual([
      {
        label: 'Codex 5h',
        usedPercent: 20,
        resetsAt: Date.parse('2026-09-10T12:00:00Z'),
      },
      { label: 'Codex 7d', usedPercent: 25, resetsAt: null },
    ])
    expect(parsePiCodexUsage({})).toEqual([])
    expect(parsePiCodexUsage({ rate_limit: { primary_window: {} } })).toEqual([])
    expect(() =>
      parsePiCodexUsage({ rate_limit: { primary_window: { used_percent: 120 } } }),
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
  it('reads the current plain-text Claude /usage format alongside the legacy one', () => {
    expect(
      parseAllowance(
        'claude',
        'You are currently using your subscription to power your Claude Code usage\n\nCurrent session: 32% used · resets Sep 14, 7:50pm (Asia/Singapore)\nCurrent week (all models): 9% used · resets Sep 20, 3pm (Asia/Singapore)\nCurrent week (Fable): 0% used · resets Sep 20, 3pm (Asia/Singapore)',
      ),
    ).toEqual([
      {
        label: '5h',
        usedPercent: 32,
        resetsAt: null,
        resetText: 'Sep 14, 7:50pm (Asia/Singapore)',
      },
      {
        label: 'Weekly',
        usedPercent: 9,
        resetsAt: null,
        resetText: 'Sep 20, 3pm (Asia/Singapore)',
      },
      {
        label: 'Weekly · Fable',
        usedPercent: 0,
        resetsAt: null,
        resetText: 'Sep 20, 3pm (Asia/Singapore)',
      },
    ])
    expect(parseAllowance('claude', 'Current session: 101% used')).toEqual([])
  })
  it('reads Codex banked resets without dropping the quota windows', () => {
    const weekly = { usedPercent: 4, windowDurationMins: 10080, resetsAt: 1_800_000_000 }
    const snapshot = {
      rateLimits: { primary: null, secondary: weekly },
      rateLimitResetCredits: {
        availableCount: 2,
        credits: [
          { status: 'available', expiresAt: 1_800_000_000 },
          { status: 'consumed', expiresAt: 1 },
        ],
      },
    }
    expect(parseAllowance('codex', snapshot)[0]).toMatchObject({ label: 'Weekly', usedPercent: 4 })
    expect(parseCodexResetCredits(snapshot)).toEqual({
      availableCount: 2,
      nextExpiresAt: 1_800_000_000_000,
    })
    expect(
      parseCodexResetCredits({ rateLimits: { rateLimitResetCredits: { availableCount: 0 } } }),
    ).toEqual({
      availableCount: 0,
      nextExpiresAt: null,
    })
    expect(parseCodexResetCredits({ rateLimitResetCredits: { availableCount: -1 } })).toBeNull()
    expect(parseCodexResetCredits({})).toBeNull()
  })
  it('counts only usable Claude reset grants', () => {
    const now = Date.parse('2026-09-01T00:00:00Z')
    expect(
      parseClaudeResetCredits(
        {
          eligible: true,
          next_grant_id: 'grant_a',
          grants: [
            { id: 'grant_a', resets_left: 2, usable_now: true, ends_at: '2026-10-01T00:00:00Z' },
            {
              id: 'grant_b',
              resets_left: 1,
              usable_now: true,
              paused: true,
              ends_at: '2026-09-02T00:00:00Z',
            },
            { id: 'old', resets_left: 4, usable_now: true, ends_at: '2026-08-01T00:00:00Z' },
          ],
        },
        now,
      ),
    ).toEqual({
      availableCount: 2,
      nextExpiresAt: Date.parse('2026-10-01T00:00:00Z'),
      nextCreditId: 'grant_a',
    })
    expect(parseClaudeResetCredits({ eligible: false, grants: [] }, now)).toBeNull()
    expect(
      parseClaudeResetCredits({ eligible: true, next_grant_id: 'missing', grants: [] }, now),
    ).toEqual({ availableCount: 0, nextExpiresAt: null })
    expect(
      parseClaudeResetCredits(
        {
          eligible: true,
          next_grant_id: 'bad',
          grants: [
            { id: 'bad', resets_left: 1, usable_now: true, ends_at: '2027-02-30T00:00:00Z' },
          ],
        },
        now,
      ),
    ).toEqual({ availableCount: 0, nextExpiresAt: null })
  })
})
