import { act, render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { Bot } from '@ari/contracts/bot'
import { botsChanged } from './bots-version'
import { useBotOf } from './use-bot'

const rpcMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  subscribe: vi.fn(() => () => undefined),
}))
vi.mock('../../lib/rpc', () => ({ rpc: rpcMocks }))
const invokeMock = rpcMocks.invoke as unknown as Mock

const FORGE: Bot = {
  id: 'bot_1',
  name: 'Forge',
  emoji: '⚒️',
  personaMd: '# Forge',
  driverKind: 'ari-core',
  modelId: null,
}

let read: Bot | undefined = undefined
function Probe(): null {
  read = useBotOf('bot_1')
  return null
}

describe('useBotOf', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('finds the bot on disk', async () => {
    invokeMock.mockImplementation(async (method: string) =>
      method === 'bots.list' ? [FORGE] : undefined,
    )
    render(<Probe />)
    await vi.waitFor(() => expect(read).toEqual(FORGE))
  })

  it('re-reads when a writer bumps the bot version', async () => {
    let bots: Bot[] = [FORGE]
    invokeMock.mockImplementation(async (method: string) =>
      method === 'bots.list' ? bots : undefined,
    )
    render(<Probe />)
    await vi.waitFor(() => expect(read).toEqual(FORGE))
    const renamed: Bot = { ...FORGE, name: 'Forge II' }
    bots = [renamed]
    act(() => {
      botsChanged()
    })
    await vi.waitFor(() => expect(read).toEqual(renamed))
    expect(invokeMock.mock.calls.filter(([method]) => method === 'bots.list')).toHaveLength(2)
  })

  it('answers nothing for a bot that is gone', async () => {
    invokeMock.mockImplementation(async (method: string) =>
      method === 'bots.list' ? [] : undefined,
    )
    render(<Probe />)
    await vi.waitFor(() => expect(read).toBeUndefined())
  })
})
