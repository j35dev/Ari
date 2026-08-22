import { describe, expect, it } from 'vitest'
import { formatToolSummary, groupBlocks, summarizeToolRun } from './groupBlocks'
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
  it('keeps lone tool blocks as plain rows', () => {
    const rows = groupBlocks(
      splitBlocks([
        assistantMessage([{ type: 'tool-call', callId: 'c1', name: 'Bash', argsJson: '{}' }]),
      ]),
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.kind).toBe('tool-call')
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

  it('splits runs around markdown and thinking rows', () => {
    const rows = groupBlocks(
      splitBlocks([
        assistantMessage([
          { type: 'tool-call', callId: 'c1', name: 'Bash', argsJson: '{}' },
          { type: 'tool-result', callId: 'c1', resultJson: '"ok"', isError: false },
          { type: 'text', text: 'Now thinking…' },
          { type: 'thinking', text: 'hmm' },
          { type: 'tool-call', callId: 'c2', name: 'Edit', argsJson: '{}' },
          { type: 'tool-result', callId: 'c2', resultJson: '"ok"', isError: false },
        ]),
      ]),
    )
    expect(rows.map((r) => r.kind)).toEqual(['tool-group', 'markdown', 'thinking', 'tool-group'])
  })

  it('carries the owning message role on blocks', () => {
    const rows = groupBlocks(splitBlocks([userMessage('hello'), assistantMessage([{ type: 'text', text: 'hi' }])]))
    const roles = rows.map((r) => (r.kind === 'markdown' ? r.role : undefined))
    expect(roles).toEqual(['user', 'assistant'])
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
    expect(formatToolSummary(summary)).toBe('Ran 2 commands · Edited 2 files · Read 1 file · Searched ×2')
  })

  it('counts errors and pending calls', () => {
    const { calls, resultsByCallId } = callsOf(['Bash', 'Bash', 'Bash'], 2, 1)
    const summary = summarizeToolRun(calls, resultsByCallId)
    expect(summary.errors).toBe(1)
    expect(summary.pending).toBe(1)
  })

  it('formats singular and empty cases', () => {
    const { calls, resultsByCallId } = callsOf(['Edit'], 1)
    expect(formatToolSummary(summarizeToolRun(calls, resultsByCallId))).toBe('Edited 1 file')
    expect(formatToolSummary(summarizeToolRun([], new Map()))).toBe('')
  })
})
