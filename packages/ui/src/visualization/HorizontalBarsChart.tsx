import type { VisualizationSpec } from '@ari/contracts/visualization'
import type { Inspect } from './charts'
import {
  axis,
  barPath,
  clipLabel,
  color,
  fitLabel,
  formatNumber,
  GAP,
  MIN_CHART_WIDTH,
  textWidth,
} from './charts'
import { pointDetail } from './interaction'

type Cartesian = Extract<VisualizationSpec, { labels: string[] }>

const TOP = 6
/** Tick labels, and the axis title under them when there is one. */
const foot = (caption: string | undefined): number => (caption ? 46 : 26)

/**
 * Ranked rows: the label on the left, a thin bar, and for a single series the
 * value at the bar's tip. The chart is as tall as its rows, never scrolled.
 */
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
  const single = visible.length === 1
  const unit = spec.unit ? ` ${spec.unit}` : ''
  // Drawn 1:1 in the reply's width; the label column gives way on a phone.
  const width = Math.max(MIN_CHART_WIDTH, Math.floor(room ?? 720))
  const longest = Math.max(...spec.labels.map((label) => textWidth(label)))
  const left = Math.min(Math.round(width * 0.34), Math.max(64, Math.ceil(longest) + 16))
  // A single series prints its values at the tips, so the plot leaves room for the widest.
  const tipRoom = single
    ? Math.max(...(visible[0]?.values ?? [0]).map((v) => textWidth(formatNumber(v), 11))) + 12
    : 14
  const plot = Math.max(80, width - left - tipRoom)
  const thickness = single ? 14 : 10
  const rowHeight = single ? 28 : visible.length * (thickness + GAP) + 14
  const bottom = foot(axisCaption)
  const height = TOP + spec.labels.length * rowHeight + bottom
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
            <line
              className={value === 0 ? 'ari-viz-baseline' : undefined}
              x1={x(value)}
              x2={x(value)}
              y1={TOP}
              y2={height - bottom}
            />
            <text x={x(value)} y={height - bottom + 16} textAnchor="middle">
              {formatNumber(value)}
            </text>
          </g>
        ))}
        {axisCaption && (
          <text x={left + plot / 2} y={height - 8} textAnchor="middle">
            <title>{axisCaption}</title>
            {clipLabel(fitLabel(axisCaption, plot), 48)}
          </text>
        )}
      </g>
      {spec.labels.map((label, i) => (
        <text
          className="ari-viz-axis-label"
          key={i}
          x={left - 10}
          y={TOP + rowHeight * (i + 0.5) + 4}
          textAnchor="end"
        >
          <title>{label}</title>
          {fitLabel(label, left - 16)}
        </text>
      ))}
      {visible.map((series, si) =>
        series.values.map((value, i) => {
          const printed = formatNumber(value)
          const label = `${series.name} · ${spec.labels[i] ?? ''}: ${printed}${unit}`
          const rowTop = TOP + i * rowHeight
          const stack = visible.length * (thickness + GAP) - GAP
          const top = rowTop + (rowHeight - stack) / 2 + si * (thickness + GAP)
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
                  value: `${other.values[i] ?? ''}${unit}`,
                  color: color(other.index),
                })),
              })}
              onFocus={() => inspect(label)}
              onMouseEnter={() => inspect(label)}
            >
              {/* The whole row answers the pointer, not just the bar inside it. */}
              <rect
                className="ari-viz-hit-target"
                x={left}
                y={single ? rowTop : top - GAP / 2}
                width={plot + tipRoom}
                height={single ? rowHeight : thickness + GAP}
                fill="transparent"
              />
              <path
                className="ari-viz-shape"
                d={barPath(top, x(0), x(value), thickness, false)}
                fill={color(series.index)}
              />
              {single && (
                <text
                  className="ari-viz-value-label"
                  // Below zero the bar runs left, so its value sits clear of it past the zero line.
                  x={Math.max(x(0), x(value)) + 6}
                  y={top + thickness / 2 + 4}
                >
                  {printed}
                </text>
              )}
            </g>
          )
        }),
      )}
    </svg>
  )
}
