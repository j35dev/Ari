import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { createElement } from 'react'
import type { Message } from '@ari/contracts/message'
import { splitBlocks } from './splitBlocks'
import { TranscriptView } from './TranscriptView'

const BLOCKS_PER_MESSAGE = 5
const SPLIT_MESSAGE_COUNT = 10_000
const SPLIT_BLOCK_BUDGET_MS = 500
const MOUNT_MESSAGE_COUNT = 2_000

// jsdom implements neither ResizeObserver nor element scrolling; TranscriptView's
// stick-to-bottom effect calls scrollTo during mount. Zero-height rects would
// also starve the virtualizer's measure loop, so rows report the 64px estimate.
if (!Element.prototype.scrollTo) {
  Element.prototype.scrollTo = () => {}
}
Element.prototype.getBoundingClientRect = () => ({ height: 64 }) as DOMRect

afterEach(cleanup)

function syntheticMessages(count: number): Message[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `msg_${i}`,
    sessionId: 'sess_1',
    turnId: `turn_${i}`,
    role: 'assistant' as const,
    parts: [
      { type: 'text' as const, text: `paragraph ${i}` },
      { type: 'thinking' as const, text: `reasoning ${i}` },
      {
        type: 'tool-call' as const,
        callId: `call_${i}`,
        name: 'bash',
        argsJson: '{"command":"ls"}',
      },
      {
        type: 'tool-result' as const,
        callId: `call_${i}`,
        resultJson: '{"ok":true}',
        isError: false,
      },
      { type: 'text' as const, text: `summary ${i}` },
    ],
    createdAt: i,
  }))
}

describe('transcript performance budgets', () => {
  it('splits 50k blocks under the pure-transform budget', () => {
    const messages = syntheticMessages(SPLIT_MESSAGE_COUNT)

    const start = performance.now()
    const blocks = splitBlocks(messages)
    const elapsedMs = performance.now() - start

    expect(blocks).toHaveLength(SPLIT_MESSAGE_COUNT * BLOCKS_PER_MESSAGE)
    expect(elapsedMs).toBeLessThan(SPLIT_BLOCK_BUDGET_MS)
  })

  it('mounts large transcript', () => {
    const { container } = render(
      createElement(TranscriptView, {
        sessionId: 'sess_1',
        messages: syntheticMessages(MOUNT_MESSAGE_COUNT),
      }),
    )

    expect(container.querySelector('[data-session="sess_1"]')).not.toBeNull()
    expect(container.querySelectorAll('[data-index]').length).toBeGreaterThan(0)
  })
})
