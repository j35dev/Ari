import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach, type Mock } from 'vitest'
import type { Bot } from '@ari/contracts/bot'
import type { SessionActivity } from '../session/session-activity'
import { BotChatHead } from './BotChatHead'

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
  character: { shape: 'gumdrop', palette: 6 },
  title: 'Builder',
  tagline: 'Hot iron. Small diffs.',
  personaMd: '# Forge',
  driverKind: 'ari-core',
  modelId: null,
}

function stubBots(bots: Bot[]): void {
  invokeMock.mockImplementation(async (method: string) =>
    method === 'bots.list' ? bots : undefined,
  )
}

/** The head's avatar hides behind class, like every decorative bot face. */
function avatar(): SVGElement {
  const svg = document.querySelector('svg.ari-bot')
  if (svg === null) throw new Error('no avatar rendered')
  return svg as SVGElement
}

describe('BotChatHead', () => {
  beforeEach(() => {
    invokeMock.mockReset()
  })

  it('shows the bot as a contact: face, name, title, tagline', async () => {
    stubBots([FORGE])
    render(<BotChatHead botId={FORGE.id} />)
    await screen.findByText('Forge')
    expect(screen.getByText('Builder')).toBeInTheDocument()
    expect(screen.getByText('Hot iron. Small diffs.')).toBeInTheDocument()
    expect(avatar().getAttribute('data-mood')).toBe('idle')
  })

  it('reads the live turn phase over the tagline', async () => {
    stubBots([FORGE])
    const activity: SessionActivity = { phase: 'working', startedAt: 1 }
    render(<BotChatHead botId={FORGE.id} activity={activity} />)
    await screen.findByText('is working…')
    expect(screen.queryByText('Hot iron. Small diffs.')).not.toBeInTheDocument()
    expect(avatar().getAttribute('data-mood')).toBe('working')
  })

  it('nouns the pauses: approval and question read differently', async () => {
    stubBots([FORGE])
    const { rerender } = render(
      <BotChatHead
        botId={FORGE.id}
        activity={{ phase: 'paused', startedAt: 1, pauseReason: 'approval' }}
      />,
    )
    await screen.findByText('wants your approval')
    rerender(
      <BotChatHead
        botId={FORGE.id}
        activity={{ phase: 'paused', startedAt: 1, pauseReason: 'input' }}
      />,
    )
    expect(screen.getByText('has a question for you')).toBeInTheDocument()
  })

  it('renders nothing for a bot that is not on disk', async () => {
    stubBots([])
    const { container } = render(<BotChatHead botId="bot_gone" />)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(container).toBeEmptyDOMElement()
  })
})
