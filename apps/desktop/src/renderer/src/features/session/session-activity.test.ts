import { describe, expect, it } from 'vitest'
import {
  ACTIVE_SETTLE_LINGER_MS,
  peakActivity,
  reduceSessionActivity,
  type SessionActivity,
} from './session-activity'

const NOW = 1_700_000_000_000

function apply(
  events: Array<Parameters<typeof reduceSessionActivity>[1]>,
  start?: SessionActivity,
): SessionActivity | undefined {
  return events.reduce<SessionActivity | undefined>(
    (state, event) => reduceSessionActivity(state, event, NOW),
    start,
  )
}

describe('reduceSessionActivity', () => {
  it('enters working on turn.started and keeps startedAt through a pause', () => {
    const working = apply([{ type: 'turn.started', at: NOW - 1_000 }])
    expect(working).toEqual({ phase: 'working', startedAt: NOW - 1_000 })

    const paused = apply([{ type: 'approval.requested' }], working)
    expect(paused).toEqual({
      phase: 'paused',
      startedAt: NOW - 1_000,
      pauseReason: 'approval',
    })
  })

  it('maps waiting-approval / waiting-input status onto paused', () => {
    expect(apply([{ type: 'session.status.changed', to: 'waiting-approval' }])?.pauseReason).toBe(
      'approval',
    )
    expect(apply([{ type: 'session.status.changed', to: 'waiting-input' }])?.pauseReason).toBe(
      'input',
    )
  })

  it('resumes working after an approval or input answer', () => {
    const paused: SessionActivity = {
      phase: 'paused',
      startedAt: NOW - 500,
      pauseReason: 'approval',
    }
    expect(apply([{ type: 'approval.responded' }], paused)).toEqual({
      phase: 'working',
      startedAt: NOW - 500,
    })
    expect(
      apply([{ type: 'input.responded' }], { ...paused, pauseReason: 'input' }),
    ).toEqual({ phase: 'working', startedAt: NOW - 500 })
  })

  it('ignores idle status so the subsequent settle can still flash done', () => {
    const working: SessionActivity = { phase: 'working', startedAt: NOW }
    const afterIdle = apply([{ type: 'session.status.changed', to: 'idle' }], working)
    expect(afterIdle).toEqual(working)
    expect(apply([{ type: 'turn.settled', stopReason: 'completed', at: NOW + 10 }], afterIdle)).toEqual({
      phase: 'done',
      startedAt: null,
      settledAt: NOW + 10,
    })
  })

  it('treats interrupted settles as idle and error settles as error', () => {
    const working: SessionActivity = { phase: 'working', startedAt: NOW }
    expect(apply([{ type: 'turn.settled', stopReason: 'interrupted' }], working)).toBeUndefined()
    expect(apply([{ type: 'turn.settled', stopReason: 'error', at: NOW }], working)).toEqual({
      phase: 'error',
      startedAt: null,
      settledAt: NOW,
    })
  })

  it('ignores streaming noise', () => {
    const working: SessionActivity = { phase: 'working', startedAt: NOW }
    expect(apply([{ type: 'assistant.parts.appended' }], working)).toEqual(working)
  })
})

describe('peakActivity', () => {
  it('prefers working over paused, error, and done', () => {
    expect(
      peakActivity([
        { phase: 'done', startedAt: null, settledAt: NOW },
        { phase: 'paused', startedAt: NOW, pauseReason: 'approval' },
        { phase: 'working', startedAt: NOW },
        { phase: 'error', startedAt: null, settledAt: NOW },
      ])?.phase,
    ).toBe('working')
  })

  it('returns undefined when nothing is live', () => {
    expect(peakActivity([undefined, undefined])).toBeUndefined()
  })
})

describe('ACTIVE_SETTLE_LINGER_MS', () => {
  it('fades a seen settle after a few seconds', () => {
    expect(ACTIVE_SETTLE_LINGER_MS).toBe(4_200)
  })
})
