import { describe, expect, it } from 'vitest'
import type { Message } from '@ari/contracts/message'
import { createMessageFold } from './message-fold'

function user(id: string, text: string): Message {
  return {
    id,
    sessionId: 's',
    turnId: null,
    role: 'user',
    parts: [{ type: 'text', text }],
    createdAt: 1,
  }
}

const start = (id: string) => (): Omit<Message, 'parts'> => ({
  id,
  sessionId: 's',
  turnId: 't1',
  role: 'assistant',
  createdAt: 2,
})

describe('createMessageFold', () => {
  it('commits nothing until an event lands', () => {
    const fold = createMessageFold()
    expect(fold.commit()).toBeNull()
    fold.addUser(user('u1', 'hi'))
    expect(fold.commit()).toHaveLength(1)
    expect(fold.commit()).toBeNull()
  })

  it('folds a burst of deltas into one message per id', () => {
    const fold = createMessageFold()
    fold.addUser(user('u1', 'hi'))
    for (let i = 0; i < 500; i++) {
      fold.appendParts('a1', [{ type: 'text', text: String(i % 10) }], start('a1'))
    }
    const list = fold.commit()
    expect(list?.map((m) => m.id)).toEqual(['u1', 'a1'])
    expect(list?.[1]?.parts).toHaveLength(500)
    expect(list?.[1]).toMatchObject({ role: 'assistant', turnId: 't1', createdAt: 2 })
  })

  it('never mutates a message or list it has already handed out', () => {
    const fold = createMessageFold()
    fold.addUser(user('u1', 'hi'))
    fold.appendParts('a1', [{ type: 'text', text: 'one' }], start('a1'))
    const first = fold.commit()
    const firstAssistant = first?.[1]

    fold.appendParts('a1', [{ type: 'text', text: ' two' }], start('a1'))
    fold.appendParts('a1', [{ type: 'text', text: ' three' }], start('a1'))
    const second = fold.commit()

    expect(first).toHaveLength(2)
    expect(firstAssistant?.parts).toHaveLength(1)
    expect(second?.[1]).not.toBe(firstAssistant)
    expect(second?.[1]?.parts).toHaveLength(3)
    // Untouched messages keep their identity, so their rows stay memoized.
    expect(second?.[0]).toBe(first?.[0])
  })

  it('appends to the message the id names, even mid-list', () => {
    const fold = createMessageFold()
    fold.appendParts('a1', [{ type: 'text', text: 'before' }], start('a1'))
    fold.addUser(user('u2', 'steer'))
    fold.appendParts('a1', [{ type: 'text', text: ' after' }], start('a1'))
    const list = fold.commit()
    expect(list?.map((m) => m.id)).toEqual(['a1', 'u2'])
    expect(list?.[0]?.parts).toHaveLength(2)
  })
})
