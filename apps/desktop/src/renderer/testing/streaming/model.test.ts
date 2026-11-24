// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { project, readableOutput, tally, type ReplayEvent } from './model'

const events: ReplayEvent[] = [
  { seq: 0, turnId: 'a', type: 'narration', itemId: 'intro', text: 'Read ', mode: 'append' },
  { seq: 1, turnId: 'a', type: 'narration', itemId: 'intro', text: 'the files.', mode: 'append' },
  {
    seq: 2,
    turnId: 'a',
    type: 'tool',
    callId: 'x',
    name: 'read',
    category: 'read',
    args: '{}',
    status: 'running',
  },
  {
    seq: 3,
    turnId: 'a',
    type: 'tool',
    callId: 'y',
    name: 'search',
    category: 'search',
    status: 'running',
  },
  {
    seq: 4,
    turnId: 'a',
    type: 'narration',
    itemId: 'finding',
    text: 'Two calls are running.',
    mode: 'append',
  },
  {
    seq: 5,
    turnId: 'a',
    type: 'tool',
    callId: 'x',
    args: '{"path":"App.tsx"}',
    output: 'one',
    outputMode: 'append',
  },
  { seq: 6, turnId: 'a', type: 'tool', callId: 'x', output: ' two', outputMode: 'append' },
  { seq: 7, turnId: 'a', type: 'tool', callId: 'x', status: 'completed' },
  { seq: 8, turnId: 'a', type: 'tool', callId: 'y', status: 'failed', output: 'FAIL', version: 2 },
  { seq: 9, turnId: 'a', type: 'tool', callId: 'y', output: 'stale', version: 1 },
]
describe('isolated streaming presentation projection', () => {
  it('late updates from an older turn do not split the current activity group', () => {
    const result = project([
      { seq: 0, turnId: 'old', type: 'tool', callId: 'a', name: 'read' },
      { seq: 1, turnId: 'new', type: 'tool', callId: 'b', name: 'read' },
      { seq: 2, turnId: 'old', type: 'tool', callId: 'a', status: 'completed' },
      { seq: 3, turnId: 'new', type: 'tool', callId: 'c', name: 'search' },
    ])
    expect(result.rows.filter((row) => row.kind === 'activity')).toHaveLength(2)
    expect(result.rows[1]?.kind === 'activity' && result.rows[1].toolKeys).toEqual([
      'new:b',
      'new:c',
    ])
  })
  it('coalesces narration by source item without moving it across tools', () => {
    const result = project(events)
    expect(result.rows.map((row) => row.kind)).toEqual(['narration', 'activity', 'narration'])
    expect(result.rows[0]).toMatchObject({ text: 'Read the files.' })
  })
  it('keeps group and call anchors through refinements and late completions', () => {
    expect(project(events.slice(0, 4)).rows[1]?.key).toBe(project(events).rows[1]?.key)
    expect(project(events).tools.get('a:x')).toMatchObject({
      firstSeq: 2,
      args: '{"path":"App.tsx"}',
      status: 'completed',
      output: 'one two',
    })
  })
  it('makes reconnect delivery and shuffled chunks equivalent to ordered replay', () => {
    const replay = project(events.concat(events).reverse())
    expect(replay).toEqual(project(events))
    expect(replay.uniqueEvents).toBe(10)
  })
  it('rejects stale output snapshots and keeps failure terminal', () => {
    expect(project(events).tools.get('a:y')).toMatchObject({
      output: 'FAIL',
      status: 'failed',
      version: 2,
    })
  })
  it('retains concurrent running tools when narration arrives', () => {
    expect(
      [...project(events.slice(0, 5)).tools.values()].filter((tool) => tool.status === 'running'),
    ).toHaveLength(2)
  })
  it('starts a new group at narration and a new turn, scopes reused call IDs', () => {
    const result = project(
      events.concat([
        { seq: 10, turnId: 'a', type: 'tool', callId: 'z', name: 'shell', category: 'command' },
        { seq: 11, turnId: 'b', type: 'tool', callId: 'x', name: 'read', category: 'read' },
      ]),
    )
    expect(result.rows.filter((row) => row.kind === 'activity')).toHaveLength(3)
    expect(result.tools.size).toBe(4)
  })
  it('does not infer completion from disconnect or replay', () => {
    const result = project(
      events.slice(0, 4).concat({ seq: 4, turnId: 'a', type: 'connection', connected: false }),
    )
    expect(result.connected).toBe(false)
    expect([...result.tools.values()].every((tool) => tool.status === 'running')).toBe(true)
  })
  it('distinguishes explicit cancellation from unconfirmed result at normal end', () => {
    const pending = events.slice(0, 4)
    expect(
      project(
        pending.concat({ seq: 4, turnId: 'a', type: 'settled', reason: 'cancelled' }),
      ).tools.get('a:x')?.status,
    ).toBe('cancelled')
    expect(
      project(
        pending.concat({ seq: 4, turnId: 'a', type: 'settled', reason: 'completed' }),
      ).tools.get('a:x')?.status,
    ).toBe('unconfirmed')
  })
  it('surfaces an orphan completion without fabricating a start', () => {
    const result = project([
      { seq: 0, turnId: 'a', type: 'tool', callId: 'orphan', status: 'failed', output: 'error' },
    ])
    expect(result.tools.get('a:orphan')).toMatchObject({
      observedStart: false,
      category: 'other',
      status: 'failed',
    })
  })
  it('counts only declared semantics and counts calls rather than unique paths', () => {
    expect(tally([...project(events).tools.values()])).toBe('1 file read · 1 search')
    expect(
      tally([
        ...project([
          {
            seq: 0,
            turnId: 'a',
            type: 'tool',
            callId: 'rg',
            name: 'exec_command',
            category: 'command',
            args: '{"cmd":"rg file"}',
          },
        ]).tools.values(),
      ]),
    ).toBe('1 command')
  })
  it('keeps decisions as grouping boundaries and resolves by scoped ID', () => {
    const result = project(
      events.slice(0, 4).concat([
        {
          seq: 4,
          turnId: 'a',
          type: 'decision',
          id: 'p',
          kind: 'approval',
          text: 'Allow?',
          options: ['Allow once', 'Deny'],
        },
        { seq: 5, turnId: 'a', type: 'resolved', id: 'p', answer: 'Deny' },
        { seq: 6, turnId: 'a', type: 'tool', callId: 'z', name: 'read' },
      ]),
    )
    expect(result.rows.map((row) => row.kind)).toEqual([
      'narration',
      'activity',
      'decision',
      'activity',
    ])
    expect(result.rows[2]).toMatchObject({ answer: 'Deny' })
  })
  it('replaces narration snapshots without append duplication', () => {
    expect(
      project(
        events.slice(0, 2).concat({
          seq: 2,
          turnId: 'a',
          type: 'narration',
          itemId: 'intro',
          mode: 'replace',
          text: 'Read the files. Done.',
        }),
      ).rows[0],
    ).toMatchObject({ text: 'Read the files. Done.' })
  })
  it('derives terminal text while preserving source bytes', () => {
    const raw = '\x1b[35mRUN\x1b[0m\n1/3\r2/3\r3/3\n'
    expect(readableOutput(raw)).toBe('RUN\n3/3\n')
    expect(raw).toContain('\x1b[35m')
  })
})
