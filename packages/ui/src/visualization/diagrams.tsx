import type { CSSProperties } from 'react'
import type { VisualizationSpec } from '@ari/contracts/visualization'
import {
  axis,
  color,
  fitLabel,
  formatNumber,
  MIN_CHART_WIDTH,
  textWidth,
  type Inspect,
} from './charts'
import { pointDetail } from './interaction'

const toneColor = (tone: string): string => `var(--ari-${tone})`

export function TimelineDiagram({
  spec,
}: {
  spec: Extract<VisualizationSpec, { type: 'timeline' }>
}) {
  return (
    <ol className="ari-viz-timeline">
      {spec.events.map((event, i) => (
        <li
          key={i}
          className="ari-viz-mark"
          tabIndex={0}
          data-tone={event.tone}
          data-viz-detail={pointDetail({
            title: event.label,
            description: event.description,
            rows: event.date ? [{ label: 'When', value: event.date }] : [],
          })}
          style={{ '--viz-tone': toneColor(event.tone) } as CSSProperties}
        >
          <span className="ari-viz-timeline-dot" />
          {event.date && <span className="ari-viz-date">{event.date}</span>}
          <strong className="ari-viz-timeline-label">{event.label}</strong>
          {event.description && <p>{event.description}</p>}
        </li>
      ))}
    </ol>
  )
}

const ROW = 30,
  BAR = 12,
  HEAD = 26

/** A schedule drawn to the reply's width: one thin bar per task on a shared scale. */
export function GanttDiagram({
  spec,
  inspect,
  width: room,
}: {
  spec: Extract<VisualizationSpec, { type: 'gantt' }>
  inspect: Inspect
  width?: number | null
}) {
  const extent = axis(spec.tasks.flatMap((task) => [task.start, task.end]))
  const [min, max] = extent.extent
  const unit = spec.unit ? ` ${spec.unit}` : ''
  const width = Math.min(1000, Math.max(MIN_CHART_WIDTH, Math.floor(room ?? 704)))
  const longest = Math.max(...spec.tasks.map((task) => textWidth(task.label)))
  const left = Math.min(Math.round(width * 0.34), Math.max(64, Math.ceil(longest) + 16))
  const plot = width - left - 16
  const foot = spec.unit ? 26 : 8
  const height = HEAD + spec.tasks.length * ROW + foot
  const x = (value: number): number => left + ((value - min) / (max - min)) * plot
  return (
    <svg
      className="ari-viz-svg"
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={spec.title}
      style={{ width, height }}
    >
      {extent.ticks.map((value, i) => (
        <g className="ari-viz-axis" key={i}>
          <line x1={x(value)} x2={x(value)} y1={HEAD} y2={height - foot} />
          <text x={x(value)} y="14" textAnchor="middle">
            {formatNumber(value)}
          </text>
        </g>
      ))}
      {spec.tasks.map((task, i) => {
        const label = `${task.label}: ${formatNumber(task.start)}–${formatNumber(task.end)}${unit}`
        const top = HEAD + i * ROW
        return (
          <g key={i}>
            <text
              className="ari-viz-axis-label"
              x={left - 10}
              y={top + ROW / 2 + 4}
              textAnchor="end"
            >
              <title>{task.label}</title>
              {fitLabel(task.label, left - 16)}
            </text>
            <g
              className="ari-viz-mark"
              tabIndex={0}
              role="img"
              aria-label={label}
              data-viz-detail={pointDetail({
                title: task.label,
                rows: [
                  { label: 'Start', value: `${task.start}${unit}`, color: color(0) },
                  { label: 'End', value: `${task.end}${unit}` },
                  { label: 'Duration', value: `${task.end - task.start}${unit}` },
                ],
              })}
              onFocus={() => inspect(label)}
              onMouseEnter={() => inspect(label)}
            >
              <title>{label}</title>
              <rect
                className="ari-viz-hit-target"
                x={left}
                y={top}
                width={plot}
                height={ROW}
                fill="transparent"
              />
              {/* Tasks are one kind of thing, so they share one colour. */}
              <rect
                className="ari-viz-shape"
                x={x(task.start)}
                y={top + (ROW - BAR) / 2}
                width={Math.max(4, x(task.end) - x(task.start))}
                height={BAR}
                rx="4"
                fill={color(0)}
              />
            </g>
          </g>
        )
      })}
      {spec.unit && (
        <text className="ari-viz-axis-label" x={left + plot / 2} y={height - 8} textAnchor="middle">
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
        <div
          key={i}
          className="ari-viz-mark"
          tabIndex={0}
          data-tone={item.tone}
          data-viz-detail={pointDetail({
            title: item.label,
            description: item.detail,
            rows: [{ label: 'Value', value: item.value, color: toneColor(item.tone) }],
          })}
          style={{ '--viz-tone': toneColor(item.tone) } as CSSProperties}
        >
          <dt className="ari-viz-metric-label">
            {/* The figure stays in text ink. `accent` is what an unmarked metric gets, so
                only a tone the agent chose shows, as a dot beside the label. */}
            {item.tone !== 'accent' && <span className="ari-viz-tone-dot" />}
            {item.label}
          </dt>
          <dd>{typeof item.value === 'number' ? formatNumber(item.value) : item.value}</dd>
          {item.detail && <p>{item.detail}</p>}
        </div>
      ))}
    </dl>
  )
}
