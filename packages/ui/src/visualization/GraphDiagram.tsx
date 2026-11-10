import { useId, useMemo, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { color, type Inspect } from './charts'
import { CanvasViewport } from './CanvasViewport'
import {
  graphEdgePath,
  layoutGraph,
  NODE_HEIGHT,
  NODE_WIDTH,
  type GraphDirection,
  type GraphSpec,
} from './graph-layout'
import { pointDetail } from './interaction'

/** The canvas frame, padding and scrollbar gutter take this much of the reply's width. */
const CANVAS_INSET = 64

export function GraphDiagram({
  spec,
  inspect,
  width = null,
}: {
  spec: GraphSpec
  inspect: Inspect
  width?: number | null
}) {
  const marker = `viz-arrow-${useId().replace(/:/g, '')}`
  const [chosen, setDirection] = useState<GraphDirection | null>(null)
  const [hovered, setHovered] = useState<string[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  // A left-to-right flow that cannot fit a narrow reply starts top-to-bottom instead.
  const direction = useMemo<GraphDirection>(() => {
    if (chosen !== null) return chosen
    if (width === null || spec.direction !== 'right') return spec.direction
    const room = width - CANVAS_INSET
    return layoutGraph(spec, 'right').width > room && layoutGraph(spec, 'down').width <= room
      ? 'down'
      : 'right'
  }, [chosen, spec, width])
  const layout = useMemo(() => layoutGraph(spec, direction), [spec, direction])
  const names = new Map(spec.nodes.map((node) => [node.id, node.label]))
  const active = selected ? [selected] : hovered
  const related = new Set(active)
  for (const edge of spec.edges)
    if (active.includes(edge.from) || active.includes(edge.to)) {
      related.add(edge.from)
      related.add(edge.to)
    }
  const navigate = (event: KeyboardEvent<SVGGElement>, id: string): void => {
    const a = layout.positions.get(id)
    if (!a || !event.key.startsWith('Arrow')) return
    const candidates = [...layout.positions.entries()]
      .filter(
        ([other, b]) =>
          other !== id &&
          (event.key === 'ArrowRight'
            ? b.x > a.x + 1
            : event.key === 'ArrowLeft'
              ? b.x < a.x - 1
              : event.key === 'ArrowDown'
                ? b.y > a.y + 1
                : b.y < a.y - 1),
      )
      .sort(([, b], [, c]) => {
        const distance = (p: typeof a): number => Math.abs(p.x - a.x) + Math.abs(p.y - a.y)
        return distance(b) - distance(c)
      })
    const next = candidates[0]?.[0]
    if (!next) return
    const node = Array.from(
      event.currentTarget.ownerSVGElement?.querySelectorAll<SVGGElement>('[data-node-id]') ?? [],
    ).find((el) => el.dataset['nodeId'] === next)
    if (!node) return
    event.preventDefault()
    event.stopPropagation()
    node.focus()
    node.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
  }
  const controls = (
    <div className="ari-viz-layout-switch" role="group" aria-label="Diagram direction">
      <button
        type="button"
        aria-pressed={direction === 'right'}
        onClick={() => setDirection('right')}
      >
        Horizontal
      </button>
      <button
        type="button"
        aria-pressed={direction === 'down'}
        onClick={() => setDirection('down')}
      >
        Vertical
      </button>
    </div>
  )
  return (
    <CanvasViewport
      width={layout.width}
      height={layout.height}
      label={spec.title}
      controls={controls}
    >
      <svg
        className="ari-viz-svg ari-viz-graph"
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        role="group"
        aria-label={spec.title}
        onClick={(event) => {
          if (event.target instanceof Element && !event.target.closest('[data-viz-detail]'))
            setSelected(null)
        }}
      >
        <defs>
          {[false, true].map((highlighted) => (
            <marker
              key={String(highlighted)}
              id={`${marker}${highlighted ? '-active' : ''}`}
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path
                d="M0 0 L10 5 L0 10 Z"
                fill={highlighted ? 'var(--ari-accent)' : 'var(--ari-fg-subtle)'}
              />
            </marker>
          ))}
        </defs>
        {spec.edges.map((edge, i) => {
          const a = layout.positions.get(edge.from),
            b = layout.positions.get(edge.to)
          if (!a || !b) return null
          const { path, labelX, labelY } = graphEdgePath(a, b, direction, edge.from === edge.to)
          const highlighted = active.includes(edge.from) || active.includes(edge.to)
          const label = `${names.get(edge.from) ?? edge.from} → ${names.get(edge.to) ?? edge.to}${edge.label ? `: ${edge.label}` : ''}`
          return (
            <g
              key={i}
              className="ari-viz-mark ari-viz-edge"
              role="img"
              aria-label={label}
              tabIndex={0}
              data-viz-detail={pointDetail({
                title: edge.label ?? 'Connection',
                rows: [
                  { label: 'From', value: names.get(edge.from) ?? edge.from },
                  { label: 'To', value: names.get(edge.to) ?? edge.to },
                ],
              })}
              data-active={highlighted ? '' : undefined}
              style={{ opacity: active.length && !highlighted ? 0.2 : 1 }}
              onPointerEnter={() => setHovered([edge.from, edge.to])}
              onPointerLeave={() => setHovered([])}
              onFocus={() => {
                setHovered([edge.from, edge.to])
                inspect(label)
              }}
              onBlur={() => setHovered([])}
            >
              <path
                className="ari-viz-hit-target"
                d={path}
                fill="none"
                stroke="transparent"
                strokeWidth="16"
              />
              <path
                className="ari-viz-edge-path"
                d={path}
                fill="none"
                stroke={highlighted ? 'var(--ari-accent)' : 'var(--ari-fg-subtle)'}
                strokeOpacity={highlighted ? 1 : 0.65}
                strokeWidth={highlighted ? 2 : 1.5}
                markerEnd={`url(#${marker}${highlighted ? '-active' : ''})`}
              />
              {edge.label && (
                <text className="ari-viz-edge-label" x={labelX} y={labelY} textAnchor="middle">
                  {edge.label.length > 18 ? `${edge.label.slice(0, 17)}…` : edge.label}
                </text>
              )}
            </g>
          )
        })}
        {spec.nodes.map((node, i) => {
          const p = layout.positions.get(node.id)
          if (!p) return null
          const label = `${node.label}${node.description ? `: ${node.description}` : ''}`
          const lines = node.label.match(/.{1,23}(?:\s|$)|.{1,23}/g) ?? [node.label]
          const incoming = spec.edges.filter((edge) => edge.to === node.id).length,
            outgoing = spec.edges.filter((edge) => edge.from === node.id).length
          const selectedNode = active.includes(node.id),
            decision = node.shape === 'decision'
          const paint = node.tone ? `var(--ari-${node.tone})` : color(i)
          return (
            <g
              key={node.id}
              className="ari-viz-mark ari-viz-node"
              data-node-id={node.id}
              role="img"
              aria-label={label}
              tabIndex={0}
              data-viz-detail={pointDetail({
                title: node.label,
                description: node.description,
                rows: [
                  { label: 'Incoming connections', value: incoming },
                  { label: 'Outgoing connections', value: outgoing },
                ],
                note: 'Use arrow keys to move between nodes.',
              })}
              data-active={selectedNode ? '' : undefined}
              style={{ opacity: active.length && !related.has(node.id) ? 0.3 : 1 }}
              onPointerEnter={() => setHovered([node.id])}
              onPointerLeave={() => setHovered([])}
              onFocus={() => {
                setHovered([node.id])
                inspect(label)
              }}
              onBlur={() => setHovered([])}
              onClick={() => setSelected((current) => (current === node.id ? null : node.id))}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ')
                  setSelected((current) => (current === node.id ? null : node.id))
                else navigate(event, node.id)
              }}
            >
              {decision ? (
                <polygon
                  className="ari-viz-node-shape"
                  points={`${p.x + NODE_WIDTH / 2},${p.y - 10} ${p.x + NODE_WIDTH + 10},${p.y + NODE_HEIGHT / 2} ${p.x + NODE_WIDTH / 2},${p.y + NODE_HEIGHT + 10} ${p.x - 10},${p.y + NODE_HEIGHT / 2}`}
                  fill="var(--ari-surface-1)"
                  stroke={selectedNode ? paint : 'var(--ari-border-strong)'}
                />
              ) : (
                <rect
                  className="ari-viz-node-shape"
                  x={p.x}
                  y={p.y}
                  width={NODE_WIDTH}
                  height={NODE_HEIGHT}
                  rx={node.shape === 'start' || node.shape === 'end' ? 44 : 10}
                  fill="var(--ari-surface-1)"
                  stroke={selectedNode ? paint : 'var(--ari-border-strong)'}
                />
              )}
              {!decision && (
                <rect x={p.x} y={p.y + 24} width="3" height="40" rx="1.5" fill={paint} />
              )}
              <text
                className="ari-viz-node-label"
                x={p.x + NODE_WIDTH / 2}
                y={p.y + (node.description && !decision ? 33 : lines.length > 1 ? 37 : 49)}
                textAnchor="middle"
              >
                {lines.slice(0, 2).map((line, j) => (
                  <tspan key={j} x={p.x + NODE_WIDTH / 2} dy={j ? 18 : 0}>
                    {line.trim()}
                    {j === 1 && lines.length > 2 ? '…' : ''}
                  </tspan>
                ))}
              </text>
              {node.description && !decision && (
                <text
                  className="ari-viz-node-description"
                  x={p.x + NODE_WIDTH / 2}
                  y={p.y + (lines.length > 1 ? 71 : 60)}
                  textAnchor="middle"
                >
                  {node.description.length > 27
                    ? `${node.description.slice(0, 26)}…`
                    : node.description}
                </text>
              )}
            </g>
          )
        })}
      </svg>
    </CanvasViewport>
  )
}
