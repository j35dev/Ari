import { expect, it } from 'vitest'
import { descendantIds } from './subtree-ids'

it('returns descendants deepest-first so parents destroy after children', () => {
  expect(
    descendantIds(
      [
        { id: 'root' },
        { id: 'a', parentSessionId: 'root' },
        { id: 'b', parentSessionId: 'root' },
        { id: 'a1', parentSessionId: 'a' },
      ],
      'root',
    ),
  ).toEqual(['a1', 'a', 'b'])
})

it('returns an empty list for a session with no children', () => {
  expect(descendantIds([{ id: 'solo' }], 'solo')).toEqual([])
})
