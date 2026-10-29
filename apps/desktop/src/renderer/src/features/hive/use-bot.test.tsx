import { render } from '@testing-library/react'
import { describe, expect, it, vi, type Mock } from 'vitest'
import type { Bot } from '@ari/contracts/bot'
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
  it('finds the bot on disk', async () => {
    invokeMock.mockImplementation(async (method: string) =>
      method === 'bots.list' ? [FORGE] : undefined,
    )
    render(<Probe />)
    await vi.waitFor(() => expect(read).toEqual(FORGE))
  })

  it('answers nothing for a bot that is gone', async () => {
    invokeMock.mockImplementation(async (method: string) =>
      method === 'bots.list' ? [] : undefined,
    )
    render(<Probe />)
    await vi.waitFor(() => expect(read).toBeUndefined())
  })
})
