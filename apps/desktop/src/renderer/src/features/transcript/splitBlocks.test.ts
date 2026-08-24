import { describe, expect, it } from 'vitest'
import type { Message, MessagePart } from '@ari/contracts/message'
import { pendingToolCallIds, splitBlocks } from './splitBlocks'

function msg(id: string, parts: MessagePart[], role: Message['role'] = 'assistant'): Message {
  return { id, sessionId: 's1', turnId: 't1', role, parts, createdAt: 1 }
}

describe('splitBlocks', () => {
  it('maps each part to a block with a stable msgId#partIndex key', () => {
    const blocks = splitBlocks([
      msg('m1', [
        { type: 'text', text: 'hello' },
        { type: 'thinking', text: 'hmm' },
        { type: 'tool-call', callId: 'c1', name: 'bash', argsJson: '"ls"' },
        { type: 'tool-result', callId: 'c1', resultJson: '"ok"', isError: false },
      ]),
    ])

    expect(blocks.map((b) => b.key)).toEqual(['m1#0', 'm1#1', 'm1#2', 'm1#3'])
    expect(blocks.map((b) => b.kind)).toEqual([
      'markdown',
      'thinking',
      'tool-call',
      'tool-result',
    ])
    expect(blocks[2]).toMatchObject({ callId: 'c1', name: 'bash', argsJson: '"ls"' })
    expect(blocks[3]).toMatchObject({ callId: 'c1', resultJson: '"ok"', isError: false })
  })

  it('keeps keys stable when later parts append to the same message', () => {
    const before = splitBlocks([msg('m1', [{ type: 'text', text: 'par' }])])
    const after = splitBlocks([
      msg('m1', [
        { type: 'text', text: 'paragraph grew' },
        { type: 'thinking', text: 'deeper' },
      ]),
    ])
    expect(after[0]?.key).toBe(before[0]?.key)
    expect(after).toHaveLength(2)
  })

  it('flattens multiple messages in order and carries user messages through', () => {
    const blocks = splitBlocks([
      msg('u1', [{ type: 'text', text: 'question' }], 'user'),
      msg('a1', [{ type: 'text', text: 'answer' }]),
    ])
    expect(blocks.map((b) => b.key)).toEqual(['u1#0', 'a1#0'])
  })

  it('returns an empty list for empty input', () => {
    expect(splitBlocks([])).toEqual([])
  })

  it('computes pending tool calls as called-but-unanswered ids', () => {
    const blocks = splitBlocks([
      msg('m1', [
        { type: 'tool-call', callId: 'c1', name: 'bash', argsJson: '{}' },
        { type: 'tool-result', callId: 'c1', resultJson: '{}', isError: false },
        { type: 'tool-call', callId: 'c2', name: 'read', argsJson: '{}' },
      ]),
    ])
    expect(pendingToolCallIds(blocks)).toEqual(new Set(['c2']))
  })

  it('coalesces streamed text parts into one flowing block with a stable key', () => {
    const before = splitBlocks([
      msg('m1', [
        { type: 'text', text: 'Hi' },
        { type: 'text', text: ' there' },
      ]),
    ])
    expect(before).toHaveLength(1)
    expect(before[0]).toMatchObject({ kind: 'markdown', text: 'Hi there', key: 'm1#0' })

    // The next flush grows the SAME block in place.
    const after = splitBlocks([
      msg('m1', [
        { type: 'text', text: 'Hi' },
        { type: 'text', text: ' there' },
        { type: 'text', text: ' friend' },
      ]),
    ])
    expect(after).toHaveLength(1)
    expect(after[0]?.key).toBe(before[0]?.key)
    expect(after[0]).toMatchObject({ text: 'Hi there friend' })
  })

  it('coalesces thinking parts separately and a tool call breaks the run', () => {
    const blocks = splitBlocks([
      msg('m1', [
        { type: 'thinking', text: 'hmm ' },
        { type: 'thinking', text: 'ok' },
        { type: 'tool-call', callId: 'c1', name: 'bash', argsJson: '{}' },
        { type: 'text', text: 'done' },
      ]),
    ])
    expect(blocks.map((b) => b.kind)).toEqual(['thinking', 'tool-call', 'markdown'])
    expect(blocks[0]).toMatchObject({ text: 'hmm ok' })
    expect(blocks[2]).toMatchObject({ text: 'done', key: 'm1#3' })
  })

  it('marks the final markdown block with isLastOfMessage for the footer', () => {
    const blocks = splitBlocks([
      msg('m1', [
        { type: 'text', text: 'part one ' },
        { type: 'text', text: 'part two' },
      ]),
    ])
    expect(blocks).toHaveLength(1)
    expect(blocks[0]?.isLastOfMessage).toBe(true)
  })
})
