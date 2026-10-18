import { describe, expect, it } from 'vitest'
import type { Message } from '@ari/contracts/message'
import { groupBlocks } from './groupBlocks'
import { splitBlocks } from './splitBlocks'
import { insertDelegationRows, summarizeDelegation } from './delegation-rows'
import type { DelegatedChild } from './types'

const messages: Message[] = [
  {
    id: 'u1',
    sessionId: 's',
    turnId: 't1',
    role: 'user',
    parts: [{ type: 'text', text: 'Split this up' }],
    createdAt: 1,
  },
  {
    id: 'a1',
    sessionId: 's',
    turnId: 't1',
    role: 'assistant',
    parts: [
      { type: 'text', text: 'Delegating.' },
      { type: 'tool-call', callId: 'c1', name: 'Bash', argsJson: '{}' },
      { type: 'tool-result', callId: 'c1', resultJson: '{}', isError: false },
      { type: 'tool-call', callId: 'c2', name: 'Bash', argsJson: '{}' },
      { type: 'text', text: 'Both are running.' },
    ],
    createdAt: 2,
  },
]
const rows = groupBlocks(splitBlocks(messages))

const child = (
  sessionId: string,
  anchor: DelegatedChild['anchor'],
  state: DelegatedChild['state'] = 'working',
): DelegatedChild => ({
  sessionId,
  title: sessionId,
  role: null,
  driverKind: 'claude',
  modelId: null,
  state,
  startedAt: null,
  report: null,
  anchor,
})

describe('insertDelegationRows', () => {
  it('returns the same rows when nothing was delegated', () => {
    expect(insertDelegationRows(rows, [])).toBe(rows)
  })

  it('groups children spawned from one burst right after that burst', () => {
    const placed = insertDelegationRows(rows, [
      child('one', { messageId: 'a1', partIndex: 1 }),
      child('two', { messageId: 'a1', partIndex: 3 }),
    ])
    expect(placed.map((row) => row.kind)).toEqual([
      'markdown',
      'markdown',
      'tool-group',
      'delegation',
      'markdown',
    ])
    const group = placed[3]
    expect(group?.kind === 'delegation' && group.children.map((c) => c.sessionId)).toEqual([
      'one',
      'two',
    ])
    expect(group?.key).toBe('delegation:one')
  })

  it('keeps a child whose anchor is gone, at the end', () => {
    const placed = insertDelegationRows(rows, [child('lost', { messageId: 'gone', partIndex: 0 })])
    expect(placed.at(-1)?.kind).toBe('delegation')
    expect(placed).toHaveLength(rows.length + 1)
    expect(insertDelegationRows([], [child('only', { messageId: null, partIndex: 0 })])).toHaveLength(1)
  })
})

it('summarizes a group most urgent first', () => {
  const at = { messageId: 'a1', partIndex: 1 }
  expect(
    summarizeDelegation([
      child('a', at, 'done'),
      child('b', at, 'working'),
      child('c', at, 'working'),
      child('d', at, 'needs-you'),
    ]),
  ).toBe('1 needs you · 2 working · 1 done')
})
