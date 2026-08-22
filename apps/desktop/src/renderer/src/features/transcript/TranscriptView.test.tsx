import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { createElement } from 'react'
import type { Message } from '@ari/contracts/message'
import { TranscriptView } from './TranscriptView'

// jsdom implements neither ResizeObserver nor element scrolling; TranscriptView's
// stick-to-bottom effect calls scrollTo during mount (same stubs as the perf test).
if (!Element.prototype.scrollTo) {
  Element.prototype.scrollTo = () => {}
}
Element.prototype.getBoundingClientRect = () => ({ height: 64 }) as DOMRect

afterEach(cleanup)

function message(id: string): Message {
  return {
    id,
    sessionId: 'sess_1',
    turnId: null,
    role: 'user',
    parts: [{ type: 'text', text: `hello ${id}` }],
    createdAt: 1,
  }
}

describe('TranscriptView loading state', () => {
  it('shows four skeleton rows while the initial session.load resolves', () => {
    const { container } = render(
      createElement(TranscriptView, { sessionId: 'sess_1', messages: [], loading: true }),
    )

    expect(container.querySelectorAll('.ari-pulse')).toHaveLength(4)
    expect(screen.queryByText(/No messages yet/)).not.toBeInTheDocument()
  })

  it('shows the empty state once loading finishes with no messages', () => {
    render(createElement(TranscriptView, { sessionId: 'sess_1', messages: [], loading: false }))

    expect(screen.getByText(/No messages yet/)).toBeInTheDocument()
  })

  it('defaults to not loading so existing callers render unchanged', () => {
    const { container } = render(
      createElement(TranscriptView, { sessionId: 'sess_1', messages: [message('m1')] }),
    )

    expect(container.querySelectorAll('.ari-pulse')).toHaveLength(0)
    expect(container.querySelector('[data-index]')).not.toBeNull()
  })
})
