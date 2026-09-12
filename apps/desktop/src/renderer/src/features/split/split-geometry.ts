/**
 * Where the panes are, in the abstract: enough geometry to answer the two
 * questions the tree alone cannot — which side of a pane a drop landed on, and
 * which pane the arrow keys should move focus to.
 *
 * Nothing here touches the DOM. The renderer never needs a computed layout,
 * because a drop measures the pane it landed on, so these rects exist for the
 * keyboard path (and to keep the arithmetic testable).
 */

import type { PaneEdge, PaneNode, SplitLayout } from './split-layout'

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface PaneRect extends Rect {
  paneId: string
}

/** What an unmeasured layout occupies: the unit square, so ratios read as fractions. */
const UNIT: Rect = { x: 0, y: 0, width: 1, height: 1 }

/** Slack for floating point, so a pane flush against another still counts as adjacent. */
const EPSILON = 1e-6

/** Edge precedence when a point is equidistant from two of them. */
const EDGES: readonly PaneEdge[] = ['left', 'right', 'above', 'below']

/** Every pane's box, in reading order, dividing `box` by the splits' ratios. */
export function paneRects(root: PaneNode, box: Rect = UNIT): PaneRect[] {
  if (root.kind === 'leaf') return [{ paneId: root.paneId, ...box }]
  const { ratio } = root
  const leading: Rect =
    root.direction === 'row'
      ? { ...box, width: box.width * ratio }
      : { ...box, height: box.height * ratio }
  const trailing: Rect =
    root.direction === 'row'
      ? { ...box, x: box.x + box.width * ratio, width: box.width * (1 - ratio) }
      : { ...box, y: box.y + box.height * ratio, height: box.height * (1 - ratio) }
  return [...paneRects(root.a, leading), ...paneRects(root.b, trailing)]
}

/**
 * The side of `rect` a drop at `point` belongs to: whichever edge is nearest,
 * measured as a fraction of the pane so the middle of a pane is its own
 * crossroads. The exact centre, and any pane with no measured box (jsdom, a
 * hidden pane), come back `right` — the trailing side, and the same one a
 * plain "split" produces.
 */
export function edgeForPoint(point: { x: number; y: number }, rect: Rect): PaneEdge {
  if (rect.width <= 0 || rect.height <= 0) return 'right'
  const x = (point.x - rect.x) / rect.width
  const y = (point.y - rect.y) / rect.height
  const distance: Record<PaneEdge, number> = { left: x, right: 1 - x, above: y, below: 1 - y }
  return EDGES.reduce(
    (best, edge) => (distance[edge] < distance[best] ? edge : best),
    'right' as PaneEdge,
  )
}

/**
 * The pane the arrow keys should move to, or null at the outer edge. Of the
 * panes on that side, the one sharing the most of this pane's own span wins —
 * that is what makes the pane straight across from you the neighbour, rather
 * than one that merely happens to be on the same side. Distance breaks ties.
 */
export function focusNeighbour(
  layout: SplitLayout,
  paneId: string,
  direction: PaneEdge,
): string | null {
  const rects = paneRects(layout.root)
  const from = rects.find((rect) => rect.paneId === paneId)
  if (from === undefined) return null
  const horizontal = direction === 'left' || direction === 'right'

  /** Clearance along the axis of travel; zero for a pane flush against this one. */
  const gap = (rect: PaneRect): number => {
    if (direction === 'left') return from.x - (rect.x + rect.width)
    if (direction === 'right') return rect.x - (from.x + from.width)
    if (direction === 'above') return from.y - (rect.y + rect.height)
    return rect.y - (from.y + from.height)
  }
  /** Length of the pane's own span the candidate overlaps on the other axis. */
  const shared = (rect: PaneRect): number =>
    horizontal
      ? Math.min(from.y + from.height, rect.y + rect.height) - Math.max(from.y, rect.y)
      : Math.min(from.x + from.width, rect.x + rect.width) - Math.max(from.x, rect.x)

  const candidates = rects
    .filter((rect) => rect.paneId !== paneId && gap(rect) >= -EPSILON)
    .sort((a, b) => {
      const aligned = (rect: PaneRect): number => (shared(rect) > 0 ? 1 : 0)
      if (aligned(a) !== aligned(b)) return aligned(b) - aligned(a)
      if (gap(a) !== gap(b)) return gap(a) - gap(b)
      return shared(b) - shared(a)
    })
  const best = candidates[0]
  return best === undefined ? null : best.paneId
}
