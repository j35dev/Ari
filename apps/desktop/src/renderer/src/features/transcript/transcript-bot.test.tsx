import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Bot } from '@ari/contracts/bot'
import type { Message } from '@ari/contracts/message'
import { TranscriptView } from './TranscriptView'

vi.mock('./attachment-urls', () => ({
  attachmentDataUrl: () => Promise.resolve('data:image/png;base64,aGk='),
}))

// jsdom implements neither ResizeObserver nor element scrolling (same stubs as
// TranscriptView.test).
if (!Element.prototype.scrollTo) {
  Element.prototype.scrollTo = () => {}
}
Element.prototype.getBoundingClientRect = () => ({ height: 64 }) as DOMRect

afterEach(cleanup)

const FORGE: Bot = {
  id: 'bot_1',
  name: 'Forge',
  emoji: '⚒️',
  character: { shape: 'gumdrop', palette: 6 },
  personaMd: '# Forge',
  driverKind: 'ari-core',
  modelId: null,
}

const USER: Message = {
  id: 'm1',
  sessionId: 'sess_1',
  turnId: null,
  role: 'user',
  parts: [{ type: 'text', text: 'Ship the pricing page' }],
  createdAt: 1,
}

const REPLY: Message = {
  id: 'm2',
  sessionId: 'sess_1',
  turnId: null,
  role: 'assistant',
  parts: [{ type: 'text', text: 'On it — reading the grid first.' }],
  createdAt: 2,
}

describe('TranscriptView bot rows', () => {
  it('faces what the bot says and leaves the user faceless', () => {
    render(<TranscriptView sessionId="sess_1" messages={[USER, REPLY]} bot={FORGE} />)
    expect(screen.getByText('Ship the pricing page')).toBeInTheDocument()
    expect(screen.getByText(/On it — reading the grid first\./)).toBeInTheDocument()
    const faces = document.querySelectorAll('svg.ari-bot')
    expect(faces).toHaveLength(1)
  })

  it('keeps the plain transcript when no bot owns the session', () => {
    render(<TranscriptView sessionId="sess_1" messages={[USER, REPLY]} />)
    expect(document.querySelectorAll('svg.ari-bot')).toHaveLength(0)
  })
})
