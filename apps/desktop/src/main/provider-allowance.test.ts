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
  it('keeps a reported reset bank when the next refresh fails', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({
        windows: [{ label: '5h', usedPercent: 10, resetsAt: null }],
        resetCredits: { availableCount: 2, nextExpiresAt: null },
      })
      .mockRejectedValueOnce(new Error('offline'))
    const reader = new ProviderAllowanceReader(fetch, () => 5)
    expect(await reader.read('codex', 'cli')).toMatchObject({
      status: 'available',
      resetCredits: { availableCount: 2 },
    })
    expect(await reader.read('codex', 'cli')).toMatchObject({
      status: 'error',
      resetCredits: { availableCount: 2 },
      windows: [{ usedPercent: 10 }],
    })
  })
  it('keeps the last reset bank when the provider does not answer', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({
        windows: [{ label: '5h', usedPercent: 10, resetsAt: null }],
        resetCredits: { availableCount: 1, nextExpiresAt: null },
      })
      .mockResolvedValueOnce({
        windows: [{ label: '5h', usedPercent: 40, resetsAt: null }],
        resetCredits: null,
        resetCreditsKnown: false,
      })
    const reader = new ProviderAllowanceReader(fetch, () => 5)
    await reader.read('claude', 'cli')
    expect(await reader.read('claude', 'cli')).toMatchObject({
      windows: [{ usedPercent: 40 }],
      resetCredits: { availableCount: 1 },
    })
  })
  it('does not bring a spent reset back when the bank cannot be re-read', async () => {
    const windows = [{ label: '5h', usedPercent: 10, resetsAt: null }]
    const two = { availableCount: 2, nextExpiresAt: 9, nextCreditId: 'grant_a' }
    let release: () => void = () => undefined
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({ windows, resetCredits: two })
      .mockImplementationOnce(async () => {
        await new Promise<void>((resolve) => (release = resolve))
        return { windows, resetCredits: two }
      })
      .mockResolvedValueOnce({ windows, resetCredits: null, resetCreditsKnown: false })
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ windows, resetCredits: { availableCount: 1, nextExpiresAt: 9 } })
    const reader = new ProviderAllowanceReader(fetch, () => 5)
    await reader.read('claude', 'cli')
    const stale = reader.read('claude', 'cli')
    const reread = reader.reread('claude', 'cli', true)
    release()
    expect((await stale).resetCredits).toEqual(two)
    expect((await reread).resetCredits).toEqual({ availableCount: 1, nextExpiresAt: null })
    expect((await reader.reread('claude', 'cli')).resetCredits).toEqual({
      availableCount: 1,
      nextExpiresAt: null,
    })
    expect((await reader.reread('claude', 'cli', true)).resetCredits).toEqual({
      availableCount: 1,
      nextExpiresAt: 9,
    })
  })
})
