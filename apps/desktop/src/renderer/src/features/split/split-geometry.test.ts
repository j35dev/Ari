import { describe, expect, it } from 'vitest'
import {
  initialLayout,
  setRatio,
  splitPane,
  type IdFactory,
  type PaneEdge,
  type SplitLayout,
} from './split-layout'
import {
  edgeForPoint,
  focusNeighbour,
  paneRects,
  type PaneRect,
  type Rect,
} from './split-geometry'

/** Replays splits over one deterministic id sequence, as `split-layout.test.ts` does. */
function build(...moves: Array<[pane: string, edge: PaneEdge]>): SplitLayout {
  const seen: Record<'pane' | 'split', number> = { pane: 0, split: 0 }
  const newId: IdFactory = (kind) => `${kind}${++seen[kind]}`
  let layout = initialLayout(newId)
  for (const [pane, edge] of moves) layout = splitPane(layout, pane, edge, newId)
  return layout
}

/**
 * A two-by-two grid: a stacked pair on the left, another on the right. Each
 * split goes inside the pane it names, so the ids never come out in reading
 * order — the positional helpers below are how these tests name a pane.
 */
const grid = (): SplitLayout =>
  build(['pane1', 'right'], ['pane2', 'below'], ['pane1', 'below'])

const rectOf = (layout: SplitLayout, paneId: string): PaneRect | undefined =>
  paneRects(layout.root).find((rect) => rect.paneId === paneId)

/** The pane filling a quadrant of a laid-out tree, by its corner. */
function quadrant(layout: SplitLayout, x: number, y: number): string {
  const rect = paneRects(layout.root).find((candidate) => candidate.x === x && candidate.y === y)
  if (rect === undefined) throw new Error(`no pane at ${x}, ${y}`)
  return rect.paneId
}
const topLeft = (layout: SplitLayout): string => quadrant(layout, 0, 0)
const topRight = (layout: SplitLayout): string => quadrant(layout, 0.5, 0)
const bottomLeft = (layout: SplitLayout): string => quadrant(layout, 0, 0.5)
const bottomRight = (layout: SplitLayout): string => quadrant(layout, 0.5, 0.5)

describe('paneRects', () => {
  it('gives a lone pane the whole box', () => {
    expect(paneRects(build().root)).toEqual([{ paneId: 'pane1', x: 0, y: 0, width: 1, height: 1 }])
  })

  it('splits the box along the split axis, halves by default', () => {
    expect(paneRects(build(['pane1', 'right']).root)).toEqual([
      { paneId: 'pane1', x: 0, y: 0, width: 0.5, height: 1 },
      { paneId: 'pane2', x: 0.5, y: 0, width: 0.5, height: 1 },
    ])
    expect(paneRects(build(['pane1', 'below']).root)).toEqual([
      { paneId: 'pane1', x: 0, y: 0, width: 1, height: 0.5 },
      { paneId: 'pane2', x: 0, y: 0.5, width: 1, height: 0.5 },
    ])
  })

  it('divides nested splits inside their parent', () => {
    expect(paneRects(grid().root)).toEqual([
      { paneId: 'pane1', x: 0, y: 0, width: 0.5, height: 0.5 },
      { paneId: 'pane4', x: 0, y: 0.5, width: 0.5, height: 0.5 },
      { paneId: 'pane2', x: 0.5, y: 0, width: 0.5, height: 0.5 },
      { paneId: 'pane3', x: 0.5, y: 0.5, width: 0.5, height: 0.5 },
    ])
  })

  it('honours a dragged ratio, and scales to a measured box', () => {
    const layout = setRatio(grid(), 'split1', 0.3)
    expect(rectOf(layout, 'pane1')).toEqual({ paneId: 'pane1', x: 0, y: 0, width: 0.3, height: 0.5 }) // prettier-ignore
    expect(rectOf(layout, 'pane3')).toEqual({ paneId: 'pane3', x: 0.3, y: 0.5, width: 0.7, height: 0.5 }) // prettier-ignore

    const box: Rect = { x: 40, y: 20, width: 800, height: 600 }
    expect(paneRects(build(['pane1', 'right']).root, box)).toEqual([
      { paneId: 'pane1', x: 40, y: 20, width: 400, height: 600 },
      { paneId: 'pane2', x: 440, y: 20, width: 400, height: 600 },
    ])
  })
})

describe('edgeForPoint', () => {
  const rect: Rect = { x: 100, y: 50, width: 200, height: 100 }

  it('picks the nearest half of the pane', () => {
    expect(edgeForPoint({ x: 120, y: 100 }, rect)).toBe('left')
    expect(edgeForPoint({ x: 290, y: 100 }, rect)).toBe('right')
    expect(edgeForPoint({ x: 200, y: 60 }, rect)).toBe('above')
    expect(edgeForPoint({ x: 200, y: 145 }, rect)).toBe('below')
  })

  it('takes the nearer edge near a corner', () => {
    expect(edgeForPoint({ x: 105, y: 70 }, rect)).toBe('left')
    expect(edgeForPoint({ x: 200, y: 55 }, rect)).toBe('above')
    expect(edgeForPoint({ x: 295, y: 130 }, rect)).toBe('right')
    expect(edgeForPoint({ x: 250, y: 145 }, rect)).toBe('below')
  })

  it('is a half, not a pixel distance: a wide pane still splits in the middle', () => {
    const wide: Rect = { x: 0, y: 0, width: 1000, height: 60 }
    expect(edgeForPoint({ x: 400, y: 30 }, wide)).toBe('left')
    expect(edgeForPoint({ x: 600, y: 30 }, wide)).toBe('right')
  })

  it('falls back to the trailing side for a pane with no measured box', () => {
    expect(edgeForPoint({ x: 0, y: 0 }, { x: 0, y: 0, width: 0, height: 0 })).toBe('right')
  })

  it('answers from the centre outwards, for a point outside the pane', () => {
    expect(edgeForPoint({ x: -500, y: 100 }, rect)).toBe('left')
    expect(edgeForPoint({ x: 500, y: 100 }, rect)).toBe('right')
  })
})

describe('focusNeighbour', () => {
  it('walks across a row and a column', () => {
    const row = build(['pane1', 'right'])
    expect(focusNeighbour(row, 'pane1', 'right')).toBe('pane2')
    expect(focusNeighbour(row, 'pane2', 'left')).toBe('pane1')
    expect(focusNeighbour(row, 'pane2', 'right')).toBeNull()
    expect(focusNeighbour(row, 'pane1', 'left')).toBeNull()

    const column = build(['pane1', 'below'])
    expect(focusNeighbour(column, 'pane1', 'below')).toBe('pane2')
    expect(focusNeighbour(column, 'pane2', 'above')).toBe('pane1')
    expect(focusNeighbour(column, 'pane1', 'above')).toBeNull()
  })

  it('prefers the pane straight across over one merely on the same side', () => {
    const layout = grid()
    expect(focusNeighbour(layout, bottomLeft(layout), 'right')).toBe(bottomRight(layout))
    expect(focusNeighbour(layout, bottomLeft(layout), 'above')).toBe(topLeft(layout))
    expect(focusNeighbour(layout, bottomRight(layout), 'left')).toBe(bottomLeft(layout))
    expect(focusNeighbour(layout, topRight(layout), 'below')).toBe(bottomRight(layout))
  })

  it('reaches out of a nested split to the pane beyond', () => {
    const layout = grid()
    expect(focusNeighbour(layout, topLeft(layout), 'below')).toBe(bottomLeft(layout))
    expect(focusNeighbour(layout, topLeft(layout), 'right')).toBe(topRight(layout))
    expect(focusNeighbour(layout, topRight(layout), 'left')).toBe(topLeft(layout))
    expect(focusNeighbour(layout, bottomLeft(layout), 'below')).toBeNull()
  })

  it('follows a ratio, so a thin pane is still the neighbour', () => {
    const layout = setRatio(grid(), 'split1', 0.1)
    expect(focusNeighbour(layout, 'pane4', 'right')).toBe('pane3')
    expect(focusNeighbour(layout, 'pane3', 'left')).toBe('pane4')
  })

  it('has no neighbour for a single pane or an unknown one', () => {
    const layout = grid()
    expect(focusNeighbour(build(), 'pane1', 'left')).toBeNull()
    expect(focusNeighbour(build(), 'pane1', 'right')).toBeNull()
    expect(focusNeighbour(layout, 'nope', 'right')).toBeNull()
  })
})
