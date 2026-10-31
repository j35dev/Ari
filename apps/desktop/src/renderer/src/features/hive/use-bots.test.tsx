import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { useBotsVersion } from './bots-version'
import { useBots } from './use-bots'

const rpcMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  subscribe: vi.fn(() => () => undefined),
}))
vi.mock('../../lib/rpc', () => ({ rpc: rpcMocks }))
const invokeMock = rpcMocks.invoke as unknown as Mock

const FORGE = {
  id: 'bot_1',
  name: 'Forge',
  emoji: '⚒️',
  personaMd: '# Forge',
  driverKind: 'ari-core',
  modelId: null,
  projectId: 'proj_1',
}

describe('useBots', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    invokeMock.mockImplementation(async (method: string) => {
      if (method === 'bots.list') return [FORGE]
      if (method === 'bots.update') return { ...FORGE, name: 'Forge II' }
      return undefined
    })
  })

  it('wakes other bot views when a roster edit is saved', async () => {
    const version = renderHook(() => useBotsVersion())
    const start = version.result.current
    const bots = renderHook(() => useBots())
    await waitFor(() => expect(bots.result.current.loading).toBe(false))
    await act(async () => {
      await bots.result.current.update('bot_1', { name: 'Forge II' })
    })
    expect(version.result.current).toBe(start + 1)
    expect(bots.result.current.bots[0]?.name).toBe('Forge')
  })
})
