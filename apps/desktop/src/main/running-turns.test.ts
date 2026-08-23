import { describe, expect, it } from 'vitest'
import type { JournalEvent } from '@ari/contracts/events'
import { RunningTurnCounter } from './running-turns'

function event(partial: {
  type: 'turn.started' | 'turn.settled'
  sessionId: string
  turnId: string
}): JournalEvent {
  return {
    seq: 1,
    at: Date.now(),
    errorMessage: null,
    stopReason: 'completed',
    ...partial,
  }
}

describe('RunningTurnCounter', () => {
  it('counts started turns and drops them on settle', () => {
    const counter = new RunningTurnCounter()
    expect(counter.push(event({ type: 'turn.started', sessionId: 's1', turnId: 't1' }))).toBe(true)
    expect(counter.push(event({ type: 'turn.started', sessionId: 's2', turnId: 't2' }))).toBe(true)
    expect(counter.count).toBe(2)

    expect(counter.push(event({ type: 'turn.settled', sessionId: 's1', turnId: 't1' }))).toBe(true)
    expect(counter.count).toBe(1)
    expect(counter.push(event({ type: 'turn.settled', sessionId: 's2', turnId: 't2' }))).toBe(true)
    expect(counter.count).toBe(0)
  })

  it('ignores unrelated events and unknown settles', () => {
    const counter = new RunningTurnCounter()
    const other = event({ type: 'turn.settled', sessionId: 's1', turnId: 'ghost' })
    expect(
      counter.push({
        type: 'session.status.changed',
        seq: 0,
        at: 0,
        sessionId: 's1',
        from: 'idle',
        to: 'running',
        reason: null,
      }),
    ).toBe(false)
    expect(counter.push(other)).toBe(false)
    expect(counter.count).toBe(0)
  })

  it('does not double-count duplicate starts and settles each turn once', () => {
    const counter = new RunningTurnCounter()
    const start = event({ type: 'turn.started', sessionId: 's1', turnId: 't1' })
    expect(counter.push(start)).toBe(true)
    expect(counter.push(start)).toBe(false)
    expect(counter.count).toBe(1)
    expect(counter.push(event({ type: 'turn.settled', sessionId: 's1', turnId: 't1' }))).toBe(true)
    expect(counter.push(event({ type: 'turn.settled', sessionId: 's1', turnId: 't1' }))).toBe(false)
    expect(counter.count).toBe(0)
  })

  it('tracks multiple turns within one session independently', () => {
    const counter = new RunningTurnCounter()
    counter.push(event({ type: 'turn.started', sessionId: 's1', turnId: 't1' }))
    counter.push(event({ type: 'turn.started', sessionId: 's1', turnId: 't2' }))
    expect(counter.count).toBe(2)
    counter.push(event({ type: 'turn.settled', sessionId: 's1', turnId: 't1' }))
    expect(counter.count).toBe(1)
  })
})
