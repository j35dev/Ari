import { describe, expect, it } from 'vitest'
import {
  clampRatio,
  closeLeaf,
  countLeaves,
  firstLeafId,
  hasLeaf,
  setRatio,
  splitLeaf,
  type PaneNode,
} from './terminal-layout'

const leaf = (id: string): PaneNode => ({ kind: 'leaf', paneId: id })

/** (A | B) / C — a row split stacked above C, exercising depth 2. */
function nested(): PaneNode {
  const row = splitLeaf(leaf('a'), 'a', 'row', 'b')
  return splitLeaf(row as PaneNode, 'a', 'col', 'c') as PaneNode
}

describe('terminal-layout', () => {
  it('splitLeaf turns the root leaf into a 50/50 split with derived splitId', () => {
    const root = splitLeaf(leaf('a'), 'a', 'row', 'b')
    expect(root).toEqual({
      kind: 'split',
      dir: 'row',
      ratio: 0.5,
      splitId: 'split_b',
      a: leaf('a'),
      b: leaf('b'),
    })
  })

  it('splitLeaf targets a nested leaf and returns null for unknown ids', () => {
    const root = nested()
    expect(countLeaves(root)).toBe(3)

    const split = splitLeaf(root, 'zzz', 'row', 'd')
    expect(split).toBeNull()

    const grown = splitLeaf(root, 'c', 'col', 'd')
    expect(grown).not.toBeNull()
    expect(countLeaves(grown as PaneNode)).toBe(4)
    // The original tree is untouched (pure transform).
    expect(countLeaves(root)).toBe(3)
  })

  it('closeLeaf promotes the sibling subtree', () => {
    const root = nested()
    // Closing b leaves (a / c) — the row split collapses entirely.
    const closed = closeLeaf(root, 'b') as PaneNode
    expect(closed.kind).toBe('split')
    expect(countLeaves(closed)).toBe(2)
    expect(hasLeaf(closed, 'b')).toBe(false)
  })

  it('closeLeaf returns null when the last pane closes or the id is unknown', () => {
    expect(closeLeaf(leaf('a'), 'a')).toBeNull()
    expect(closeLeaf(nested(), 'zzz')).toBeNull()
  })

  it('setRatio clamps into the usable band and ignores unknown splits', () => {
    const root = splitLeaf(leaf('a'), 'a', 'row', 'b') as PaneNode
    const splitId = (root as Extract<PaneNode, { kind: 'split' }>).splitId
    const ratioOf = (node: PaneNode): number =>
      node.kind === 'split' ? node.ratio : Number.NaN

    expect(ratioOf(setRatio(root, splitId, 0.02))).toBe(0.15)
    expect(ratioOf(setRatio(root, splitId, 0.99))).toBe(0.85)
    expect(ratioOf(setRatio(root, splitId, 0.7))).toBe(0.7)
    expect(setRatio(root, 'split_zzz', 0.9)).toBe(root)
  })

  it('clampRatio pins to the band edges', () => {
    expect(clampRatio(-1)).toBe(0.15)
    expect(clampRatio(0.5)).toBe(0.5)
    expect(clampRatio(2)).toBe(0.85)
  })

  it('firstLeafId reads in document order and null-safes', () => {
    expect(firstLeafId(null)).toBeNull()
    expect(firstLeafId(leaf('a'))).toBe('a')
    // Reading order: a (top of the col split) before b.
    expect(firstLeafId(nested())).toBe('a')
  })

  it('hasLeaf finds nested leaves', () => {
    const root = nested()
    expect(hasLeaf(root, 'c')).toBe(true)
    expect(hasLeaf(root, 'zzz')).toBe(false)
    expect(hasLeaf(null, 'a')).toBe(false)
  })
})
