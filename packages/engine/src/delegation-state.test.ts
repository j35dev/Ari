import { expect, it } from 'vitest'
import type { JournalEvent } from '@ari/contracts/events'
import type { MessagePart } from '@ari/contracts/message'
import { initialReadModel, projectEvents, type SessionReadModel } from './projection'
import {
  childWorkState,
  completionNotice,
  finalAssistantText,
  pendingCompletions,
} from './delegation-state'

let seq = 0
const on = (event: Record<string, unknown>): JournalEvent =>
  ({ seq: seq++, at: 1_000 + seq, sessionId: 'parent', ...event }) as JournalEvent
const settled = (childSessionId: string, turnId: string, stopReason = 'completed') =>
  on({ type: 'child.session.settled', childSessionId, turnId, stopReason })
const acknowledged = (childSessionId: string, turnId: string) =>
  on({ type: 'child.session.acknowledged', childSessionId, turnId, via: 'wait' })

function withAssistant(parts: MessagePart[], turnId = 't1'): SessionReadModel {
  return {
    ...initialReadModel(),
    messages: [
      { id: 'm1', sessionId: 'child', turnId, role: 'assistant', parts, createdAt: 1 },
    ],
  }
}

it('lists settled child turns the parent has not seen, oldest first', () => {
  const model = projectEvents([settled('b', 'tb'), settled('a', 'ta'), acknowledged('b', 'tb')])
  expect(pendingCompletions(model)).toMatchObject([{ childSessionId: 'a', turnId: 'ta' }])
})

it('honours an acknowledgment journaled before its settle', () => {
  const model = projectEvents([acknowledged('a', 't1'), settled('a', 't1')])
  expect(pendingCompletions(model)).toEqual([])
})

it('accepts an early acknowledgment for a turn after an already settled one', () => {
  const model = projectEvents([
    settled('a', 't1'),
    acknowledged('a', 't1'),
    acknowledged('a', 't2'),
    settled('a', 't2', 'interrupted'),
  ])
  expect(pendingCompletions(model)).toEqual([])
})

it('ignores a stale acknowledgment once a newer turn has settled', () => {
  const model = projectEvents([settled('a', 't1'), settled('a', 't2'), acknowledged('a', 't1')])
  expect(pendingCompletions(model)).toMatchObject([{ childSessionId: 'a', turnId: 't2' }])
})

it('drops a destroyed child and keeps only the latest turn per child', () => {
  const model = projectEvents([
    settled('a', 't1'),
    settled('a', 't2', 'error'),
    settled('b', 't3'),
    on({ type: 'child.session.destroyed', childSessionId: 'b' }),
  ])
  expect(pendingCompletions(model)).toMatchObject([
    { childSessionId: 'a', turnId: 't2', stopReason: 'error' },
  ])
})

it('reports the text after the last tool call, rejoining streamed deltas', () => {
  const model = withAssistant([
    { type: 'text', text: 'Let me look.' },
    { type: 'tool-call', callId: 'c', name: 'Read', argsJson: '{}' },
    { type: 'tool-result', callId: 'c', resultJson: '{}', isError: false },
    { type: 'text', text: 'Done: fixed the ' },
    { type: 'thinking', text: 'hmm' },
    { type: 'text', text: 'parser.' },
  ])
  expect(finalAssistantText(model, 't1')).toEqual({
    text: 'Done: fixed the parser.',
    truncated: false,
  })
})

it('falls back to the last text run when a turn ends on a tool call', () => {
  const model = withAssistant([
    { type: 'text', text: 'Starting the build.' },
    { type: 'tool-call', callId: 'c', name: 'Bash', argsJson: '{}' },
    { type: 'text', text: '\n' },
    { type: 'tool-call', callId: 'd', name: 'Bash', argsJson: '{}' },
  ])
  expect(finalAssistantText(model, 't1').text).toBe('Starting the build.')
  expect(finalAssistantText(model, 'other').text).toBe('')
})

it('marks an over-long report as truncated', () => {
  const model = withAssistant([{ type: 'text', text: 'x'.repeat(50) }])
  expect(finalAssistantText(model, 't1', 10)).toEqual({ text: 'x'.repeat(10), truncated: true })
})

it('classifies a child by turn, prompts, queue and descendants', () => {
  const idle: SessionReadModel = {
    ...initialReadModel(),
    lastTurn: { turnId: 't1', stopReason: 'completed', settledAt: 1 },
  }
  expect(childWorkState(initialReadModel())).toBe('not_started')
  expect(childWorkState({ ...idle, activeTurnId: 't2' })).toBe('working')
  expect(
    childWorkState({
      ...idle,
      activeTurnId: 't2',
      pendingInputs: [{ inputId: 'i', prompt: '?', choicesJson: null }],
    }),
  ).toBe('blocked_on_user')
  expect(childWorkState(idle)).toBe('result_available')
  expect(childWorkState(idle, 1)).toBe('waiting_for_children')
  expect(childWorkState(idle, 0, true)).toBe('working')
  expect(childWorkState({ ...idle, queuedMessages: [{ text: 'next', attachments: [] }] })).toBe(
    'working',
  )
  expect(
    childWorkState({
      ...idle,
      lastTurn: { turnId: 't1', stopReason: 'interrupted', settledAt: 1 },
      queuedMessages: [{ text: 'held', attachments: [] }],
    }),
  ).toBe('result_available')
})

it('writes one notice covering every report and what is still running', () => {
  const notice = completionNotice(
    [
      {
        sessionId: 'a',
        title: 'Parser',
        stopReason: 'completed',
        errorMessage: null,
        report: { text: 'Fixed it.', truncated: false },
      },
      {
        sessionId: 'b',
        title: 'Docs',
        stopReason: 'error',
        errorMessage: 'rate limited',
        report: { text: 'partial', truncated: true },
      },
      {
        sessionId: 'c',
        title: 'Lint',
        stopReason: 'interrupted',
        errorMessage: null,
        report: { text: '', truncated: false },
      },
    ],
    [{ sessionId: 'd', title: 'Tests' }],
  )
  expect(notice).toContain('not written by the user')
  expect(notice).toContain('Child session "Parser" (a) finished its turn.\nReport:\nFixed it.')
  expect(notice).toContain('Child session "Docs" (b) failed.\nError: rate limited')
  expect(notice).toContain('ari session read b --json')
  expect(notice).toContain('(c) was stopped before finishing.\nIt left no final message.')
  expect(notice).toContain('Still working: "Tests" (d)')
  expect(completionNotice([], [])).toContain('No other children are working.')
})
