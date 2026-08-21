import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { Message } from '@ari/contracts/message'
import { MessageFooter } from './MessageFooter'

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'm1',
    sessionId: 's1',
    turnId: null,
    role: 'assistant',
    parts: [
      { type: 'text', text: 'Part one' },
      { type: 'thinking', text: 'internal reasoning' },
      { type: 'text', text: 'Part two' },
      { type: 'tool-call', callId: 'c1', name: 'bash', argsJson: '{"command":"ls"}' },
    ],
    createdAt: new Date('2026-08-22T10:30:00').getTime(),
    ...overrides,
  }
}

describe('MessageFooter', () => {
  it('renders a local timestamp for the message', () => {
    render(<MessageFooter message={makeMessage()} />)
    expect(screen.getByText(/^\d{1,2}:\d{2}/)).toBeInTheDocument()
  })

  it('renders k-formatted token counts and cost when usage is present', () => {
    render(
      <MessageFooter
        message={makeMessage()}
        usage={{ inputTokens: 1234, outputTokens: 340, costUsd: 0.004 }}
      />,
    )
    expect(screen.getByText('↑1.2k ↓340 · .004')).toBeInTheDocument()
  })

  it('omits the usage line without a usage prop', () => {
    render(<MessageFooter message={makeMessage()} />)
    expect(screen.queryByText(/↑/)).not.toBeInTheDocument()
  })

  it('copies only the concatenated text parts of the message', async () => {
    const user = userEvent.setup()
    const writeText = vi.fn(() => Promise.resolve())
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    render(
      <MessageFooter
        message={makeMessage()}
        usage={{ inputTokens: 1000, outputTokens: 1000, costUsd: 0.001 }}
      />,
    )
    await user.click(screen.getByRole('button', { name: 'Copy' }))
    expect(writeText).toHaveBeenCalledOnce()
    expect(writeText).toHaveBeenCalledWith('Part one\nPart two')
  })
})
