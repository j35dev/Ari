import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { Bot } from '@ari/contracts/bot'
import type { SessionActivity } from '../session/session-activity'
import { BotChatHead } from './BotChatHead'

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

/** The head's avatar hides behind class, like every decorative bot face. */
function avatar(): SVGElement {
  const svg = document.querySelector('svg.ari-bot')
  if (svg === null) throw new Error('no avatar rendered')
  return svg as SVGElement
}

describe('BotChatHead', () => {
  it('shows the bot as a contact: face, name, title, tagline', () => {
    render(<BotChatHead bot={FORGE} />)
    expect(screen.getByText('Forge')).toBeInTheDocument()
    expect(screen.getByText('Builder')).toBeInTheDocument()
    expect(screen.getByText('Hot iron. Small diffs.')).toBeInTheDocument()
    expect(avatar().getAttribute('data-mood')).toBe('idle')
  })

  it('reads the live turn phase over the tagline', () => {
    const activity: SessionActivity = { phase: 'working', startedAt: 1 }
    render(<BotChatHead bot={FORGE} activity={activity} />)
    expect(screen.getByText('is working…')).toBeInTheDocument()
    expect(screen.queryByText('Hot iron. Small diffs.')).not.toBeInTheDocument()
    expect(avatar().getAttribute('data-mood')).toBe('working')
  })

  it('nouns the pauses: approval and question read differently', () => {
    const { unmount } = render(
      <BotChatHead
        bot={FORGE}
        activity={{ phase: 'paused', startedAt: 1, pauseReason: 'approval' }}
      />,
    )
    expect(screen.getByText('wants your approval')).toBeInTheDocument()
    unmount()
    render(
      <BotChatHead
        bot={FORGE}
        activity={{ phase: 'paused', startedAt: 1, pauseReason: 'input' }}
      />,
    )
    expect(screen.getByText('has a question for you')).toBeInTheDocument()
  })

  it('renders nothing for an unresolved bot', () => {
    const { container } = render(<BotChatHead bot={undefined} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('offers the Mind drawer button when wired', () => {
    const onMind = vi.fn()
    const { rerender } = render(<BotChatHead bot={FORGE} onMind={onMind} />)
    const mind = screen.getByRole('button', { name: "Open Forge's mind" })
    mind.click()
    expect(onMind).toHaveBeenCalledOnce()
    rerender(<BotChatHead bot={FORGE} onMind={onMind} mindOpen />)
    expect(mind.querySelector('.text-accent')).not.toBeNull()
  })

  it('stays purely presentational without an onMind', () => {
    render(<BotChatHead bot={FORGE} />)
    expect(screen.queryByRole('button', { name: "Open Forge's mind" })).not.toBeInTheDocument()
  })
})
