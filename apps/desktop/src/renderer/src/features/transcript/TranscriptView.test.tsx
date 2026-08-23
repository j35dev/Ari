import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
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

const TURN_DIFF =
  'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n'

describe('TranscriptView per-turn diff cards', () => {
  function turnMessage(id: string, turnId: string): Message {
    return {
      id,
      sessionId: 'sess_1',
      turnId,
      role: 'assistant',
      parts: [{ type: 'text', text: `edited in ${turnId}` }],
      createdAt: 1,
    }
  }

  it('renders a collapsed diff card for a settled turn with a diff', () => {
    const { container } = render(
      createElement(TranscriptView, {
        sessionId: 'sess_1',
        messages: [message('m1'), turnMessage('m2', 'turn_7')],
        turnDiffs: { turn_7: TURN_DIFF },
      }),
    )

    const toggle = screen.getByRole('button', { name: 'Turn diff: 1 file changed' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('-old')).not.toBeInTheDocument()
    expect(container.querySelector('[data-turn-diff="turn_7"]')).not.toBeNull()
  })

  it('renders no card when the turn has no diff entry', () => {
    const { container } = render(
      createElement(TranscriptView, {
        sessionId: 'sess_1',
        messages: [turnMessage('m2', 'turn_7')],
      }),
    )

    expect(screen.queryByRole('button', { name: /Turn diff/ })).not.toBeInTheDocument()
    expect(container.querySelector('[data-turn-diff]')).toBeNull()
  })

  it('expands into the shared unified diff viewer when clicked', async () => {
    const user = userEvent.setup()
    render(
      createElement(TranscriptView, {
        sessionId: 'sess_1',
        messages: [turnMessage('m2', 'turn_7')],
        turnDiffs: { turn_7: TURN_DIFF },
      }),
    )

    await user.click(screen.getByRole('button', { name: 'Turn diff: 1 file changed' }))

    expect(screen.getByRole('button', { name: 'Toggle src/a.ts' })).toBeInTheDocument()
    // parseDiff strips marker characters, so rows render bare content.
    expect(screen.getByText('new')).toBeInTheDocument()
    expect(screen.getByText('old')).toBeInTheDocument()
  })
})
