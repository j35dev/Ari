// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { ProviderAllowanceReader } from './provider-allowance'

describe('account allowance reader', () => {
  it('coalesces simultaneous requests and actually refetches the next time', async () => {
    const fetch = vi.fn(async () => [{ label: '5h', usedPercent: 42, resetsAt: null }])
    const reader = new ProviderAllowanceReader(fetch, () => 100)
    const [a, b] = await Promise.all([reader.read('codex', 'cli'), reader.read('codex', 'cli')])
    expect(a).toEqual(b)
    expect(fetch).toHaveBeenCalledTimes(1)
    await reader.read('codex', 'cli')
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(a.updatedAt).toBe(100)
  })
  it('marks old samples stale on errors and recovers on the next refresh', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce([{ label: 'Weekly', usedPercent: 23, resetsAt: null }])
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce([])
    let now = 1
    const reader = new ProviderAllowanceReader(fetch, () => now)
    await reader.read('grok', 'cli')
    now = 2
    expect(await reader.read('grok', 'cli')).toMatchObject({
      status: 'error',
      updatedAt: 1,
      checkedAt: 2,
      windows: [{ usedPercent: 23 }],
    })
    expect(await reader.read('grok', 'cli')).toMatchObject({
      status: 'unavailable',
      windows: [],
      updatedAt: null,
    })
    expect(await reader.read('pi', null)).toMatchObject({ status: 'unavailable' })
  })
})
