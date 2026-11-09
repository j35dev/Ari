import { describe, expect, it } from 'vitest'
import { visualizationSchema } from '@ari/contracts/visualization'
import { graphEdgePath, layoutGraph, NODE_HEIGHT, NODE_WIDTH } from './graph-layout'

const graph = visualizationSchema.parse({
  type: 'graph',
  title: 'Flow',
  nodes: [
    { id: 'a', label: 'A' },
    { id: 'b', label: 'B' },
    { id: 'c', label: 'C' },
    { id: 'd', label: 'D' },
  ],
  edges: [
    { from: 'a', to: 'b' },
    { from: 'b', to: 'a' },
    { from: 'a', to: 'c' },
    { from: 'b', to: 'c' },
    { from: 'c', to: 'd' },
    { from: 'd', to: 'd' },
  ],
})
if (graph.type !== 'graph') throw new Error('Not a graph')
describe('graph layout', () => {
  it.each(['right', 'down'] as const)(
    'lays out cycles and duplicate component links without overlapping cards: %s',
    (direction) => {
      const layout = layoutGraph(graph, direction)
      const a = layout.positions.get('a'),
        b = layout.positions.get('b'),
        c = layout.positions.get('c')
      expect(a?.rank).toBe(b?.rank)
      expect(c?.rank).toBe((a?.rank ?? 0) + 1)
      const points = [...layout.positions.values()]
      for (const point of points) {
        expect(Number.isFinite(point.x) && Number.isFinite(point.y)).toBe(true)
        expect(point.x + NODE_WIDTH).toBeLessThan(layout.width)
        expect(point.y + NODE_HEIGHT).toBeLessThan(layout.height)
      }
      for (let i = 0; i < points.length; i++)
        for (let j = i + 1; j < points.length; j++) {
          const first = points[i],
            second = points[j]
          if (!first || !second) throw new Error('Missing position')
          expect(
            Math.abs(first.x - second.x) >= NODE_WIDTH ||
              Math.abs(first.y - second.y) >= NODE_HEIGHT,
          ).toBe(true)
        }
      for (const edge of graph.edges) {
        const from = layout.positions.get(edge.from),
          to = layout.positions.get(edge.to)
        if (!from || !to) throw new Error('Missing position')
        expect(graphEdgePath(from, to, direction, edge.from === edge.to).path).not.toMatch(
          /NaN|Infinity/,
        )
      }
    },
  )
})
