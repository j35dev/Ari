import { describe, expect, it } from 'vitest'
import {
  needsCompaction,
  serializeForSummary,
  splitForCompaction,
  summaryMessage,
  SUMMARY_PREFIX,
} from './context-manager'
import type { ChatMessage } from './protocols/openai-chat'

const filler = (chars: number): string => 'x'.repeat(chars)

describe('needsCompaction', () => {
  it('holds off until the budget is mostly used', () => {
    const small: ChatMessage[] = [{ role: 'user', content: filler(100) }]
    expect(needsCompaction(small, 1000)).toBe(false)
    const large: ChatMessage[] = [{ role: 'user', content: filler(800) }]
    expect(needsCompaction(large, 1000)).toBe(true)
  })
})

describe('splitForCompaction', () => {
  it('keeps system prompts and the newest turns verbatim', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: `old ask ${filler(500)}` },
      { role: 'assistant', content: 'old answer' },
      { role: 'user', content: 'recent ask' },
      { role: 'assistant', content: 'recent answer' },
    ]
    const split = splitForCompaction(messages, 40)
    expect(split.systems.map((m) => m.content)).toEqual(['sys'])
    expect(split.older.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(split.recent.map((m) => m.content)).toEqual(['recent ask', 'recent answer'])
  })

  it('cuts at a user message so a tool result is never orphaned', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'first' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read', argsJson: '{}' }] },
      { role: 'tool', content: filler(200), toolCallId: 'c1' },
      { role: 'assistant', content: 'answer' },
      { role: 'user', content: 'second' },
      { role: 'assistant', content: 'done' },
    ]
    const split = splitForCompaction(messages, 60)
    // The kept span opens on a user turn, not on the tool result that a naive
    // character cut would have landed in.
    expect(split.recent[0]?.role).toBe('user')
    expect(split.older.some((m) => m.role === 'tool')).toBe(true)
    expect([...split.older, ...split.recent]).toHaveLength(messages.length - 1)
  })

  it('summarizes nothing when the whole history fits the keep window', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'tiny' },
      { role: 'assistant', content: 'reply' },
    ]
    const split = splitForCompaction(messages, 10_000)
    expect(split.older).toEqual([])
    expect(split.recent).toHaveLength(2)
  })
})

describe('serializeForSummary', () => {
  it('labels roles and renders tool calls inline', () => {
    const text = serializeForSummary([
      { role: 'user', content: 'fix the bug' },
      {
        role: 'assistant',
        content: 'looking',
        toolCalls: [{ id: 'c1', name: 'grep', argsJson: '{"pattern":"boom"}' }],
      },
      { role: 'tool', content: 'src/a.ts:3:boom', toolCallId: 'c1' },
    ])
    expect(text).toBe(
      [
        '[User]: fix the bug',
        '[Assistant]: looking',
        '[Assistant tool calls]: grep({"pattern":"boom"})',
        '[Tool result]: src/a.ts:3:boom',
      ].join('\n'),
    )
  })

  it('caps a large tool result and says how much it dropped', () => {
    const text = serializeForSummary([{ role: 'tool', content: filler(3000), toolCallId: 'c' }], 100)
    expect(text).toContain('[2900 chars truncated]')
    expect(text.length).toBeLessThan(300)
  })
})

describe('summaryMessage', () => {
  it('marks the stand-in so it reads as a summary, not as history', () => {
    const message = summaryMessage('## Goal\nship it')
    expect(message.role).toBe('user')
    expect(message.content.startsWith(SUMMARY_PREFIX)).toBe(true)
    expect(message.content).toContain('ship it')
  })
})
