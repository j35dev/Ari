import type { VisualizationSpec } from '@ari/contracts/visualization'
import type { Inspect } from './charts'
import { axis, clipLabel, color, fitLabel, formatNumber, MIN_CHART_WIDTH } from './charts'
import { pointDetail } from './interaction'

type Cartesian = Extract<VisualizationSpec, { labels: string[] }>
export function HorizontalBarsChart({
  spec,
  hidden,
  inspect,
  width: room,
}: {
  spec: Cartesian
  hidden: Set<number>
  inspect: Inspect
  width?: number | null
}) {
  const visible = spec.series
    .map((series, i) => ({ ...series, index: i }))
    .filter((series) => !hidden.has(series.index))
  const {
    extent: [min, max],
    ticks,
  } = axis(
    visible.flatMap((series) => series.values),
    true,
  )
  const axisCaption = spec.yLabel ?? spec.unit
  // Drawn 1:1 in the reply's width; the label column gives way on a phone.
  const width = Math.max(MIN_CHART_WIDTH, Math.floor(room ?? 720)),
    left = Math.min(190, Math.max(96, Math.round(width * 0.28))),
    plot = width - left - 30,
    rowHeight = Math.max(42, visible.length * 12 + 12),
    height = spec.labels.length * rowHeight + 84
  const x = (value: number): number => left + ((value - min) / (max - min)) * plot
  return (
    <svg
      className="ari-viz-svg"
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={spec.title}
      style={{ width, height }}
    >
      <g className="ari-viz-axis">
        {ticks.map((value, i) => (
          <g key={i}>
            <line x1={x(value)} x2={x(value)} y1="20" y2={height - 50} />
            <text x={x(value)} y={height - 30} textAnchor="middle">
              {formatNumber(value)}
            </text>
          </g>
        ))}
        {axisCaption && (
          <text x={left + plot / 2} y={height - 7} textAnchor="middle">
            <title>{axisCaption}</title>
            {clipLabel(fitLabel(axisCaption, plot), 48)}
          </text>
        )}
      </g>
      {spec.labels.map((label, i) => (
        <text
          className="ari-viz-axis-label"
          key={i}
          x={left - 15}
          y={20 + rowHeight * (i + 0.5) + 4}
          textAnchor="end"
        >
          <title>{label}</title>
          {clipLabel(fitLabel(label, left - 24), 24)}
        </text>
      ))}
      {visible.map((series, si) =>
        series.values.map((value, i) => {
          const label = `${series.name} · ${spec.labels[i] ?? ''}: ${formatNumber(value)}${spec.unit ? ` ${spec.unit}` : ''}`,
            barHeight = (rowHeight - 12) / visible.length
          return (
            <g
              className="ari-viz-mark"
              key={`${series.index}:${i}`}
              tabIndex={0}
              role="img"
              aria-label={label}
              data-viz-detail={pointDetail({
                title: spec.labels[i] ?? series.name,
                rows: visible.map((other) => ({
                  label: other.name,
                  value: `${other.values[i] ?? ''}${spec.unit ? ` ${spec.unit}` : ''}`,
                  color: color(other.index),
                })),
              })}
              onFocus={() => inspect(label)}
              onMouseEnter={() => inspect(label)}
            >
              <rect
                x={Math.min(x(0), x(value))}
                y={26 + i * rowHeight + si * barHeight}
                width={Math.max(1, Math.abs(x(value) - x(0)))}
                height={Math.max(3, barHeight - 2)}
                rx="3"
                fill={color(series.index)}
              />
            </g>
          )
        }),
      )}
    </svg>
  )
}
