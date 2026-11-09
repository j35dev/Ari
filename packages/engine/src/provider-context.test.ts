import { describe, expect, it } from 'vitest'
import type { Message } from '@ari/contracts/message'
import { conversationHandoff, providerTurnContext } from './provider-context'
import { initialReadModel } from './projection'

function message(role: Message['role'], text: string): Message {
  return {
    id: text,
    sessionId: 'aria',
    turnId: null,
    role,
    parts: [{ type: 'text', text }],
    createdAt: 0,
  }
}

describe('provider handoff', () => {
  it('carries user and Aria text in order, excluding tool traffic, reasoning and automatic wakes', () => {
    const assistant = message('assistant', 'The fix is ready.')
    assistant.parts.push(
      { type: 'thinking', text: 'private reasoning' },
      { type: 'tool-call', callId: 'tool', name: 'Bash', argsJson: 'tool chatter' },
      { type: 'tool-result', callId: 'tool', resultJson: 'tool output', isError: false },
    )
    const wake = {
      ...message('user', 'automatic wake'),
      origin: { kind: 'completion' as const, sessionIds: ['child'] },
    }
    const handoff = conversationHandoff([
      message('system', 'system text'),
      message('user', 'Please fix it.'),
      wake,
      assistant,
    ])
    expect(handoff).toContain('Conversation so far')
    expect(handoff).toContain('User: Please fix it.\n\nAria: The fix is ready.')
    for (const hidden of [
      'tool chatter',
      'tool output',
      'private reasoning',
      'automatic wake',
      'system text',
    ])
      expect(handoff).not.toContain(hidden)
  })

  it('keeps the newest text within the full character budget', () => {
    const handoff = conversationHandoff(
      [message('user', 'old request'), message('assistant', 'x'.repeat(20_000) + 'newest ending')],
      12_000,
    )!
    expect(handoff.length).toBe(12_000)
    expect(handoff).toContain('Aria: ')
    expect(handoff).toMatch(/newest ending$/)
    expect(handoff).not.toContain('old request')
    expect(conversationHandoff([message('user', 'text')], 10)).toBeNull()
    expect(conversationHandoff([])).toBeNull()
  })

  it('freezes a pending handoff separately from the visible messages', () => {
    const model = {
      ...initialReadModel(),
      messages: [message('user', 'earlier')],
      providerContextSeq: 7,
      providerHandoffPending: true,
    }
    const before = JSON.stringify(model.messages)
    const context = providerTurnContext(model)
    expect(context.resumeOf).toBeNull()
    expect(context.contextSeq).toBe(7)
    expect(context.handoff).toContain('User: earlier')
    expect(JSON.stringify(model.messages)).toBe(before)
    expect(
      providerTurnContext({
        ...model,
        providerHandoffPending: false,
        providerSessionId: 'new-thread',
      }),
    ).toEqual({ resumeOf: 'new-thread', contextSeq: 7, handoff: null, handoffPending: false })
  })
})
