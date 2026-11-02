import { describe, expect, it } from 'vitest'
import type { ParsedLine } from '@ari/shared/jsonl'
import { diagnosticsOf, replayEntries } from './journal-replay'

const base = { at: 1, sessionId: 'sess_1' }

function value(line: number, event: unknown): ParsedLine<unknown> {
  return { kind: 'value', line, value: event, raw: JSON.stringify(event) }
}

describe('replayEntries', () => {
  it('folds a valid journal into a read model', () => {
    const outcome = replayEntries([
      value(1, { ...base, seq: 0, type: 'session.created', session: {
        id: 'sess_1', projectId: 'proj_adhoc', title: '', createdAt: 1, updatedAt: 1,
        status: 'idle', driverKind: 'claude', modelId: null, permissionMode: 'ask', archived: false, pinned: false,
      } }),
      value(2, { ...base, seq: 1, type: 'turn.started', turnId: 'turn_1' }),
    ])
    expect(outcome.rejected).toEqual([])
    expect(outcome.model.status).toBe('idle')
  })

  it('replays a journal written before background tasks were tracked', () => {
    const outcome = replayEntries([
      value(1, { ...base, seq: 0, type: 'turn.started', turnId: 't0' }),
      value(2, {
        ...base,
        seq: 1,
        type: 'assistant.parts.appended',
        messageId: 'msg_1',
        parts: [{ type: 'tool-call', callId: 'c1', name: 'execute', argsJson: '{}' }],
      }),
      value(3, { ...base, seq: 2, type: 'turn.settled', turnId: 't0', stopReason: 'completed' }),
    ])
    expect(outcome.rejected).toEqual([])
    expect(outcome.model.backgroundTasks).toBeUndefined()
  })

  it('folds background task reports, the latest one winning', () => {
    const task = { taskId: 'call_bg', kind: 'shell', label: 'Run tests' }
    const outcome = replayEntries([
      value(1, {
        ...base,
        seq: 0,
        at: 10,
        type: 'background.task.updated',
        ...task,
        status: 'running',
      }),
      value(2, {
        ...base,
        seq: 1,
        at: 20,
        type: 'background.task.updated',
        ...task,
        label: '',
        status: 'completed',
        detail: 'The agent reported back',
      }),
      value(3, {
        ...base,
        seq: 2,
        at: 30,
        type: 'background.task.updated',
        taskId: 'agent_1',
        kind: 'subagent',
        label: 'Survey',
        status: 'running',
        detail: 'Read a.ts',
      }),
    ])
    expect(outcome.rejected).toEqual([])
    expect(outcome.model.backgroundTasks).toEqual([
      {
        id: 'call_bg',
        kind: 'shell',
        label: 'Run tests',
        status: 'completed',
        detail: 'The agent reported back',
        startedAt: 10,
        updatedAt: 20,
        endedAt: 20,
      },
      {
        id: 'agent_1',
        kind: 'subagent',
        label: 'Survey',
        status: 'running',
        detail: 'Read a.ts',
        startedAt: 30,
        updatedAt: 30,
        endedAt: null,
      },
    ])
  })

  it('quarantines a JSON-error line and keeps folding around it', () => {
    const outcome = replayEntries([
      value(1, { ...base, seq: 0, type: 'turn.started', turnId: 't0' }),
      { kind: 'error', line: 2, message: 'unexpected token', raw: '{not json}' },
      value(3, { ...base, seq: 2, type: 'turn.started', turnId: 't2' }),
    ])
    expect(outcome.rejected).toHaveLength(1)
    expect(outcome.rejected[0]).toMatchObject({ line: 2, reason: 'unexpected token', raw: '{not json}' })
    expect(diagnosticsOf(outcome.rejected)).toEqual({ rejectedCount: 1, firstReason: 'unexpected token' })
  })

  it('rejects an unknown event type instead of throwing or applying it', () => {
    const outcome = replayEntries([value(1, { ...base, seq: 0, type: 'time.travelled' })])
    expect(outcome.rejected).toHaveLength(1)
    expect(outcome.rejected[0]?.reason).toContain('type')
    expect(outcome.rejected[0]?.raw).toContain('time.travelled')
  })

  it('rejects an invalid seq (negative) with a flattened zod path', () => {
    const outcome = replayEntries([value(1, { ...base, seq: -1, type: 'turn.started', turnId: 't' })])
    expect(outcome.rejected).toHaveLength(1)
    expect(outcome.rejected[0]?.reason).toMatch(/seq/)
  })

  it('reports empty diagnostics when every line is valid', () => {
    const outcome = replayEntries([])
    expect(outcome.rejected).toEqual([])
    expect(diagnosticsOf(outcome.rejected)).toEqual({ rejectedCount: 0, firstReason: null })
  })
})
