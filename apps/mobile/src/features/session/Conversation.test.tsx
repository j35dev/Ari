// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import type { Message } from '@ari/contracts/message'
import { Conversation } from './Conversation'

afterEach(cleanup)
it('renders streamed words as one paragraph and keeps a split code fence intact', () => {
  const message: Message = {
    id: 'message-1',
    sessionId: 'session-1',
    turnId: null,
    role: 'assistant',
    createdAt: 1,
    parts: ['This ', 'is ', 'one ', 'paragraph.', '\n\n```ts\nconst ', 'value = 1', '\n```'].map(
      (text) => ({ type: 'text', text }),
    ),
  }
  const { container } = render(<Conversation messages={[message]} sessionId="session-1" />)
  expect(screen.getByText('This is one paragraph.')).toBeTruthy()
  expect(container.querySelectorAll('.markdown')).toHaveLength(1)
  expect(container.querySelectorAll('.markdown p')).toHaveLength(1)
  expect(container.querySelector('pre code')?.textContent).toBe('const value = 1\n')
})

it('collapses consecutive reasoning and tools behind one activity summary', () => {
  const message: Message = {
    id: 'message-2',
    sessionId: 'session-1',
    turnId: null,
    role: 'assistant',
    createdAt: 1,
    parts: [
      { type: 'thinking', text: 'Check the implementation.' },
      { type: 'tool-call', callId: 'call-1', name: 'read', argsJson: '{}' },
      { type: 'tool-result', callId: 'call-1', resultJson: 'ok', isError: false },
      { type: 'text', text: 'The change is ready.' },
    ],
  }
  const { container } = render(<Conversation messages={[message]} sessionId="session-1" />)
  expect(screen.getAllByText('Agent activity')).toHaveLength(1)
  expect(container.querySelector('details')?.open).toBe(false)
  expect(screen.getByText('The change is ready.')).toBeTruthy()
})
