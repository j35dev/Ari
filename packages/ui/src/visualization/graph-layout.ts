import type { VisualizationSpec } from '@ari/contracts/visualization'

export type GraphSpec = Extract<VisualizationSpec, { type: 'graph' }>
export type GraphDirection = 'right' | 'down'
export const NODE_WIDTH = 196,
  NODE_HEIGHT = 88

/** Collapse cycles before ranking, then order each layer by its neighbors to reduce crossings. */
export function layoutGraph(spec: GraphSpec, direction: GraphDirection) {
  const adjacency = new Map(spec.nodes.map((node) => [node.id, [] as string[]]))
  for (const edge of spec.edges) adjacency.get(edge.from)?.push(edge.to)
  let index = 0
  const indices = new Map<string, number>(),
    low = new Map<string, number>(),
    stack: string[] = [],
    stacked = new Set<string>(),
    components: string[][] = []
  const visit = (id: string): void => {
    indices.set(id, index)
    low.set(id, index)
    index++
    stack.push(id)
    stacked.add(id)
    for (const target of adjacency.get(id) ?? []) {
      if (!indices.has(target)) {
        visit(target)
        low.set(id, Math.min(low.get(id) ?? 0, low.get(target) ?? 0))
      } else if (stacked.has(target))
        low.set(id, Math.min(low.get(id) ?? 0, indices.get(target) ?? 0))
    }
    if (indices.get(id) !== low.get(id)) return
    const group: string[] = []
    let member: string | undefined
    do {
      member = stack.pop()
      if (member !== undefined) {
        stacked.delete(member)
        group.push(member)
      }
    } while (member !== undefined && member !== id)
    components.push(group)
  }
  for (const node of spec.nodes) if (!indices.has(node.id)) visit(node.id)
  const component = new Map<string, number>()
  components.forEach((group, i) => group.forEach((id) => component.set(id, i)))
  const outgoing = components.map(() => new Set<number>()),
    incoming = components.map(() => 0),
    ranks = components.map(() => 0)
  for (const edge of spec.edges) {
    const from = component.get(edge.from),
      to = component.get(edge.to)
    if (from === undefined || to === undefined || from === to || outgoing[from]?.has(to)) continue
    outgoing[from]?.add(to)
    incoming[to] = (incoming[to] ?? 0) + 1
  }
  const queue = incoming.flatMap((count, i) => (count === 0 ? [i] : []))
  while (queue.length) {
    const current = queue.shift()
    if (current === undefined) break
    for (const target of outgoing[current] ?? []) {
      ranks[target] = Math.max(ranks[target] ?? 0, (ranks[current] ?? 0) + 1)
      incoming[target] = (incoming[target] ?? 0) - 1
      if (incoming[target] === 0) queue.push(target)
    }
  }
  const layers = Array.from({ length: Math.max(...ranks) + 1 }, () => [] as string[])
  for (const node of spec.nodes) layers[ranks[component.get(node.id) ?? 0] ?? 0]?.push(node.id)
  for (let pass = 0; pass < 3; pass++) {
    const order = new Map(layers.flatMap((layer) => layer.map((id, i) => [id, i] as const)))
    const neighbors = (id: string): number => {
      const links = spec.edges.filter((edge) =>
        pass % 2 === 0 ? edge.to === id : edge.from === id,
      )
      return links.length
        ? links.reduce(
            (sum, edge) => sum + (order.get(pass % 2 === 0 ? edge.from : edge.to) ?? 0),
            0,
          ) / links.length
        : (order.get(id) ?? 0)
    }
    for (const layer of layers) layer.sort((a, b) => neighbors(a) - neighbors(b))
  }
  const slots = Math.max(...layers.map((layer) => layer.length))
  const positions = new Map<string, { x: number; y: number; rank: number }>()
  layers.forEach((layer, rank) =>
    layer.forEach((id, i) => {
      const cross = i + (slots - layer.length) / 2
      positions.set(
        id,
        direction === 'right'
          ? { x: 52 + rank * 276, y: 52 + cross * 132, rank }
          : { x: 52 + cross * 248, y: 52 + rank * 164, rank },
      )
    }),
  )
  return {
    positions,
    width: direction === 'right' ? layers.length * 276 + 28 : slots * 248 + 52,
    height: direction === 'right' ? slots * 132 + 60 : layers.length * 164 + 28,
  }
}

export function graphEdgePath(
  a: { x: number; y: number },
  b: { x: number; y: number },
  direction: GraphDirection,
  self = false,
): { path: string; labelX: number; labelY: number } {
  if (self) {
    const x = a.x + NODE_WIDTH,
      y = a.y + NODE_HEIGHT / 2
    return {
      path: `M${x},${y} C${x + 60},${y - 104} ${x - 44},${y - 104} ${x - 26},${a.y - 4}`,
      labelX: x + 8,
      labelY: a.y - 24,
    }
  }
  if (direction === 'down') {
    const sx = a.x + NODE_WIDTH / 2,
      sy = a.y + NODE_HEIGHT,
      forward = b.y > a.y,
      tx = b.x + NODE_WIDTH / 2,
      ty = forward ? b.y - 4 : b.y + NODE_HEIGHT + 4
    return {
      path: forward
        ? `M${sx},${sy} C${sx},${sy + 38} ${tx},${ty - 38} ${tx},${ty}`
        : `M${sx},${sy} C${sx + 134},${sy + 80} ${tx + 134},${ty + 80} ${tx},${ty}`,
      labelX: (sx + tx) / 2 + (forward ? 12 : 96),
      labelY: (sy + ty) / 2,
    }
  }
  const sx = a.x + NODE_WIDTH,
    sy = a.y + NODE_HEIGHT / 2,
    forward = b.x > a.x,
    tx = forward ? b.x - 4 : b.x + NODE_WIDTH + 4,
    ty = b.y + NODE_HEIGHT / 2
  return {
    path: forward
      ? `M${sx},${sy} C${sx + 38},${sy} ${tx - 38},${ty} ${tx},${ty}`
      : `M${sx},${sy} C${sx + 72},${sy - 60} ${tx + 72},${ty + 60} ${tx},${ty}`,
    labelX: forward ? (sx + tx) / 2 : Math.max(sx, tx) + 60,
    labelY: (sy + ty) / 2 - 12,
  }
}
