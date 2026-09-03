import { describe, expect, it } from 'vitest'
import {
  activityHeadline,
  formatToolSummary,
  groupBlocks,
  MAX_CALLS_PER_GROUP,
  summarizeToolRun,
} from './groupBlocks'
import { splitBlocks } from './splitBlocks'
import type { Message } from '@ari/contracts/message'
import type { TranscriptBlock } from './types'

function userMessage(text: string): Message {
  return {
    id: 'm1',
    sessionId: 's1',
    turnId: null,
    role: 'user',
    parts: [{ type: 'text', text }],
    createdAt: Date.now(),
  }
}

function assistantMessage(parts: Message['parts']): Message {
  return {
    id: 'm2',
    sessionId: 's1',
    turnId: null,
    role: 'assistant',
    parts,
    createdAt: Date.now(),
  }
}

describe('groupBlocks', () => {
  it('wraps a lone in-flight tool call in an activity row so it never changes shape', () => {
    const rows = groupBlocks(
      splitBlocks([
        assistantMessage([{ type: 'tool-call', callId: 'c1', name: 'Bash', argsJson: '{}' }]),
      ]),
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.kind).toBe('tool-group')
  })

  it('collapses a consecutive run into one tool-group with stable span key', () => {
    const rows = groupBlocks(
      splitBlocks([
        assistantMessage([
          { type: 'tool-call', callId: 'c1', name: 'Bash', argsJson: '{}' },
          { type: 'tool-result', callId: 'c1', resultJson: '"ok"', isError: false },
          { type: 'tool-call', callId: 'c2', name: 'Read', argsJson: '{}' },
          { type: 'tool-result', callId: 'c2', resultJson: '"ok"', isError: false },
        ]),
      ]),
    )
    expect(rows).toHaveLength(1)
    const row = rows[0]
    expect(row?.kind).toBe('tool-group')
    if (row?.kind !== 'tool-group') return
    expect(row.key).toBe('m2#0..m2#3')
    expect(row.calls.map((c) => c.callId)).toEqual(['c1', 'c2'])
    expect(row.resultsByCallId.get('c1')?.kind).toBe('tool-result')
  })

  it('chunks a long run into bursts of at most MAX_CALLS_PER_GROUP calls', () => {
    const parts: Message['parts'] = []
    for (let i = 0; i < MAX_CALLS_PER_GROUP + 2; i++) {
      parts.push({ type: 'tool-call', callId: `c${i}`, name: 'Bash', argsJson: '{}' })
      parts.push({ type: 'tool-result', callId: `c${i}`, resultJson: '"ok"', isError: false })
    }
    const rows = groupBlocks(splitBlocks([assistantMessage(parts)]))
    expect(rows).toHaveLength(2)
    const [first, second] = rows
    if (first?.kind !== 'tool-group' || second?.kind !== 'tool-group') {
      throw new Error('expected two tool groups')
    }
    expect(first.calls).toHaveLength(MAX_CALLS_PER_GROUP)
    expect(second.calls).toHaveLength(2)
  })

  it('folds interleaved thinking into the run and breaks only on assistant prose', () => {
    const rows = groupBlocks(
      splitBlocks([
        assistantMessage([
          { type: 'tool-call', callId: 'c1', name: 'Bash', argsJson: '{}' },
          { type: 'tool-result', callId: 'c1', resultJson: '"ok"', isError: false },
          { type: 'text', text: 'Here is the plan.' },
          { type: 'thinking', text: 'hmm' },
          { type: 'tool-call', callId: 'c2', name: 'Edit', argsJson: '{}' },
          { type: 'tool-result', callId: 'c2', resultJson: '"ok"', isError: false },
          { type: 'thinking', text: 'checking' },
          { type: 'tool-call', callId: 'c3', name: 'Bash', argsJson: '{}' },
          { type: 'tool-result', callId: 'c3', resultJson: '"ok"', isError: false },
        ]),
      ]),
    )
    expect(rows.map((r) => r.kind)).toEqual(['tool-group', 'markdown', 'tool-group'])
    const second = rows[2]
    if (second?.kind !== 'tool-group') throw new Error('expected a tool group')
    expect(second.blocks.map((b) => b.kind)).toEqual([
      'thinking',
      'tool-call',
      'tool-result',
      'thinking',
      'tool-call',
      'tool-result',
    ])
    expect(second.calls).toHaveLength(2)
  })

  it('leaves a thinking block with no tool traffic as its own row', () => {
    const rows = groupBlocks(
      splitBlocks([
        assistantMessage([
          { type: 'thinking', text: 'hmm' },
          { type: 'text', text: 'done' },
        ]),
      ]),
    )
    expect(rows.map((r) => r.kind)).toEqual(['thinking', 'markdown'])
  })

  it('carries the owning message role on blocks', () => {
    const rows = groupBlocks(splitBlocks([userMessage('hello'), assistantMessage([{ type: 'text', text: 'hi' }])]))
    const roles = rows.map((r) => (r.kind === 'markdown' ? r.role : undefined))
    expect(roles).toEqual(['user', 'assistant'])
  })

  it('stamps every block with its message turn id', () => {
    const turnMessage: Message = { ...assistantMessage([{ type: 'text', text: 'hi' }]), turnId: 'turn_1' }
    const rows = groupBlocks(splitBlocks([turnMessage]))
    expect(rows.every((r) => r.kind !== 'tool-group' && r.turnId === 'turn_1')).toBe(true)
  })
})

describe('turn diff cards', () => {
  const DIFF = 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n'

  it('appends one card after the last row of the matching turn', () => {
    const withTurn: Message = { ...assistantMessage([{ type: 'text', text: 'done' }]), id: 'm2', turnId: 'turn_9' }
    const rows = groupBlocks(
      splitBlocks([
        userMessage('hello'),
        assistantMessage([{ type: 'text', text: 'thinking…' }]),
        withTurn,
      ]),
      { turn_9: DIFF },
    )
    expect(rows.at(-1)?.kind).toBe('turn-diff')
    const card = rows.at(-1)
    if (card?.kind !== 'turn-diff') return
    expect(card.turnId).toBe('turn_9')
    expect(card.key).toBe('turn-diff:turn_9')
    expect(card.diffText).toBe(DIFF)
  })

  it('places the card after collapsed tool runs, before the next user turn', () => {
    const toolTurn: Message = {
      ...assistantMessage([
        { type: 'tool-call', callId: 'c1', name: 'Edit', argsJson: '{}' },
        { type: 'tool-result', callId: 'c1', resultJson: '"ok"', isError: false },
      ]),
      id: 'm2',
      turnId: 'turn_3',
    }
    const nextTurnUser: Message = { ...userMessage('more'), id: 'm3', turnId: null }
    const rows = groupBlocks(splitBlocks([toolTurn, nextTurnUser]), { turn_3: DIFF })
    expect(rows.map((r) => r.kind)).toEqual(['tool-group', 'turn-diff', 'markdown'])
  })

  it('leaves turns without an entry untouched and skips empty diffs', () => {
    const base = splitBlocks([userMessage('hello'), assistantMessage([{ type: 'text', text: 'hi' }])])
    expect(groupBlocks(base)).toHaveLength(2)
    expect(groupBlocks(base, {})).toHaveLength(2)
    expect(groupBlocks(base, { turn_missing: DIFF })).toHaveLength(2)
    expect(groupBlocks(base, { turn_1: '' })).toHaveLength(2)
  })

  it('emits at most one card per turn even across disjoint segments', () => {
    const segA: Message = { ...assistantMessage([{ type: 'text', text: 'a' }]), id: 'm2', turnId: 'turn_5' }
    const gap: Message = { ...userMessage('go on'), id: 'm3', turnId: null }
    const segB: Message = { ...assistantMessage([{ type: 'text', text: 'b' }]), id: 'm4', turnId: 'turn_5' }
    const rows = groupBlocks(splitBlocks([segA, gap, segB]), { turn_5: DIFF })
    expect(rows.filter((r) => r.kind === 'turn-diff')).toHaveLength(1)
  })
})

describe('summarizeToolRun + formatToolSummary', () => {
  function callsOf(names: string[], answered: number, errors = 0) {
    const calls: TranscriptBlock[] = names.map((name, i) => ({
      key: `k${i}`,
      kind: 'tool-call',
      callId: `c${i}`,
      name,
      argsJson: '{}',
    }))
    const resultsByCallId = new Map<string, TranscriptBlock>()
    for (let i = 0; i < answered; i++) {
      resultsByCallId.set(`c${i}`, {
        key: `r${i}`,
        kind: 'tool-result',
        callId: `c${i}`,
        isError: i < errors,
      })
    }
    return { calls, resultsByCallId }
  }

  it('buckets tools into ran/edited/read/searched verbs', () => {
    const { calls, resultsByCallId } = callsOf(
      ['Bash', 'PowerShell', 'Edit', 'Write', 'Read', 'Grep', 'WebSearch'],
      7,
    )
    const summary = summarizeToolRun(calls, resultsByCallId)
    expect(summary.ran).toBe(2)
    expect(summary.edited).toBe(2)
    expect(summary.read).toBe(1)
    expect(summary.searched).toBe(2)
    expect(formatToolSummary(summary)).toBe('Ran 2 commands · Edited 2 files · Read 1 file · Searched 2 times')
  })

  it('counts errors and pending calls', () => {
    const { calls, resultsByCallId } = callsOf(['Bash', 'Bash', 'Bash'], 2, 1)
    const summary = summarizeToolRun(calls, resultsByCallId)
    expect(summary.errors).toBe(1)
    expect(summary.pending).toBe(1)
  })

  it('counts plan calls and formats the tally', () => {
    const calls: TranscriptBlock[] = [
      { key: 'k0', kind: 'tool-call', callId: 'c0', name: 'todo_write', argsJson: '{"items":[]}' },
    ]
    expect(formatToolSummary(summarizeToolRun(calls, new Map()))).toBe('Updated 1 todo')
  })

  it('dedupes edits to the same file', () => {
    const a = (id: string, argsJson: string): TranscriptBlock => ({
      key: `k-${id}`,
      kind: 'tool-call',
      callId: id,
      name: 'Edit',
      argsJson,
    })
    const same = 'src/a.ts'
    const calls = [
      a('c1', JSON.stringify({ file_path: same, old_string: 'x', new_string: 'y' })),
      a('c2', JSON.stringify({ file_path: 'SRC/A.TS', old_string: 'y', new_string: 'z' })),
      a('c3', '{}'),
    ]
    expect(summarizeToolRun(calls, new Map()).edited).toBe(2)
  })

  it('formats singular and empty cases', () => {
    const { calls, resultsByCallId } = callsOf(['Edit'], 1)
    expect(formatToolSummary(summarizeToolRun(calls, resultsByCallId))).toBe('Edited 1 file')
    expect(formatToolSummary(summarizeToolRun([], new Map()))).toBe('')
  })
})

describe('activityHeadline', () => {
  function call(callId: string, name: string, argsJson: string): TranscriptBlock {
    return { key: `k-${callId}`, kind: 'tool-call', callId, name, argsJson }
  }
  function result(callId: string, isError = false): TranscriptBlock {
    return { key: `r-${callId}`, kind: 'tool-result', callId, resultJson: '"ok"', isError }
  }
  function group(blocks: TranscriptBlock[]) {
    const calls = blocks.filter((b) => b.kind === 'tool-call')
    const resultsByCallId = new Map<string, TranscriptBlock>()
    for (const block of blocks) {
      if (block.kind === 'tool-result' && block.callId) resultsByCallId.set(block.callId, block)
    }
    return { blocks, calls, resultsByCallId }
  }

  it('names the in-flight call in the present tense', () => {
    const headline = activityHeadline(
      group([
        call('c1', 'Bash', '{"command":"pnpm verify"}'),
        result('c1'),
        call('c2', 'Read', '{"file_path":"D:/Projects/Ari/packages/ui/src/tokens.css"}'),
      ]),
    )
    expect(headline).toBe('Reading src/tokens.css')
  })

  it('names a targetless in-flight call by its tool, never verb + name', () => {
    expect(activityHeadline(group([call('c1', 'Edit', '{}')]))).toBe('Edit')
    expect(
      activityHeadline(
        group([call('c1', 'tool', '{"title":"run_terminal_command","input":{}}')]),
      ),
    ).toBe('run terminal command')
  })

  it('falls back to the settled tally once every call has answered', () => {
    const headline = activityHeadline(
      group([
        call('c1', 'Bash', '{"command":"git status"}'),
        result('c1'),
        call('c2', 'Read', '{"file_path":"a/b.ts"}'),
        result('c2'),
      ]),
    )
    expect(headline).toBe('Ran 1 command · Read 1 file')
  })

  it('reads as Thinking while reasoning trails a finished run', () => {
    const blocks = [
      call('c1', 'Bash', '{"command":"git status"}'),
      result('c1'),
      { key: 'k-t', kind: 'thinking', text: 'weighing options' } satisfies TranscriptBlock,
    ]
    expect(activityHeadline(group(blocks))).toBe('Thinking')
  })

  it('degrades to a call count when no verb bucket matched', () => {
    expect(activityHeadline({ blocks: [], calls: [], resultsByCallId: new Map() })).toBe(
      '0 tool calls',
    )
  })
})
