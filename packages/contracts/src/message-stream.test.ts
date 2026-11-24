import { describe, expect, it } from 'vitest'
import { pushMessageParts, type MessagePart } from './message'

describe('message stream folding', () => {
  it('keeps channel identities separate and applies an authoritative replacement in place', () => {
    const parts: MessagePart[] = []
    pushMessageParts(parts, [
      { type: 'text', text: 'sub', streamId: 'reply' },
      { type: 'thinking', text: 'opaque', streamId: 'private' },
      { type: 'text', text: 'scription', streamId: 'reply' },
      { type: 'text', text: 'subscription.', streamId: 'reply', replace: true },
    ])
    expect(parts.map((part) => part.type)).toEqual(['text', 'thinking'])
    expect(parts[0]).toMatchObject({ text: 'subscription.' })
    expect(parts[1]).toMatchObject({ text: 'opaque' })
  })
  it('replaces partial output and never downgrades a final result to a late preview', () => {
    const parts: MessagePart[] = []
    pushMessageParts(parts, [
      { type: 'tool-result', callId: 't', resultJson: 'running', isError: false, isPartial: true },
      { type: 'tool-result', callId: 't', resultJson: 'complete', isError: false },
      {
        type: 'tool-result',
        callId: 't',
        resultJson: 'late preview',
        isError: false,
        isPartial: true,
      },
    ])
    expect(parts).toEqual([
      { type: 'tool-result', callId: 't', resultJson: 'complete', isError: false },
    ])
  })
})
