import { beforeEach, describe, expect, it } from 'vitest'
import {
  applySessionOrder,
  moveSession,
  readSessionOrder,
  resetSessionOrderCache,
} from './session-order'

const rows = (...ids: string[]) => ids.map((id) => ({ id }))
const ids = (list: { id: string }[]) => list.map((row) => row.id)

beforeEach(() => {
  localStorage.clear()
  resetSessionOrderCache()
})

describe('applySessionOrder', () => {
  it('keeps recency when nothing has been arranged', () => {
    expect(ids(applySessionOrder(rows('c', 'b', 'a'), []))).toEqual(['c', 'b', 'a'])
  })

  it('leads with new sessions by recency, then the arranged ones in place', () => {
    // `new` arrived after the user arranged a, b, c; recency alone would move b up.
    expect(ids(applySessionOrder(rows('new', 'b', 'c', 'a'), ['a', 'b', 'c']))).toEqual([
      'new',
      'a',
      'b',
      'c',
    ])
  })
})

describe('moveSession', () => {
  it('moves a card before or after another and saves the whole section', () => {
    moveSession(['a', 'b', 'c'], 'c', 'a', 'before')
    expect(readSessionOrder()).toEqual(['c', 'a', 'b'])
    moveSession(['c', 'a', 'b'], 'c', 'b', 'after')
    expect(readSessionOrder()).toEqual(['a', 'b', 'c'])
  })

  it('keeps other sections arranged and survives a reload', () => {
    moveSession(['p1', 'p2'], 'p2', 'p1', 'before')
    moveSession(['a', 'b'], 'b', 'a', 'before')
    resetSessionOrderCache()
    const saved = readSessionOrder()
    expect(ids(applySessionOrder(rows('p1', 'p2'), saved))).toEqual(['p2', 'p1'])
    expect(ids(applySessionOrder(rows('a', 'b'), saved))).toEqual(['b', 'a'])
  })

  it('ignores a drop on itself or on a card from another section', () => {
    moveSession(['a', 'b'], 'a', 'a', 'before')
    moveSession(['a', 'b'], 'a', 'x', 'before')
    expect(readSessionOrder()).toEqual([])
  })
})
