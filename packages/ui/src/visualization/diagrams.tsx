import { useId } from 'react'
import type { CSSProperties } from 'react'
import type { VisualizationSpec } from '@ari/contracts/visualization'
import { color, domain, formatNumber, type Inspect } from './charts'

export function GraphDiagram({
  spec,
  inspect,
}: {
  spec: Extract<VisualizationSpec, { type: 'graph' }>
  inspect: Inspect
}) {
  const marker = `viz-arrow-${useId().replace(/:/g, '')}`
  const ranks = new Map(spec.nodes.map((node) => [node.id, 0]))
  const incoming = new Map(spec.nodes.map((node) => [node.id, 0]))
  for (const edge of spec.edges) incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1)
  const queue = spec.nodes.filter((node) => incoming.get(node.id) === 0).map((node) => node.id)
  const visited = new Set<string>()
  while (queue.length) {
    const id = queue.shift()
    if (id === undefined) break
    visited.add(id)
    for (const edge of spec.edges.filter((edge) => edge.from === id)) {
      ranks.set(edge.to, Math.max(ranks.get(edge.to) ?? 0, (ranks.get(id) ?? 0) + 1))
      const count = (incoming.get(edge.to) ?? 0) - 1
      incoming.set(edge.to, count)
      if (count === 0) queue.push(edge.to)
    }
  }
  // Cycles still render in a finite grid, with curved return edges.
  let nextRank = visited.size ? Math.max(...ranks.values()) + 1 : 0
  spec.nodes
    .filter((node) => !visited.has(node.id))
    .forEach((node, i) => {
      if (i > 0 && i % 4 === 0) nextRank++
      ranks.set(node.id, nextRank)
    })
  const columns = Math.max(...ranks.values()) + 1
  const counts = new Map<number, number>()
  const positions = new Map<string, { x: number; y: number }>()
  for (const node of spec.nodes) {
    const rank = ranks.get(node.id) ?? 0,
      row = counts.get(rank) ?? 0
    positions.set(node.id, { x: 28 + rank * 230, y: 36 + row * 110 })
    counts.set(rank, row + 1)
  }
  const width = columns * 230 + 12,
    height = Math.max(...counts.values()) * 110 + 48
  return (
    <svg
      className="ari-viz-svg"
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={spec.title}
      style={{ minWidth: width }}
    >
      <defs>
        <marker
          id={marker}
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="6"
          markerHeight="6"
          orient="auto-start-reverse"
        >
          <path d="M0 0 L10 5 L0 10 Z" fill="var(--ari-fg-subtle)" />
        </marker>
      </defs>
      {spec.edges.map((edge, i) => {
        const a = positions.get(edge.from),
          b = positions.get(edge.to)
        if (a === undefined || b === undefined) return null
        const forward = b.x > a.x
        const sx = a.x + 170,
          sy = a.y + 34,
          tx = forward ? b.x - 4 : b.x + 170,
          ty = b.y + 34
        const path =
          edge.from === edge.to
            ? `M${sx},${sy} C${sx + 65},${sy - 80} ${sx - 30},${sy - 80} ${sx - 10},${a.y - 4}`
            : forward
              ? `M${sx},${sy} C${sx + 30},${sy} ${tx - 30},${ty} ${tx},${ty}`
              : `M${sx},${sy} C${sx + 52},${sy} ${tx + 52},${ty} ${tx + 4},${ty}`
        return (
          <g key={i}>
            <title>{`${edge.from} → ${edge.to}${edge.label ? `: ${edge.label}` : ''}`}</title>
            <path
              d={path}
              fill="none"
              stroke="var(--ari-fg-subtle)"
              strokeOpacity="0.7"
              strokeWidth="1.5"
              markerEnd={`url(#${marker})`}
            />
            {edge.label && (
              <text
                className="ari-viz-edge-label"
                x={forward ? (sx + tx) / 2 : sx + 32}
                y={(sy + ty) / 2 - 9}
                textAnchor="middle"
              >
                {edge.label.slice(0, 16)}
              </text>
            )}
          </g>
        )
      })}
      {spec.nodes.map((node, i) => {
        const p = positions.get(node.id)
        if (p === undefined) return null
        const label = `${node.label}${node.description ? `: ${node.description}` : ''}`
        const words = node.label.match(/.{1,22}(?:\s|$)|.{1,22}/g) ?? [node.label]
        return (
          <g
            className="ari-viz-mark"
            key={node.id}
            tabIndex={0}
            role="img"
            aria-label={label}
            onFocus={() => inspect(label)}
            onMouseEnter={() => inspect(label)}
          >
            <title>{label}</title>
            <rect
              x={p.x}
              y={p.y}
              width="170"
              height="68"
              rx="8"
              fill="var(--ari-surface-1)"
              stroke="var(--ari-border-strong)"
            />
            <rect x={p.x} y={p.y + 18} width="3" height="32" rx="1.5" fill={color(i)} />
            <text
              className="ari-viz-node-label"
              x={p.x + 85}
              y={p.y + (words.length > 1 ? 28 : 39)}
              textAnchor="middle"
            >
              {words.slice(0, 2).map((word, j) => (
                <tspan key={j} x={p.x + 85} dy={j === 0 ? 0 : 18}>
                  {word.trim()}
                  {j === 1 && words.length > 2 ? '…' : ''}
                </tspan>
              ))}
            </text>
          </g>
        )
      })}
    </svg>
  )
}

export function TimelineDiagram({
  spec,
}: {
  spec: Extract<VisualizationSpec, { type: 'timeline' }>
}) {
  return (
    <ol className="ari-viz-timeline">
      {spec.events.map((event, i) => (
        <li key={i} style={{ '--viz-tone': `var(--ari-${event.tone})` } as CSSProperties}>
          <span className="ari-viz-timeline-dot" />
          {event.date && <span className="ari-viz-date">{event.date}</span>}
          <strong>{event.label}</strong>
          {event.description && <p>{event.description}</p>}
        </li>
      ))}
    </ol>
  )
}

export function GanttDiagram({
  spec,
  inspect,
}: {
  spec: Extract<VisualizationSpec, { type: 'gantt' }>
  inspect: Inspect
}) {
  const [min, max] = domain(spec.tasks.flatMap((task) => [task.start, task.end]))
  const width = 640,
    left = 170,
    plot = 440,
    height = spec.tasks.length * 42 + 70
  const x = (value: number): number => left + ((value - min) / (max - min)) * plot
  return (
    <svg
      className="ari-viz-svg"
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={spec.title}
      style={{ minWidth: 520 }}
    >
      {Array.from({ length: 5 }, (_, i) => (
        <g className="ari-viz-axis" key={i}>
          <line x1={left + (plot * i) / 4} x2={left + (plot * i) / 4} y1="28" y2={height - 24} />
          <text x={left + (plot * i) / 4} y="18" textAnchor="middle">
            {formatNumber(min + ((max - min) * i) / 4)}
          </text>
        </g>
      ))}
      {spec.tasks.map((task, i) => {
        const label = `${task.label}: ${formatNumber(task.start)}–${formatNumber(task.end)}${spec.unit ? ` ${spec.unit}` : ''}`
        return (
          <g key={i}>
            <text className="ari-viz-axis-label" x={left - 14} y={54 + i * 42} textAnchor="end">
              <title>{task.label}</title>
              {task.label.length > 21 ? `${task.label.slice(0, 20)}…` : task.label}
            </text>
            <g
              className="ari-viz-mark"
              tabIndex={0}
              role="img"
              aria-label={label}
              onFocus={() => inspect(label)}
              onMouseEnter={() => inspect(label)}
            >
              <title>{label}</title>
              <rect
                x={x(task.start)}
                y={37 + i * 42}
                width={Math.max(3, x(task.end) - x(task.start))}
                height="26"
                rx="4"
                fill={color(i)}
                fillOpacity="0.8"
              />
            </g>
          </g>
        )
      })}
      {spec.unit && (
        <text className="ari-viz-axis-label" x={left + plot / 2} y={height - 5} textAnchor="middle">
          {spec.unit}
        </text>
      )}
    </svg>
  )
}

export function MetricCards({ spec }: { spec: Extract<VisualizationSpec, { type: 'metrics' }> }) {
  return (
    <dl className="ari-viz-metrics">
      {spec.items.map((item, i) => (
        <div key={i}>
          <dt>{item.label}</dt>
          <dd style={{ color: `var(--ari-${item.tone})` }}>
            {typeof item.value === 'number' ? formatNumber(item.value) : item.value}
          </dd>
          {item.detail && <p>{item.detail}</p>}
        </div>
      ))}
    </dl>
  )
}
