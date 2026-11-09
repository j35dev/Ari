import { describe, expect, it } from 'vitest'
import {
  ACTIVE_SETTLE_LINGER_MS,
  peakActivity,
  reduceSessionActivity,
  treeActivity,
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
  it('separates queue time from execution and clears a cancelled queue status', () => {
    const queued = apply([{ type: 'session.status.changed', to: 'queued', at: NOW - 500 }])
    expect(queued).toEqual({ phase: 'queued', startedAt: null })
    expect(apply([{ type: 'session.status.changed', to: 'running', at: NOW }], queued)).toEqual({
      phase: 'working',
      startedAt: NOW,
    })
    expect(apply([{ type: 'turn.started', at: NOW + 10 }], queued)?.startedAt).toBe(NOW + 10)
    expect(apply([{ type: 'session.status.changed', to: 'idle' }], queued)).toBeUndefined()
  })

  it('tracks multiple live queued messages until execution or the last removal', () => {
    const queued = apply([{ type: 'message.enqueued' }, { type: 'message.enqueued' }])
    expect(queued).toEqual({ phase: 'queued', startedAt: null, queuedCount: 2 })
    const remaining = apply([{ type: 'message.dequeued' }], queued)
    expect(remaining).toEqual({ phase: 'queued', startedAt: null, queuedCount: 1 })
    expect(apply([{ type: 'message.dequeued' }], remaining)).toBeUndefined()
    expect(apply([{ type: 'turn.started', at: NOW }], remaining)).toEqual({
      phase: 'working',
      startedAt: NOW,
      queuedCount: 1,
    })
  })

  it('keeps a follow-up queue behind a live turn, then shows the pending work after settle', () => {
    const working = apply([{ type: 'turn.started' }, { type: 'message.enqueued' }])
    expect(working?.phase).toBe('working')
    expect(apply([{ type: 'assistant.parts.appended' }], working)).toBe(working)
    const paused = apply([{ type: 'input.requested' }], working)
    expect(apply([{ type: 'message.enqueued' }], paused)?.phase).toBe('paused')
    const queued = apply([{ type: 'turn.settled', stopReason: 'completed' }], working)
    expect(queued).toEqual({ phase: 'queued', startedAt: null, queuedCount: 1 })
    expect(
      apply([{ type: 'message.dequeued' }, { type: 'turn.started', at: NOW + 10 }], queued),
    ).toEqual({
      phase: 'working',
      startedAt: NOW + 10,
    })
    expect(apply([{ type: 'turn.settled', stopReason: 'error' }], working)?.phase).toBe('error')
  })

  it('returns to a pre-turn queue after its approval is answered', () => {
    const paused = apply([{ type: 'message.enqueued' }, { type: 'approval.requested' }])
    expect(apply([{ type: 'approval.responded' }], paused)).toEqual({
      phase: 'queued',
      startedAt: null,
      queuedCount: 1,
    })
  })

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
    expect(apply([{ type: 'input.responded' }], { ...paused, pauseReason: 'input' })).toEqual({
      phase: 'working',
      startedAt: NOW - 500,
    })
  })

  it('ignores idle status so the subsequent settle can still flash done', () => {
    const working: SessionActivity = { phase: 'working', startedAt: NOW }
    const afterIdle = apply([{ type: 'session.status.changed', to: 'idle' }], working)
    expect(afterIdle).toEqual(working)
    expect(
      apply([{ type: 'turn.settled', stopReason: 'completed', at: NOW + 10 }], afterIdle),
    ).toEqual({
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

  it('does not infer execution from a child spawn', () => {
    expect(apply([{ type: 'child.session.spawned', at: NOW }])).toBeUndefined()
    const queued: SessionActivity = { phase: 'queued', startedAt: null }
    expect(
      apply([{ type: 'child.session.spawned' }, { type: 'child.session.settled' }], queued),
    ).toBe(queued)
  })

  it('flashes done when a child settles on an idle parent', () => {
    expect(
      apply([{ type: 'child.session.settled', stopReason: 'completed', at: NOW + 5 }]),
    ).toEqual({ phase: 'done', startedAt: null, settledAt: NOW + 5 })
  })

  it('does not override a parent that is already working', () => {
    const working: SessionActivity = { phase: 'working', startedAt: NOW }
    expect(apply([{ type: 'child.session.spawned' }], working)).toEqual(working)
    expect(apply([{ type: 'child.session.settled', stopReason: 'completed' }], working)).toEqual(
      working,
    )
  })
})

describe('peakActivity', () => {
  it('prefers a required decision over working, queued, error, and done in either order', () => {
    const paused: SessionActivity = { phase: 'paused', startedAt: NOW, pauseReason: 'approval' }
    const others: SessionActivity[] = [
      { phase: 'working', startedAt: NOW },
      { phase: 'queued', startedAt: null },
      { phase: 'done', startedAt: null },
      { phase: 'error', startedAt: null },
    ]
    expect(peakActivity([...others, paused])).toBe(paused)
    expect(peakActivity([paused, ...others])).toBe(paused)
  })

  it('prefers execution over queues and queues over settled badges', () => {
    expect(
      peakActivity([
        { phase: 'done', startedAt: null, settledAt: NOW },
        { phase: 'queued', startedAt: null },
        { phase: 'working', startedAt: NOW },
        { phase: 'error', startedAt: null, settledAt: NOW },
      ])?.phase,
    ).toBe('working')
    expect(
      peakActivity([
        { phase: 'done', startedAt: null },
        { phase: 'queued', startedAt: null },
      ])?.phase,
    ).toBe('queued')
  })

  it('returns undefined when nothing is live', () => {
    expect(peakActivity([undefined, undefined])).toBeUndefined()
  })
})

describe('treeActivity', () => {
  const working: SessionActivity = { phase: 'working', startedAt: NOW }
  const blocked: SessionActivity = { phase: 'paused', startedAt: NOW, pauseReason: 'approval' }
  const done: SessionActivity = { phase: 'done', startedAt: null, settledAt: NOW }
  const queued: SessionActivity = { phase: 'queued', startedAt: null }

  it('folds queued children without claiming execution and prioritizes blocked children', () => {
    expect(treeActivity(done, [queued])).toBe(queued)
    expect(treeActivity(undefined, [queued])).toBe(queued)
    expect(treeActivity(queued, [working])).toBe(working)
    expect(treeActivity(working, [queued])).toBe(working)
    expect(treeActivity(queued, [working, blocked])).toBe(blocked)
    expect(treeActivity(blocked, [queued])).toBe(blocked)
  })

  it('shows a parent as working while its children still run', () => {
    expect(treeActivity(done, [undefined, working])).toBe(working)
    expect(treeActivity(undefined, [working])).toBe(working)
  })

  it('surfaces a child waiting on the user even over the parent’s own live turn', () => {
    expect(treeActivity(working, [working, blocked])).toBe(blocked)
  })

  it('keeps the parent’s own mark when no child is live', () => {
    expect(treeActivity(done, [done, undefined])).toBe(done)
    expect(treeActivity(working, [done])).toBe(working)
    expect(treeActivity(undefined, [])).toBeUndefined()
  })
})

describe('ACTIVE_SETTLE_LINGER_MS', () => {
  it('fades a seen settle after a few seconds', () => {
    expect(ACTIVE_SETTLE_LINGER_MS).toBe(4_200)
  })
})
