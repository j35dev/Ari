import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import type { Message } from '@ari/contracts/message'
import { TranscriptView } from './TranscriptView'

vi.mock('./attachment-urls', () => ({
  attachmentDataUrl: () => Promise.resolve('data:image/png;base64,aGk='),
}))

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

describe('TranscriptView delegation', () => {
  const titles: Record<string, string> = { child_a: 'Parser', child_b: 'Docs' }
  const onOpenSession = vi.fn()
  const view = (messages: Message[], extra: Record<string, unknown> = {}) =>
    createElement(TranscriptView, {
      sessionId: 'sess_1',
      messages,
      sessionTitle: (id: string) => titles[id],
      onOpenSession,
      ...extra,
    })

  it('shows a delivery notice as a status row, not something the user typed', async () => {
    const notice: Message = {
      ...message('n'),
      origin: { kind: 'completion', sessionIds: ['child_a', 'child_b'] },
      parts: [
        {
          type: 'text',
          text: '[Ari delegation update: added automatically by Ari, not written by the user.]\n\nChild session "Parser" (child_a) finished its turn.\nReport:\nFixed it.',
        },
      ],
    }
    render(view([message('a'), notice, message('b')]))
    const row = screen.getByRole('button', {
      name: 'Delegation update: Parser, Docs reported back',
    })
    expect(screen.queryByText(/Fixed it\./)).not.toBeInTheDocument()
    // Only the two typed prompts are places to jump to.
    expect(screen.getAllByRole('button', { name: /^Jump to/ })).toHaveLength(2)

    await userEvent.click(row)
    expect(screen.getByText(/Fixed it\./)).toBeInTheDocument()
    expect(screen.queryByText(/not written by the user/)).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Open Docs' }))
    expect(onOpenSession).toHaveBeenCalledWith('child_b')
  })

  it('names the session a relayed message came from and offers no edit', async () => {
    const relayed: Message = { ...message('q'), origin: { kind: 'session', sessionId: 'child_a' } }
    render(view([relayed], { onEditUserMessage: vi.fn() }))
    await userEvent.click(screen.getByRole('button', { name: 'From session Parser' }))
    expect(onOpenSession).toHaveBeenCalledWith('child_a')
    expect(screen.queryByRole('button', { name: 'Edit message' })).not.toBeInTheDocument()
  })

  it('renders delegated children as task cards that open the child', async () => {
    const delegations = [
      {
        sessionId: 'child_a',
        title: 'Parser',
        role: 'review',
        driverKind: 'codex',
        modelId: 'gpt-5',
        state: 'done' as const,
        startedAt: null,
        report: 'Two findings.\nSee notes.',
        anchor: { messageId: 'a', partIndex: 0 },
      },
      {
        sessionId: 'child_b',
        title: 'Docs',
        role: null,
        driverKind: 'claude',
        modelId: null,
        state: 'working' as const,
        startedAt: Date.now() - 5_000,
        report: null,
        anchor: { messageId: 'a', partIndex: 0 },
      },
    ]
    const { container } = render(view([message('a')], { delegations }))
    expect(screen.getByText('Delegated to 2 sessions')).toBeInTheDocument()
    expect(screen.getByText('1 working · 1 done')).toBeInTheDocument()
    expect(screen.getByText('Two findings. See notes.')).toBeInTheDocument()
    expect(container.querySelector('[data-activity="working"]')).not.toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Open Parser: Done' }))
    expect(onOpenSession).toHaveBeenCalledWith('child_a')
  })
})

describe('TranscriptView row entrance', () => {
  const view = (messages: Message[], loading = false) =>
    createElement(TranscriptView, { sessionId: 'sess_1', messages, loading })

  it('animates rows that arrive after load, not the history it opened with', () => {
    const { container, rerender } = render(view([message('a')]))
    expect(container.querySelectorAll('.ari-enter-rise')).toHaveLength(0)

    rerender(view([message('a'), message('b')]))
    const fresh = container.querySelectorAll('.ari-enter-rise')
    expect(fresh).toHaveLength(1)
    expect(fresh[0]).toHaveTextContent('hello b')

    // A later re-render must not drop the class mid-entrance.
    rerender(view([message('a'), message('b')]))
    expect(container.querySelectorAll('.ari-enter-rise')).toHaveLength(1)

    // Once the entrance has played the class comes off, so re-showing a
    // hidden pane cannot replay it.
    // jsdom has no AnimationEvent, so React listens for the prefixed name there.
    const risen = container.querySelector('.ari-enter-rise')!
    for (const type of ['animationend', 'webkitAnimationEnd']) {
      fireEvent(risen, new Event(type, { bubbles: true }))
    }
    expect(container.querySelectorAll('.ari-enter-rise')).toHaveLength(0)
  })

  it('treats rows delivered by the initial load as history', () => {
    const { container, rerender } = render(view([], true))
    rerender(view([message('a'), message('b')]))
    expect(container.querySelectorAll('.ari-enter-rise')).toHaveLength(0)
  })

  it('animates the first message of an empty session', () => {
    const { container, rerender } = render(view([]))
    rerender(view([message('a')]))
    expect(container.querySelectorAll('.ari-enter-rise')).toHaveLength(1)
  })
})

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

  it('keeps every row in document flow so long sessions scroll as one page', () => {
    const messages = Array.from({ length: 24 }, (_, i) => message(`m${i}`))
    const { container } = render(createElement(TranscriptView, { sessionId: 'sess_1', messages }))
    expect(container.querySelectorAll('[data-index]')).toHaveLength(24)
  })

  it('unpins stick-to-bottom on wheel-up so the jump pill appears', () => {
    const { container } = render(
      createElement(TranscriptView, { sessionId: 'sess_1', messages: [message('m1')] }),
    )
    const scroller = container.querySelector('[aria-label="Conversation transcript"]')
    expect(scroller).not.toBeNull()
    fireEvent.wheel(scroller!, { deltaY: -48 })
    expect(screen.getByRole('button', { name: /Jump to latest/ })).toBeInTheDocument()
  })

  it('stays pinned when a scroll event is content growth, not a reader move', () => {
    const { container } = render(
      createElement(TranscriptView, {
        sessionId: 'sess_1',
        messages: [message('m1'), message('m2'), message('m3')],
      }),
    )
    const scroller = container.querySelector('[aria-label="Conversation transcript"]')
    expect(scroller).not.toBeNull()
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, get: () => 4000 })
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, get: () => 400 })
    Object.defineProperty(scroller, 'scrollTop', { configurable: true, writable: true, value: 0 })
    fireEvent.scroll(scroller!)
    expect(screen.queryByRole('button', { name: /Jump to latest/ })).not.toBeInTheDocument()
  })

  it('re-pins to the tail when switching sessions', () => {
    const { rerender, container } = render(
      createElement(TranscriptView, { sessionId: 'sess_1', messages: [message('m1')] }),
    )
    const scroller = container.querySelector('[aria-label="Conversation transcript"]')
    expect(scroller).not.toBeNull()
    fireEvent.wheel(scroller!, { deltaY: -48 })
    expect(screen.getByRole('button', { name: /Jump to latest/ })).toBeInTheDocument()

    rerender(
      createElement(TranscriptView, {
        sessionId: 'sess_2',
        messages: [message('m2'), message('m3')],
      }),
    )
    expect(screen.queryByRole('button', { name: /Jump to latest/ })).not.toBeInTheDocument()
  })
})

describe('TranscriptView image output', () => {
  it('renders provider images as assistant content', async () => {
    render(
      createElement(TranscriptView, {
        sessionId: 'sess_1',
        messages: [
          {
            ...message('generated'),
            role: 'assistant',
            parts: [
              {
                type: 'image',
                attachmentId: 'att_generated',
                name: 'generated.png',
                mimeType: 'image/png',
                size: 2,
              },
            ],
          },
        ],
      }),
    )

    expect(screen.getByRole('list', { name: 'Generated images' })).toBeInTheDocument()
    expect(await screen.findByRole('img', { name: 'generated.png' })).toHaveAttribute(
      'src',
      'data:image/png;base64,aGk=',
    )
  })

  it('opens a full-size preview with an original-file download', async () => {
    const user = userEvent.setup()
    render(
      createElement(TranscriptView, {
        sessionId: 'sess_1',
        messages: [
          {
            ...message('generated'),
            role: 'assistant',
            parts: [
              {
                type: 'image',
                attachmentId: 'att_generated',
                name: 'generated.png',
                mimeType: 'image/png',
                size: 2,
              },
            ],
          },
        ],
      }),
    )

    await user.click(await screen.findByRole('button', { name: 'Open generated.png' }))

    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'Full-size generated.png' })).toHaveAttribute(
      'src',
      'data:image/png;base64,aGk=',
    )
    expect(screen.getByRole('link', { name: 'Download' })).toHaveAttribute(
      'download',
      'generated.png',
    )

    await user.click(screen.getByRole('button', { name: 'Close image preview' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})

describe('TranscriptView message actions', () => {
  it('offers edit on user bubbles and reports the bubble text', async () => {
    const user = userEvent.setup()
    const onEditUserMessage = vi.fn()
    render(
      createElement(TranscriptView, {
        sessionId: 'sess_1',
        messages: [message('m1')],
        onEditUserMessage,
      }),
    )

    await user.click(screen.getByRole('button', { name: 'Edit message' }))
    expect(onEditUserMessage).toHaveBeenCalledWith('hello m1')
  })

  it('hides the edit affordance without a handler', () => {
    render(createElement(TranscriptView, { sessionId: 'sess_1', messages: [message('m1')] }))

    expect(screen.queryByRole('button', { name: 'Edit message' })).not.toBeInTheDocument()
  })
})

describe('TranscriptView regenerate action', () => {
  function assistantMessage(id: string): Message {
    return { ...message(id), role: 'assistant' }
  }

  it('shows regenerate only on the newest assistant message and invokes it', async () => {
    const user = userEvent.setup()
    const onRegenerate = vi.fn()
    render(
      createElement(TranscriptView, {
        sessionId: 'sess_1',
        messages: [assistantMessage('a1'), message('m2'), assistantMessage('a2')],
        onRegenerate,
      }),
    )

    const buttons = screen.getAllByRole('button', { name: 'Regenerate response' })
    expect(buttons).toHaveLength(1)
    await user.click(buttons[0]!)
    expect(onRegenerate).toHaveBeenCalledOnce()
  })

  it('passes the disabled state through while a turn runs', () => {
    render(
      createElement(TranscriptView, {
        sessionId: 'sess_1',
        messages: [assistantMessage('a1')],
        onRegenerate: vi.fn(),
        regenerateDisabled: true,
      }),
    )

    expect(screen.getByRole('button', { name: 'Regenerate response' })).toBeDisabled()
  })

  it('omits regenerate without a handler', () => {
    render(
      createElement(TranscriptView, { sessionId: 'sess_1', messages: [assistantMessage('a1')] }),
    )

    expect(screen.queryByRole('button', { name: 'Regenerate response' })).not.toBeInTheDocument()
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

describe('TranscriptView tool bursts', () => {
  function toolMessage(id: string, settled = true): Message {
    return {
      id,
      sessionId: 'sess_1',
      turnId: null,
      role: 'assistant',
      parts: [
        { type: 'tool-call', callId: 'c1', name: 'Read', argsJson: '{"path":"src/a.ts"}' },
        ...(settled
          ? ([
              { type: 'tool-result', callId: 'c1', resultJson: '"ok"', isError: false },
            ] satisfies Message['parts'])
          : []),
      ],
      createdAt: 1,
    }
  }

  it('renders a lone tool call as one burst that opens straight to its body', async () => {
    const user = userEvent.setup()
    render(createElement(TranscriptView, { sessionId: 'sess_1', messages: [toolMessage('m1')] }))

    const burst = screen.getByRole('button', { name: 'Read a.ts · Read 1 file' })
    await user.click(burst)
    expect(screen.getByText('Ari Read')).toBeInTheDocument()
  })

  it('keeps the live row open across the turn, then folds it once the turn settles', async () => {
    const { rerender } = render(
      createElement(TranscriptView, {
        sessionId: 'sess_1',
        messages: [toolMessage('m1', false)],
        running: true,
      }),
    )

    expect(screen.getByRole('button', { name: /Working: Reading src\/a\.ts/ })).toHaveAttribute(
      'aria-expanded',
      'true',
    )
    expect(screen.getByText('live')).toBeInTheDocument()
    // Live, the body is the step timeline: the lone-call shortcut is a
    // settled-state affordance, so the row's shape cannot change mid-turn.
    expect(screen.getByRole('button', { name: 'Reading src/a.ts' })).toBeInTheDocument()

    rerender(
      createElement(TranscriptView, {
        sessionId: 'sess_1',
        messages: [toolMessage('m1')],
        running: false,
      }),
    )

    // The row holds open for a beat, so a turn that immediately dequeues the
    // next message cannot make it flicker shut and open again.
    expect(screen.getByRole('button', { name: /Working: Reading src\/a\.ts/ })).toHaveAttribute(
      'aria-expanded',
      'true',
    )

    const settled = await screen.findByRole('button', { name: 'Read a.ts · Read 1 file' })
    expect(settled).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('live')).not.toBeInTheDocument()
  })

  it('keeps a whole stretch of work in one row instead of a wall of tallies', () => {
    const parts: Message['parts'] = []
    for (let i = 0; i < 9; i++) {
      parts.push({ type: 'tool-call', callId: `c${i}`, name: 'Bash', argsJson: '{"command":"ls"}' })
      parts.push({ type: 'tool-result', callId: `c${i}`, resultJson: '"ok"', isError: false })
    }
    const message: Message = {
      id: 'm1',
      sessionId: 'sess_1',
      turnId: null,
      role: 'assistant',
      parts,
      createdAt: 1,
    }
    const { container } = render(
      createElement(TranscriptView, { sessionId: 'sess_1', messages: [message] }),
    )

    expect(container.querySelectorAll('.ari-burst')).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Ran ls · Ran 9 commands' })).toBeInTheDocument()
  })
})

describe('TranscriptView failure history', () => {
  it('keeps raw provider errors collapsed until details are requested', async () => {
    const user = userEvent.setup()
    const failed: Message = {
      id: 'a1',
      sessionId: 'sess_1',
      turnId: 'turn_1',
      role: 'assistant',
      parts: [{ type: 'text', text: '\n\n⚠ Error: spawn claude ENOENT' }],
      createdAt: 1,
    }
    render(createElement(TranscriptView, { sessionId: 'sess_1', messages: [failed] }))

    const disclosure = screen.getByRole('button', {
      name: 'Turn failed: Agent could not start',
    })
    expect(disclosure).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText(/spawn claude ENOENT/)).not.toBeInTheDocument()

    await user.click(disclosure)
    expect(disclosure).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText(/spawn claude ENOENT/)).toBeInTheDocument()
  })
})
