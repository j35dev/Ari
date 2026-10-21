import { describe, expect, it } from 'vitest'
import { prune, retain, type KeptSession } from './session-keep-alive'

const entry = (poolId: string, sessionId: string): KeptSession => ({ poolId, sessionId })

describe('retain', () => {
  it('moves the shown session to the front', () => {
    const kept = [entry('p1', 'a'), entry('p1', 'b')]
    expect(retain(kept, 'p1', 'b')).toEqual([entry('p1', 'b'), entry('p1', 'a')])
  })

  it('returns the same list when the session is already the newest', () => {
    const kept = [entry('p1', 'a'), entry('p1', 'b')]
    expect(retain(kept, 'p1', 'a')).toBe(kept)
  })

  it('drops the oldest past the limit, across every pool', () => {
    const kept = [entry('p1', 'a'), entry('p2', 'b'), entry('p1', 'c')]
    expect(retain(kept, 'p2', 'd', 3)).toEqual([
      entry('p2', 'd'),
      entry('p1', 'a'),
      entry('p2', 'b'),
    ])
  })

  it('keeps a session in one pool only', () => {
    const kept = [entry('p1', 'a'), entry('p1', 'b')]
    expect(retain(kept, 'p2', 'b')).toEqual([entry('p2', 'b'), entry('p1', 'a')])
  })
})

describe('prune', () => {
  it('drops entries the predicate rejects', () => {
    const kept = [entry('p1', 'a'), entry('p2', 'b')]
    expect(prune(kept, (e) => e.poolId === 'p1')).toEqual([entry('p1', 'a')])
  })

  it('returns the same list when nothing goes', () => {
    const kept = [entry('p1', 'a')]
    expect(prune(kept, () => true)).toBe(kept)
  })
})
