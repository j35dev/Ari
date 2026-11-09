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
  it('carries conversation and work reports in order, excluding unrelated tool traffic and reasoning', () => {
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
    expect(handoff).toContain(
      'User: Please fix it.\n\nWork reports (child): automatic wake\n\nAria: The fix is ready.',
    )
    for (const hidden of ['tool chatter', 'tool output', 'private reasoning', 'system text'])
      expect(handoff).not.toContain(hidden)
  })

  it('keeps session messages and compact assignments with the returned session title and id', () => {
    const assignment = message('assistant', 'I assigned this.')
    assignment.parts.push(
      {
        type: 'tool-call',
        callId: 'spawn',
        name: 'Bash',
        argsJson: JSON.stringify({
          command: 'ari session spawn --title "Fix parser" --prompt "Fix the parser"',
        }),
      },
      {
        type: 'tool-result',
        callId: 'spawn',
        resultJson: JSON.stringify({
          child: { id: 'sess_parser', title: 'Fix parser' },
          output: 'unrelated tool output',
        }),
        isError: false,
      },
      {
        type: 'tool-call',
        callId: 'prompt',
        name: 'Bash',
        argsJson: JSON.stringify({ command: 'ari session prompt sess_parser "Add checks"' }),
      },
    )
    const report = {
      ...message('user', 'Parser checks passed.'),
      origin: { kind: 'session' as const, sessionId: 'sess_parser' },
    }
    const handoff = conversationHandoff([assignment, report])!
    expect(handoff).toContain('Work: ari session spawn --title "Fix parser"')
    expect(handoff).toContain('sessionId=sess_parser')
    expect(handoff).toContain('title=Fix parser')
    expect(handoff).toContain('Work: ari session prompt sess_parser "Add checks"')
    expect(handoff).toContain('Session sess_parser: Parser checks passed.')
    expect(handoff).not.toContain('unrelated tool output')
  })

  it('reads work-routing clues from ACP input and text content envelopes', () => {
    const assignment = message('assistant', '')
    assignment.parts = [
      {
        type: 'tool-call',
        callId: 'acp',
        name: 'execute',
        argsJson: JSON.stringify({
          title: 'Ask the project lead',
          input: { command: 'ari project ask proj_web "Fix it"' },
        }),
      },
      {
        type: 'tool-result',
        callId: 'acp',
        resultJson: JSON.stringify([
          {
            type: 'text',
            text: JSON.stringify({ sessionId: 'sess_lead', lead: { title: 'Web lead' } }),
          },
        ]),
        isError: false,
      },
    ]
    const handoff = conversationHandoff([assignment])!
    expect(handoff).toContain('Work: ari project ask proj_web "Fix it"')
    expect(handoff).toContain('sessionId=sess_lead')
    expect(handoff).toContain('title=Web lead')
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
