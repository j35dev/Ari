import { describe, expect, it } from 'vitest'
import type { ProviderAllowance } from '@ari/contracts/rpc'
import { formatResumeTime, resumeTime } from './resume-time'

const allowance = (
  windows: ProviderAllowance['windows'],
  status: ProviderAllowance['status'] = 'available',
): ProviderAllowance => ({ kind: 'claude', status, windows, updatedAt: 1, checkedAt: 1, detail: '' })

describe('resumeTime', () => {
  it('waits for the last exhausted window to reset', () => {
    expect(
      resumeTime(
        allowance([
          { label: '5h', usedPercent: 100, resetsAt: 5_000 },
          { label: 'week', usedPercent: 99, resetsAt: 9_000 },
          { label: 'opus', usedPercent: 40, resetsAt: 20_000 },
        ]),
        1_000,
      ),
    ).toBe(9_000)
  })

  it('has no answer without an exhausted window that says when it resets', () => {
    expect(resumeTime(allowance([{ label: '5h', usedPercent: 60, resetsAt: 5_000 }]), 1_000)).toBeNull()
    expect(resumeTime(allowance([{ label: '5h', usedPercent: 100, resetsAt: null }]), 1_000)).toBeNull()
    expect(resumeTime(allowance([{ label: '5h', usedPercent: 100, resetsAt: 500 }]), 1_000)).toBeNull()
    expect(
      resumeTime(allowance([{ label: '5h', usedPercent: 100, resetsAt: 5_000 }], 'error'), 1_000),
    ).toBeNull()
  })
})

it('names the day only when the reset is not today', () => {
  const now = new Date(2026, 9, 10, 9, 0).getTime()
  const today = formatResumeTime(new Date(2026, 9, 10, 15, 42).getTime(), now)
  const tomorrow = formatResumeTime(new Date(2026, 9, 11, 15, 42).getTime(), now)
  expect(today).toMatch(/3:42/)
  expect(tomorrow).toContain(today)
  expect(tomorrow.length).toBeGreaterThan(today.length)
})
