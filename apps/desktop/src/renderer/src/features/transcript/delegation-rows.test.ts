import { describe, expect, it } from 'vitest'
import type { Message } from '@ari/contracts/message'
import { groupBlocks } from './groupBlocks'
import { splitBlocks } from './splitBlocks'
import { splitDelegation, insertDelegationRows, summarizeDelegation } from './delegation-rows'
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
    expect(
      insertDelegationRows([], [child('only', { messageId: null, partIndex: 0 })]),
    ).toHaveLength(1)
  })
})

describe('splitDelegation', () => {
  const at = { messageId: 'a1', partIndex: 1 }
  const HOUR = 60 * 60 * 1000
  const NOW = 100 * HOUR
  const settled = (id: string, settledAt: number, state: DelegatedChild['state'] = 'done') => ({
    ...child(id, at, state),
    settledAt,
  })
  const ids = (list: DelegatedChild[]) => list.map((entry) => entry.sessionId)

  it('keeps running agents and recent results, and sets old and removed ones aside', () => {
    const { current, earlier } = splitDelegation(
      [
        settled('lead', NOW - 72 * HOUR, 'stopped'),
        child('gone-1', at, 'removed'),
        child('gone-2', at, 'removed'),
        settled('garden', NOW - HOUR / 4),
        child('arcade', at, 'working'),
      ],
      NOW,
    )
    expect(ids(current)).toEqual(['garden', 'arcade'])
    expect(ids(earlier)).toEqual(['lead', 'gone-1', 'gone-2'])
  })

  it('measures recency against the group, so an old turn still shows its own agents', () => {
    const { current, earlier } = splitDelegation(
      [settled('a', NOW - 72 * HOUR), settled('b', NOW - 71 * HOUR, 'failed')],
      NOW,
    )
    expect(ids(current)).toEqual(['a', 'b'])
    expect(earlier).toEqual([])
  })

  it('treats anything still waiting on someone as current, however long ago it started', () => {
    const waiting = { ...child('asks', at, 'needs-you'), spawnedAt: NOW - 72 * HOUR }
    expect(ids(splitDelegation([waiting, child('new', at, 'working')], NOW).current)).toEqual([
      'asks',
      'new',
    ])
  })

  it('keeps a finished agent whose times are unknown in view', () => {
    const { current } = splitDelegation([child('idle', at, 'idle'), child('w', at)], NOW)
    expect(ids(current)).toEqual(['idle', 'w'])
  })

  it('falls back to the spawn time when an agent never settled a turn', () => {
    const stale = { ...child('stale', at, 'idle'), spawnedAt: NOW - 30 * HOUR }
    const { earlier } = splitDelegation([stale, child('w', at)], NOW)
    expect(ids(earlier)).toEqual(['stale'])
  })

  it('shows the whole group when nothing in it is current', () => {
    const gone = [child('x', at, 'removed'), child('y', at, 'removed')]
    expect(splitDelegation(gone, NOW)).toEqual({ current: gone, earlier: [] })
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
  ).toBe('1 needs you · 2 working · 1 result ready')
})
