import type { CSSProperties } from 'react'
import type { VisualizationSpec } from '@ari/contracts/visualization'
import { axis, color, formatNumber, type Inspect } from './charts'
import { pointDetail } from './interaction'
import { CanvasViewport } from './CanvasViewport'

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
          data-viz-detail={pointDetail({
            title: event.label,
            description: event.description,
            rows: event.date ? [{ label: 'When', value: event.date }] : [],
          })}
          style={{ '--viz-tone': `var(--ari-${event.tone})` } as CSSProperties}
        >
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
  const extent = axis(spec.tasks.flatMap((task) => [task.start, task.end]))
  const [min, max] = extent.extent
  const width = 640,
    left = 170,
    plot = 440,
    height = spec.tasks.length * 42 + 70
  const x = (value: number): number => left + ((value - min) / (max - min)) * plot
  return (
    <CanvasViewport width={width} height={height} label={spec.title}>
      <svg
        className="ari-viz-svg"
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={spec.title}
      >
        {extent.ticks.map((value, i) => (
          <g className="ari-viz-axis" key={i}>
            <line x1={x(value)} x2={x(value)} y1="28" y2={height - 24} />
            <text x={x(value)} y="18" textAnchor="middle">
              {formatNumber(value)}
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
                data-viz-detail={pointDetail({
                  title: task.label,
                  rows: [
                    {
                      label: 'Start',
                      value: `${task.start}${spec.unit ? ` ${spec.unit}` : ''}`,
                      color: color(i),
                    },
                    { label: 'End', value: `${task.end}${spec.unit ? ` ${spec.unit}` : ''}` },
                    {
                      label: 'Duration',
                      value: `${task.end - task.start}${spec.unit ? ` ${spec.unit}` : ''}`,
                    },
                  ],
                })}
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
          <text
            className="ari-viz-axis-label"
            x={left + plot / 2}
            y={height - 5}
            textAnchor="middle"
          >
            {spec.unit}
          </text>
        )}
      </svg>
    </CanvasViewport>
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
          data-viz-detail={pointDetail({
            title: item.label,
            description: item.detail,
            rows: [{ label: 'Value', value: item.value, color: `var(--ari-${item.tone})` }],
          })}
        >
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
