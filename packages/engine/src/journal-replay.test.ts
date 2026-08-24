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
