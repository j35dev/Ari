import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { Bot } from '@ari/contracts/bot'
import { NewBotDialog } from './NewBotDialog'

const rpcMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  subscribe: vi.fn(() => () => undefined),
}))
vi.mock('../../lib/rpc', () => ({ rpc: rpcMocks }))
const invokeMock = rpcMocks.invoke as unknown as Mock

const CREATED: Bot = {
  id: 'bot_1',
  name: 'Forge',
  emoji: '🤖',
  personaMd: '',
  driverKind: 'ari-core',
  modelId: null,
  projectId: 'proj_1',
}

beforeEach(() => {
  invokeMock.mockReset()
  invokeMock.mockImplementation(async (method: string) => {
    if (method === 'providers.models') return {}
    return []
  })
})

describe('NewBotDialog', () => {
  it('uses the first project when the projects arrive after it mounts', async () => {
    const onCreate = vi.fn(async () => CREATED)
    const props = {
      open: true,
      onOpenChange: vi.fn(),
      driverKind: 'ari-core' as const,
      modelId: null,
      onCreate,
      onCreated: vi.fn(),
    }
    const { rerender } = render(<NewBotDialog {...props} projects={[]} />)
    rerender(<NewBotDialog {...props} projects={[{ id: 'proj_1', name: 'Ari' }]} />)

    await userEvent.click(screen.getByRole('button', { name: 'Forge' }))
    await userEvent.click(screen.getByRole('button', { name: 'Create bot' }))

    await waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'proj_1' })),
    )
  })
})
