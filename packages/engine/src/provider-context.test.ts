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
    expect(handoff).toContain('User: old request')
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
    expect(providerTurnContext({ ...model, providerSessionId: 'empty-thread' }).resumeOf).toBeNull()
    expect(JSON.stringify(model.messages)).toBe(before)
    expect(
      providerTurnContext({
        ...model,
        providerHandoffPending: false,
        providerSessionId: 'new-thread',
      }),
    ).toEqual({ resumeOf: 'new-thread', contextSeq: 7, handoff: null, handoffPending: false })
  })

  it.each(
    [
      { command: ['bash', '-lc', 'ari project ask proj_web "Fix it"'] },
      ['bash', '-lc', 'ari project ask proj_web "Fix it"'],
      { title: 'ari project ask proj_web "Fix it"' },
      { command: '$ARI_CLI project ask proj_web "Fix it"' },
      { command: '"$ARI_CLI" project ask proj_web "Fix it"' },
      { command: '"ari.cmd" project ask proj_web "Fix it"' },
      { command: 'bash -lc \'ari project ask proj_web "Fix it"\'' },
      { command: '& $env:ARI_CLI project ask proj_web "Fix it"' },
      { command: '"C:\\npm\\ari.cmd" project ask proj_web "Fix it"' },
      { command: 'C:\\NPM\\ARI.CMD project ask proj_web "Fix it"' },
      { command: '.\\bin\\ARI.EXE project ask proj_web "Fix it"' },
      { command: '/usr/local/bin/ari project ask proj_web "Fix it"' },
      { command: 'zsh -lc \'echo ready; ari project ask proj_web "Fix it"\'' },
      { command: ['sh', '-lc', 'bash -lc \'ari project ask proj_web "Fix it"\''] },
      { command: 'powershell -Command \'& $env:ARI_CLI project ask proj_web "Fix it"\'' },
      { command: ['pwsh', '-Command', 'ari project ask proj_web "Fix it"'] },
      { command: 'cmd /c \'echo ready && ari project ask proj_web "Fix it"\'' },
      { command: 'cmd /c "C:\\Program Files\\npm\\ari.cmd" project ask proj_web "Fix it"' },
      {
        command: [
          'pwsh',
          '-Command',
          '&',
          'C:\\Program Files\\npm\\ARI.EXE',
          'project',
          'ask',
          'proj_web',
          'Fix it',
        ],
      },
      { command: 'echo ready && ari project ask proj_web "Fix it"' },
      { command: 'echo ready; ari project ask proj_web "Fix it"; echo done' },
      { command: 'echo ready | ari project ask proj_web "Fix it"' },
      { command: 'ari --json project ask proj_web "Fix it"' },
      { command: 'ari --project proj_web project --json ask proj_web "Fix it"' },
      { title: '`ari project ask proj_web "Fix it"`' },
      { command: 'echo examples', title: 'Run `ari project ask proj_web "Fix it"`' },
      { command: 'echo examples', input: 'ari project ask proj_web "Fix it"' },
      { command: 'echo examples', name: 'ari project ask proj_web "Fix it"' },
      { input: { command: 'echo examples', title: 'ari project ask proj_web "Fix it"' } },
    ].map((args) => ({ args })),
  )('recognises work launched through wrapped command $args', ({ args }) => {
    const assignment = message('assistant', '')
    assignment.parts = [
      { type: 'tool-call', callId: 'work', name: 'execute', argsJson: JSON.stringify(args) },
    ]
    const handoff = conversationHandoff([assignment])
    expect(handoff).toContain('Work: ')
    expect(handoff).toContain('ask proj_web')
    expect(handoff).toContain('Fix it')
  })

  it.each([
    { command: 'echo "ari project ask proj_web Fix it"' },
    { command: ['bash', '-lc', 'echo "ari project ask proj_web Fix it"'] },
    { command: 'cat script-containing-ari-project-ask' },
    { command: 'ARI project ask proj_web "Fix it"' },
    { command: 'ari Project ask proj_web "Fix it"' },
    { command: 'not-ari project ask proj_web "Fix it"' },
    { command: 'echo ready; echo "ari project ask proj_web Fix it"' },
  ])('excludes command mentions that do not invoke work: $command', (args) => {
    const assignment = message('assistant', '')
    assignment.parts = [
      {
        type: 'tool-call',
        callId: 'work',
        name: 'orchestration.launch',
        argsJson: JSON.stringify(args),
      },
    ]
    expect(conversationHandoff([assignment])).toBeNull()
  })

  it('checks the tool name even when arguments do not contain a work command', () => {
    const assignment = message('assistant', '')
    assignment.parts = [
      {
        type: 'tool-call',
        callId: 'work',
        name: '`ari session --json prompt sess_worker "Continue"`',
        argsJson: 'unavailable',
      },
    ]
    expect(conversationHandoff([assignment])).toContain(
      'Work: ari session --json prompt sess_worker',
    )
  })

  it('reserves Aria’s real reply rather than a later provider-only error notice', () => {
    const reports = Array.from({ length: 6 }, (_, id) => ({
      ...message('user', 'report detail '.repeat(3_000)),
      origin: { kind: 'completion' as const, sessionIds: [`worker-${id}`] },
    }))
    const notice = message('assistant', `\n\n⚠ ${'Provider unavailable '.repeat(1_000)}`)
    notice.parts.push({ type: 'tool-call', callId: 'failed', name: 'Bash', argsJson: '{}' })
    const handoff = conversationHandoff([
      message('user', 'Keep the current API.'),
      message('assistant', 'I will keep the current API and add the missing checks.'),
      ...reports,
      notice,
    ])!
    expect(handoff).toContain('Aria: I will keep the current API and add the missing checks.')
    expect(handoff).toContain('Provider notice: ')
    expect(handoff.length).toBeLessThanOrEqual(12_000)
  })

  it('reserves recent conversation when long reports arrive after it', () => {
    const reports = [1, 2, 3, 4].map((id) => ({
      ...message('user', `${'report chatter '.repeat(3_000)}Report ${id} result`),
      origin: { kind: 'completion' as const, sessionIds: [`worker-${id}`] },
    }))
    const handoff = conversationHandoff([
      message('user', 'Please fix the parser.'),
      message('assistant', 'I am keeping the existing API.'),
      ...reports,
    ])!
    expect(handoff.length).toBeLessThanOrEqual(12_000)
    expect(handoff).toContain('User: Please fix the parser.')
    expect(handoff).toContain('Aria: I am keeping the existing API.')
    expect(handoff).toContain('Report 4 result')
    for (const report of handoff.split('\n\n').filter((entry) => entry.startsWith('Work reports')))
      expect(report.length).toBeLessThanOrEqual(2_400)
    expect(handoff.indexOf('Please fix')).toBeLessThan(handoff.indexOf('Report 4 result'))
  })
})
