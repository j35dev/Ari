import { render, screen, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { Message } from '@ari/contracts/message'
import type { ResponseStyle } from '@ari/contracts/settings'
import { TranscriptView } from './TranscriptView'

const messages: Message[] = [
  {
    id: 'message-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    role: 'assistant',
    createdAt: 1000,
    parts: [{ type: 'text', text: '# A heading\n\nA complete paragraph.\n\nA growing paragraph' }],
  },
]
const tool: Message = {
  id: 'tools',
  sessionId: 'session-1',
  turnId: 'turn-1',
  role: 'assistant',
  createdAt: 1001,
  parts: [{ type: 'tool-call', callId: 'read', name: 'Read', argsJson: '{"path":"src/a.ts"}' }],
}

describe('TranscriptView optional presentations', () => {
  it('uses the existing renderer for omitted, explicit-default and unknown preferences', () => {
    const { container, rerender } = render(
      <TranscriptView sessionId="session-1" messages={[tool]} />,
    )
    expect(container.querySelector('.ari-burst')).not.toBeNull()
    const before = container.querySelector('.ari-burst')
    rerender(<TranscriptView sessionId="session-1" messages={[tool]} responseStyle="default" />)
    expect(container.querySelector('.ari-burst')).toBe(before)
    rerender(
      <TranscriptView
        sessionId="session-1"
        messages={[tool]}
        responseStyle={'unknown' as ResponseStyle}
      />,
    )
    expect(container.querySelector('.ari-burst')).toBe(before)
    expect(container.querySelector('.ari-response-activity')).toBeNull()
  })

  it('retains the markdown DOM and its live status across all presentation switches', () => {
    const { container, rerender } = render(
      <TranscriptView sessionId="session-1" messages={messages} running />,
    )
    const markdown = container.querySelector('.ari-md')
    const paragraph = markdown?.querySelector('p')
    for (const responseStyle of ['flow', 'fold', 'margin', 'signal', 'default'] as const) {
      rerender(
        <TranscriptView
          sessionId="session-1"
          messages={messages}
          running
          responseStyle={responseStyle}
        />,
      )
      expect(container.querySelector('.ari-md')).toBe(markdown)
      expect(markdown?.querySelector('p')).toBe(paragraph)
      expect(markdown).toHaveAttribute('data-streaming')
    }
    const next: Message[] = [
      {
        ...messages[0]!,
        parts: [
          {
            type: 'text',
            text: '# A heading\n\nA complete paragraph.\n\nA growing paragraph, continued.',
          },
        ],
      },
    ]
    rerender(<TranscriptView sessionId="session-1" messages={next} running responseStyle="fold" />)
    expect(markdown?.querySelector('p')).toBe(paragraph)
    expect(markdown).toHaveTextContent('continued.')
  })

  it('does not call an old unanswered tool running just because a later turn is active', async () => {
    const later: Message = { ...messages[0]!, id: 'later', turnId: 'turn-2' }
    const { container } = render(
      <TranscriptView
        sessionId="session-1"
        messages={[tool, later]}
        running
        responseStyle="flow"
      />,
    )
    await userEvent.setup().click(screen.getByRole('button', { name: /Expand activity/ }))
    expect(container.querySelector('.ari-response-tool-card')).toHaveAttribute(
      'data-tool-state',
      'unanswered',
    )
  })

  it('keeps parallel tools in the current turn pending across an intervening text message', async () => {
    const { container } = render(
      <TranscriptView
        sessionId="session-1"
        messages={[tool, messages[0]!]}
        running
        responseStyle="flow"
      />,
    )
    await userEvent.setup().click(screen.getByRole('button', { name: /Expand activity/ }))
    expect(container.querySelector('.ari-response-tool-card')).toHaveAttribute(
      'data-tool-state',
      'running',
    )
  })

  it('releases the scroll pin before opening a tool, so output cannot pull the reader away', async () => {
    const { container } = render(
      <TranscriptView sessionId="session-1" messages={[tool]} running responseStyle="flow" />,
    )
    const scroller = screen.getByRole('log')
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 200 })
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 800 })
    scroller.scrollTop = 600
    const scrollTo = vi.fn()
    scroller.scrollTo = scrollTo
    fireEvent.scroll(scroller)
    await userEvent.setup().click(screen.getByRole('button', { name: 'Inspect Read src/a.ts' }))
    expect(screen.getByRole('button', { name: /Jump to latest/ })).toBeInTheDocument()
    expect(container.querySelector('.ari-response-details')).not.toBeNull()
    expect(scrollTo).not.toHaveBeenCalled()
  })
})
