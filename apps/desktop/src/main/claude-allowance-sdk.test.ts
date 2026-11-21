// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest'
import { fetchAllowance, fetchAllowanceReading } from './provider-allowance'
import { setProviderEnvironment } from './provider-env'

const fakes = vi.hoisted(() => ({
  usage: vi.fn(),
  withQuery: vi.fn(),
  bank: vi.fn(),
  acp: vi.fn(),
}))
vi.mock('@ari/providers/claude', () => ({ withClaudeQuery: fakes.withQuery }))
vi.mock('@ari/providers/acp/connection', () => ({ AcpConnection: { connect: fakes.acp } }))
vi.mock('./reset-credits', () => ({ resetCreditService: { readClaude: fakes.bank } }))
afterEach(() => {
  vi.resetAllMocks()
  setProviderEnvironment(() => ({}))
  vi.unstubAllEnvs()
})

it('reads SDK account windows and keeps reset credits without opening an ACP session', async () => {
  vi.stubEnv('ARI_CLAUDE_TRANSPORT', 'sdk')
  setProviderEnvironment(() => ({ CLAUDE_CONFIG_DIR: '/account-two' }))
  fakes.usage.mockResolvedValue({
    rate_limits_available: true,
    rate_limits: {
      five_hour: { utilization: 42, resets_at: '2026-11-21T10:00:00Z' },
      seven_day: { utilization: 10, resets_at: null },
      seven_day_opus: { utilization: 8, resets_at: null },
    },
  })
  fakes.withQuery.mockImplementation(
    (_binary, _cwd, _env, operation: (query: unknown) => Promise<unknown>) =>
      operation({ usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: fakes.usage }),
  )
  const bank = { availableCount: 2, nextExpiresAt: null, credits: [] }
  fakes.bank.mockResolvedValue(bank)
  expect(await fetchAllowanceReading('claude', 'installed.exe')).toEqual({
    windows: [
      { label: '5h', usedPercent: 42, resetsAt: Date.parse('2026-11-21T10:00:00Z') },
      { label: 'Weekly', usedPercent: 10, resetsAt: null },
      { label: 'Weekly · Opus', usedPercent: 8, resetsAt: null },
    ],
    resetCredits: bank,
    resetCreditsKnown: true,
  })
  expect(fakes.withQuery.mock.calls[0]?.[2]).toMatchObject({ CLAUDE_CONFIG_DIR: '/account-two' })
  expect(fakes.usage).toHaveBeenCalledWith({ skipBehaviors: true })
  expect(fakes.acp).not.toHaveBeenCalled()
})

it('propagates SDK failures so the usage pill retains its existing stale-sample behavior', async () => {
  vi.stubEnv('ARI_CLAUDE_TRANSPORT', 'sdk')
  fakes.withQuery.mockRejectedValue(new Error('offline'))
  await expect(fetchAllowance('claude', 'installed.exe')).rejects.toThrow('offline')
})
