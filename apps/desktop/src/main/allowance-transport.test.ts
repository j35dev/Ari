// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { fetchAllowance } from './provider-allowance'

const fakes = vi.hoisted(() => ({
  native: { request: vi.fn(), shutdown: vi.fn() },
  acp: {
    requestExtension: vi.fn(),
    newSession: vi.fn(),
    prompt: vi.fn(),
    shutdown: vi.fn(),
    kill: vi.fn(),
    onSessionUpdate: null as null | ((event: unknown) => void),
  },
  connect: vi.fn(),
}))
vi.mock('@ari/providers/codex/appserver-connection', () => ({
  AppServerConnection: { start: () => fakes.native },
}))
vi.mock('@ari/providers/acp/connection', () => ({ AcpConnection: { connect: fakes.connect } }))
vi.mock('@ari/providers/acp/launches', () => ({
  resolveAcpLaunch: () => ({ command: 'cli', args: [] }),
  probeLaunch: (launch: unknown) => launch,
}))

beforeEach(() => {
  vi.resetAllMocks()
  fakes.connect.mockResolvedValue(fakes.acp)
  fakes.acp.onSessionUpdate = null
})
afterEach(() => {
  vi.useRealTimers()
})

it('uses Grok billing directly without opening a session or sending a prompt', async () => {
  fakes.acp.requestExtension.mockResolvedValue({
    config: { creditUsagePercent: 23, currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY' } },
  })
  expect(await fetchAllowance('grok', 'grok')).toMatchObject([{ label: 'Weekly', usedPercent: 23 }])
  expect(fakes.acp.requestExtension).toHaveBeenCalledWith('_x.ai/billing', {})
  expect(fakes.acp.prompt).not.toHaveBeenCalled()
  expect(fakes.acp.newSession).not.toHaveBeenCalled()
  expect(fakes.acp.shutdown).toHaveBeenCalledOnce()
})

it('actively queries native Codex limits and closes the transport on failure', async () => {
  fakes.native.request.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('offline'))
  await expect(fetchAllowance('codex', 'codex')).rejects.toThrow('offline')
  expect(fakes.native.request).toHaveBeenLastCalledWith('account/rateLimits/read', {}, 10_000)
  expect(fakes.native.shutdown).toHaveBeenCalledOnce()
})

it('does not send an unadvertised Claude slash command', async () => {
  fakes.acp.newSession.mockImplementation(async () => {
    fakes.acp.onSessionUpdate?.({ update: { availableCommands: {} } })
    fakes.acp.onSessionUpdate?.({ update: { availableCommands: [null, { name: 'context' }] } })
    return { sessionId: 'probe' }
  })
  expect(await fetchAllowance('claude', 'claude')).toEqual([])
  expect(fakes.acp.prompt).not.toHaveBeenCalled()
  expect(fakes.acp.shutdown).toHaveBeenCalledOnce()
})

it('collects Claude quota chunks and shuts down a stalled usage command', async () => {
  vi.useFakeTimers()
  fakes.acp.newSession.mockImplementation(async () => {
    fakes.acp.onSessionUpdate?.({ update: { availableCommands: [{ name: 'usage' }] } })
    return { sessionId: 'probe' }
  })
  fakes.acp.prompt.mockImplementationOnce(async () => {
    fakes.acp.onSessionUpdate?.({
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { text: '**5-hour limit** — **12%**' },
      },
    })
  })
  expect(await fetchAllowance('claude', 'claude')).toMatchObject([{ usedPercent: 12 }])
  expect(fakes.acp.prompt).toHaveBeenCalledWith('probe', '/usage', { timeoutMs: 10_000 })
  fakes.acp.prompt.mockRejectedValueOnce(new Error('timed out'))
  await expect(fetchAllowance('claude', 'claude')).rejects.toThrow('timed out')
  expect(fakes.acp.shutdown).toHaveBeenCalledTimes(2)
})
