// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchAllowance } from './provider-allowance'

const fakes = vi.hoisted(() => ({
  readFileSync: vi.fn<(path: string) => string>(),
  fetch: vi.fn<(url: string, init?: RequestInit) => Promise<unknown>>(),
}))
vi.mock('node:fs', () => ({ readFileSync: fakes.readFileSync }))

function authFile(entries: Record<string, unknown>): string {
  return JSON.stringify(entries)
}

function okJson(data: unknown): { ok: true; json: () => Promise<unknown> } {
  return { ok: true, json: async () => data }
}

function sentHeaders(callIndex: number): Record<string, string> {
  const headers = fakes.fetch.mock.calls[callIndex]?.[1]?.headers as
    | Record<string, string>
    | undefined
  return headers ?? {}
}

beforeEach(() => {
  fakes.readFileSync.mockReset()
  fakes.fetch.mockReset()
  vi.stubGlobal('fetch', fakes.fetch)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('pi allowance', () => {
  it('returns no windows when pi holds no Anthropic or Codex credentials', async () => {
    fakes.readFileSync.mockImplementation(() => {
      throw new Error('ENOENT')
    })
    expect(await fetchAllowance('pi', 'pi')).toEqual([])
    expect(fakes.fetch).not.toHaveBeenCalled()
  })

  it('skips direct Anthropic API keys, which carry no subscription usage', async () => {
    fakes.readFileSync.mockImplementation(() => authFile({ anthropic: 'sk-ant-api03-key' }))
    expect(await fetchAllowance('pi', 'pi')).toEqual([])
    expect(fakes.fetch).not.toHaveBeenCalled()
  })

  it('polls Anthropic OAuth usage through the stored token', async () => {
    fakes.readFileSync.mockImplementation(() => authFile({ anthropic: { access: 'oauth-token' } }))
    fakes.fetch.mockResolvedValueOnce(
      okJson({
        five_hour: { utilization: 12, resets_at: '2026-09-10T12:00:00Z' },
        seven_day: { utilization: 50, resets_at: '2026-09-17T12:00:00Z' },
      }),
    )
    expect(await fetchAllowance('pi', 'pi')).toMatchObject([
      { label: 'Anthropic 5h', usedPercent: 12 },
      { label: 'Anthropic 7d', usedPercent: 50 },
    ])
    expect(fakes.fetch).toHaveBeenCalledTimes(1)
    expect(fakes.fetch.mock.calls[0]?.[0]).toBe('https://api.anthropic.com/api/oauth/usage')
    expect(sentHeaders(0)['Authorization']).toBe('Bearer oauth-token')
  })

  it('polls Codex wham usage with the stored token and account id', async () => {
    fakes.readFileSync.mockImplementation((path: string) => {
      if (path.includes('.codex')) throw new Error('ENOENT')
      return authFile({ 'openai-codex': { access: 'codex-token', accountId: 'acct-1' } })
    })
    fakes.fetch.mockResolvedValueOnce(
      okJson({
        rate_limit: {
          primary_window: { limit_window_seconds: 18000, percent_left: 80 },
          secondary_window: { limit_window_seconds: 604800, used_percent: 25 },
        },
      }),
    )
    expect(await fetchAllowance('pi', 'pi')).toMatchObject([
      { label: 'Codex 5h', usedPercent: 20 },
      { label: 'Codex 7d', usedPercent: 25 },
    ])
    expect(fakes.fetch).toHaveBeenCalledTimes(1)
    expect(fakes.fetch.mock.calls[0]?.[0]).toBe('https://chatgpt.com/backend-api/wham/usage')
    expect(sentHeaders(0)['Authorization']).toBe('Bearer codex-token')
    expect(sentHeaders(0)['ChatGPT-Account-Id']).toBe('acct-1')
  })

  it('keeps the working provider when the other one fails', async () => {
    fakes.readFileSync.mockImplementation((path: string) => {
      if (path.includes('.codex')) throw new Error('ENOENT')
      return authFile({
        anthropic: { access: 'oauth-token' },
        'openai-codex': { access: 'codex-token', accountId: 'acct-1' },
      })
    })
    fakes.fetch.mockRejectedValueOnce(new Error('offline'))
    fakes.fetch.mockResolvedValueOnce(
      okJson({ rate_limit: { primary_window: { used_percent: 10 } } }),
    )
    expect(await fetchAllowance('pi', 'pi')).toMatchObject([{ label: 'Codex 5h' }])
  })

  it('rejects when every configured provider fails so the reader keeps the last sample', async () => {
    fakes.readFileSync.mockImplementation(() => authFile({ anthropic: { access: 'oauth-token' } }))
    fakes.fetch.mockRejectedValueOnce(new Error('offline'))
    await expect(fetchAllowance('pi', 'pi')).rejects.toThrow('offline')
  })
})
