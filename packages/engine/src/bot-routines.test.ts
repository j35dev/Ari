import { describe, expect, it } from 'vitest'
import { initialReadModel, applyEvent, type SessionReadModel } from './projection'
import {
  latestRoutineTurnId,
  nextFireAt,
  routineIsPending,
  routineMessage,
} from './bot-routines'

const HOUR = 60 * 60_000

function model(events: Array<Record<string, unknown>> = []): SessionReadModel {
  let next = applyEvent(initialReadModel(), {
    type: 'session.created',
    session: {
      id: 's',
      projectId: 'p',
      title: 'Bot',
      driverKind: 'claude',
      modelId: null,
      permissionMode: 'ask',
      status: 'idle',
      createdAt: 1,
      updatedAt: 1,
    },
    seq: 1,
  } as never)
  let seq = 1
  for (const event of events) {
    next = applyEvent(next, { ...event, sessionId: 's', seq: ++seq, at: seq } as never)
  }
  return next
}

describe('nextFireAt', () => {
  it('keeps the first slot and skips every missed window after it', () => {
    expect(nextFireAt(10 * HOUR, HOUR, 5 * HOUR)).toBe(10 * HOUR)
    expect(nextFireAt(10 * HOUR, HOUR, 10 * HOUR)).toBe(11 * HOUR)
    // Closed for three days: fire at the next slot, never three days of runs.
    expect(nextFireAt(10 * HOUR, HOUR, 82 * HOUR)).toBe(83 * HOUR)
  })
})

it('tells the bot nobody is present to answer', () => {
  expect(routineMessage('run the tests')).toContain('no user is present')
  expect(routineMessage('run the tests')).toContain('run the tests')
})

describe('routineIsPending', () => {
  it('sees a queued fire as pending', () => {
    const read = model([{ type: 'turn.started', turnId: 'turn_1' }])
    // A routine message queued behind someone else's turn.
    const queued = {
      ...read,
      queuedMessages: [
        { text: 'nightly', attachments: [], origin: { kind: 'routine' as const, routineId: 'r1' } },
      ],
    }
    expect(routineIsPending(queued, 'r1')).toBe(true)
    expect(routineIsPending(queued, 'r2')).toBe(false)
  })

  it('sees only its own active turn as pending', () => {
    const read = model([
      { type: 'turn.started', turnId: 'turn_1' },
      {
        type: 'user.message.added',
        message: {
          id: 'm1',
          sessionId: 's',
          turnId: 'turn_1',
          role: 'user',
          origin: { kind: 'routine', routineId: 'r1' },
          parts: [{ type: 'text', text: 'nightly' }],
          createdAt: 2,
        },
      },
    ])
    expect(latestRoutineTurnId(read, 'r1')).toBe('turn_1')
    expect(routineIsPending(read, 'r1')).toBe(true)
    expect(routineIsPending(read, 'r2')).toBe(false)
    expect(routineIsPending({ ...read, activeTurnId: null }, 'r1')).toBe(false)
  })
})
