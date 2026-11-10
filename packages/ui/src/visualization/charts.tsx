import type { CSSProperties, ReactNode } from 'react'
import type { VisualizationSpec } from '@ari/contracts/visualization'
import { pointDetail, type PointDetail } from './interaction'

export const seriesColors = [
  'accent',
  'info',
  'success',
  'warning',
  'busy',
  'danger',
  'fg-muted',
  'accent-hover',
] as const
export const color = (index: number): string =>
  `var(--ari-${seriesColors[index % seriesColors.length] ?? 'accent'})`
export const formatNumber = (value: number): string =>
  new Intl.NumberFormat(undefined, {
    maximumSignificantDigits: 4,
    notation:
      Math.abs(value) >= 10_000
        ? 'compact'
        : value !== 0 && Math.abs(value) < 0.001
          ? 'scientific'
          : 'standard',
  }).format(value)
export const clipLabel = (text: string, max = 16): string =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text
const short = clipLabel
/** A conservative width for UI text, so clipped labels stay clear of their neighbors. */
export const textWidth = (text: string, size = 12): number => text.length * size * 0.6
/** Clip a label to the pixels it may occupy at the chart's actual rendered size. */
export const fitLabel = (text: string, room: number, size = 12): string =>
  clipLabel(text, Math.max(3, Math.floor(room / (size * 0.6))))
const clamp = (value: number, low: number, high: number): number =>
  Math.min(Math.max(value, low), Math.max(low, high))
/**
 * Charts draw at 1:1 in the width the reply gives them. Stretching a fixed
 * viewBox made text huge on desktop and unreadably small on a phone.
 */
export const MIN_CHART_WIDTH = 280
const available = (width: number | null | undefined, fallback: number): number =>
  Math.max(MIN_CHART_WIDTH, Math.floor(width ?? fallback))
/** Cell width fills the space for few columns and stays wide enough to scroll many. */
export const heatCellWidth = (columnCount: number, room = 500): number =>
  clamp(room / columnCount, 52, 140)
/**
 * Zero is a neutral full-opacity cell. Other cells share one theme color, so
 * opacity has to cover most of the 0–1 range or a large value looks like a small one.
 */
export function heatFillOpacity(value: number, peak: number): number {
  if (value === 0) return 1
  const scale = Math.max(Math.abs(peak), 1e-300)
  return 0.24 + Math.min(1, Math.abs(value) / scale) * 0.68
}
/** 13px digits need about 7px each, plus the cell's inset, before they collide. */
export function heatShowsValue(printed: string, cellWidth: number): boolean {
  return printed.length * 7 <= cellWidth - 8
}
const W = 640,
  H = 320,
  L = 68,
  R = 24,
  T = 28,
  B = 54
const PH = H - T - B

export type Inspect = (text: string) => void
function Mark({
  label,
  inspect,
  children,
  detail,
}: {
  label: string
  inspect: Inspect
  children: ReactNode
  detail?: PointDetail
}) {
  return (
    <g
      className="ari-viz-mark"
      tabIndex={0}
      role="img"
      aria-label={label}
      data-viz-detail={pointDetail(detail ?? { title: label })}
      onFocus={() => inspect(label)}
      onMouseEnter={() => inspect(label)}
    >
      <title>{label}</title>
      {children}
    </g>
  )
}
export function domain(values: number[], zero = false): [number, number] {
  let min = Math.min(...values),
    max = Math.max(...values)
  if (zero) {
    min = Math.min(0, min)
    max = Math.max(0, max)
  }
  if (min === max) {
    const pad = Math.max(Math.abs(min) * 0.1, 1)
    min -= pad
    max += pad
  }
  return [min, max]
}

/** Round only the axis extent; marks and the data view retain original values. */
export function axis(
  values: number[],
  zero = false,
): { extent: [number, number]; ticks: number[] } {
  const [min, max] = domain(values, zero)
  const rough = (max - min) / 4
  const power = 10 ** Math.floor(Math.log10(rough)) || Number.MIN_VALUE
  const step = ([1, 2, 2.5, 5, 10].find((factor) => factor * power >= rough) ?? 10) * power
  const low = Math.floor(min / step) * step,
    high = Math.ceil(max / step) * step
  const count = Math.min(8, Math.round((high - low) / step))
  return {
    extent: [low, high],
    ticks: Array.from({ length: count + 1 }, (_, i) => Number((low + i * step).toPrecision(12))),
  }
}
const scale = (value: number, [min, max]: [number, number], size: number): number =>
  ((value - min) / (max - min)) * size

function Axes({
  yDomain,
  ticks,
  xLabel,
  yLabel,
  width = W,
}: {
  yDomain: [number, number]
  ticks: number[]
  xLabel?: string
  yLabel?: string
  width?: number
}) {
  return (
    <g className="ari-viz-axis">
      {ticks.map((value, i) => {
        const y = T + PH - scale(value, yDomain, PH)
        return (
          <g key={i}>
            <line x1={L} x2={width - R} y1={y} y2={y} />
            <text x={L - 12} y={y + 4} textAnchor="end">
              {formatNumber(value)}
            </text>
          </g>
        )
      })}
      {xLabel && (
        <text x={L + (width - L - R) / 2} y={H - 5} textAnchor="middle">
          {short(fitLabel(xLabel, width - L - R), 60)}
        </text>
      )}
      {yLabel && (
        <text x={L} y={15}>
          {short(fitLabel(yLabel, width - L - R), 60)}
        </text>
      )}
    </g>
  )
}

type Cartesian = Extract<VisualizationSpec, { labels: string[] }>
export function CartesianChart({
  spec,
  hidden,
  inspect,
  width,
}: {
  spec: Cartesian
  hidden: Set<number>
  inspect: Inspect
  width?: number | null
}) {
  const visible = spec.series
    .map((s, i) => ({ ...s, index: i }))
    .filter((s) => !hidden.has(s.index))
  const ya = axis(
    visible.flatMap((s) => s.values),
    true,
  )
  const yd = ya.extent
  const count = spec.labels.length
  const bar = spec.type === 'bar'
  // Many categories scroll sideways rather than squeezing labels into each other.
  const minStep = bar ? Math.max(48, visible.length * 18 + 16) : 64
  const chartWidth = Math.max(available(width, W), L + R + count * minStep)
  const plotWidth = chartWidth - L - R
  const y = (value: number): number => T + PH - scale(value, yd, PH)
  const step = bar ? plotWidth / count : count > 1 ? plotWidth / (count - 1) : plotWidth
  const x = (i: number): number =>
    bar ? L + step * (i + 0.5) : L + (count === 1 ? plotWidth / 2 : step * i)
  const baseline = y(0)
  const group = Math.min(step * 0.72, visible.length * 56)
  const barWidth = group / Math.max(1, visible.length)
  return (
    <svg
      className="ari-viz-svg"
      viewBox={`0 0 ${chartWidth} ${H}`}
      role="img"
      aria-label={spec.title}
      style={{ width: chartWidth, height: H }}
    >
      <Axes
        yDomain={yd}
        ticks={ya.ticks}
        width={chartWidth}
        xLabel={spec.xLabel}
        yLabel={spec.yLabel ?? spec.unit}
      />
      {spec.labels.map((label, i) => {
        // A line's end labels sit on the plot edge, so they get half a step plus the margin.
        const edge = !bar && count > 1 && (i === 0 || i === count - 1)
        const room = edge ? step / 2 + (i === 0 ? L : R) - 8 : step - 10
        const text = fitLabel(label, Math.min(room, 200))
        const half = textWidth(text) / 2
        return (
          <text
            className="ari-viz-axis-label"
            key={i}
            x={clamp(x(i), half + 2, chartWidth - half - 2)}
            y={H - B + 22}
            textAnchor="middle"
          >
            <title>{label}</title>
            {text}
          </text>
        )
      })}
      {visible.map((s, si) => {
        const points = s.values.map((value, i) => `${x(i)},${y(value)}`).join(' ')
        return (
          <g key={s.index} style={{ '--viz-color': color(s.index) } as CSSProperties}>
            {spec.type === 'area' && (
              <polygon
                points={`${x(0)},${baseline} ${points} ${x(s.values.length - 1)},${baseline}`}
                fill="var(--viz-color)"
                opacity="0.12"
              />
            )}
            {spec.type !== 'bar' && (
              <polyline
                points={points}
                fill="none"
                stroke="var(--viz-color)"
                strokeWidth="2.5"
                strokeLinejoin="round"
              />
            )}
            {s.values.map((value, i) => (
              <Mark
                key={i}
                label={`${s.name} · ${spec.labels[i] ?? ''}: ${formatNumber(value)}${spec.unit ? ` ${spec.unit}` : ''}`}
                inspect={inspect}
                detail={{
                  title: spec.labels[i] ?? s.name,
                  rows: visible.map((series) => ({
                    label: series.name,
                    value: `${series.values[i] ?? ''}${spec.unit ? ` ${spec.unit}` : ''}`,
                    color: color(series.index),
                  })),
                }}
              >
                <line className="ari-viz-crosshair" x1={x(i)} x2={x(i)} y1={T} y2={H - B} />
                {spec.type !== 'bar' && (
                  <circle
                    className="ari-viz-hit-target"
                    cx={x(i)}
                    cy={y(value)}
                    r="13"
                    fill="transparent"
                  />
                )}
                {spec.type === 'bar' ? (
                  <rect
                    x={x(i) - group / 2 + si * barWidth + 1}
                    y={Math.min(baseline, y(value))}
                    width={Math.max(1, barWidth - 2)}
                    height={Math.max(1, Math.abs(baseline - y(value)))}
                    rx="3"
                    fill="var(--viz-color)"
                  />
                ) : (
                  <circle
                    cx={x(i)}
                    cy={y(value)}
                    r="4.5"
                    fill="var(--viz-color)"
                    stroke="var(--ari-surface-0)"
                    strokeWidth="2"
                  />
                )}
              </Mark>
            ))}
          </g>
        )
      })}
    </svg>
  )
}

export function ScatterChart({
  spec,
  hidden,
  inspect,
  width,
}: {
  spec: Extract<VisualizationSpec, { type: 'scatter' }>
  hidden: Set<number>
  inspect: Inspect
  width?: number | null
}) {
  const visible = spec.series
    .map((s, i) => ({ ...s, index: i }))
    .filter((s) => !hidden.has(s.index))
  const xa = axis(visible.flatMap((s) => s.points.map((p) => p.x)))
  const ya = axis(visible.flatMap((s) => s.points.map((p) => p.y)))
  const xd = xa.extent,
    yd = ya.extent
  const chartWidth = available(width, W)
  const PW = chartWidth - L - R
  return (
    <svg
      className="ari-viz-svg"
      viewBox={`0 0 ${chartWidth} ${H}`}
      role="img"
      aria-label={spec.title}
      style={{ width: chartWidth, height: H }}
    >
      <Axes
        yDomain={yd}
        ticks={ya.ticks}
        width={chartWidth}
        xLabel={spec.xLabel}
        yLabel={spec.yLabel}
      />
      {xa.ticks.map((value, i) => {
        const text = formatNumber(value)
        const half = textWidth(text) / 2
        return (
          <text
            className="ari-viz-axis-label"
            key={i}
            x={clamp(L + scale(value, xd, PW), half + 2, chartWidth - half - 2)}
            y={H - B + 22}
            textAnchor="middle"
          >
            {text}
          </text>
        )
      })}
      {visible.map((s) => (
        <g key={s.index}>
          {s.points.map((p, i) => (
            <Mark
              key={i}
              label={`${s.name}${p.label ? ` · ${p.label}` : ''}: ${spec.xLabel ?? 'x'} ${formatNumber(p.x)}, ${spec.yLabel ?? 'y'} ${formatNumber(p.y)}`}
              inspect={inspect}
              detail={{
                title: p.label ?? s.name,
                rows: [
                  { label: 'Series', value: s.name, color: color(s.index) },
                  { label: spec.xLabel ?? 'X', value: p.x },
                  { label: spec.yLabel ?? 'Y', value: p.y },
                ],
              }}
            >
              <circle
                className="ari-viz-hit-target"
                cx={L + scale(p.x, xd, PW)}
                cy={T + PH - scale(p.y, yd, PH)}
                r="14"
                fill="transparent"
              />
              <circle
                cx={L + scale(p.x, xd, PW)}
                cy={T + PH - scale(p.y, yd, PH)}
                r="6"
                fill={color(s.index)}
                fillOpacity="0.8"
                stroke="var(--ari-surface-0)"
                strokeWidth="1.5"
              />
            </Mark>
          ))}
        </g>
      ))}
    </svg>
  )
}

export function RadarChart({
  spec,
  hidden,
  inspect,
  width,
}: {
  spec: Cartesian
  hidden: Set<number>
  inspect: Inspect
  width?: number | null
}) {
  const visible = spec.series
    .map((s, i) => ({ ...s, index: i }))
    .filter((s) => !hidden.has(s.index))
  const max = Math.max(1, ...visible.flatMap((s) => s.values))
  // The web keeps room for side labels; narrow replies shrink the web, never the text.
  const chartWidth = Math.min(640, available(width, 640))
  const radius = clamp((chartWidth / 2 - 96) / 1.22, 56, 110)
  const center = [chartWidth / 2, radius * 1.22 + 32] as const
  const chartHeight = center[1] + radius * 1.22 + 44
  const labelRoom = chartWidth / 2 - radius * 1.22 - 10
  const point = (i: number, fraction: number): [number, number] => {
    const angle = (i * Math.PI * 2) / spec.labels.length - Math.PI / 2
    return [
      center[0] + Math.cos(angle) * radius * fraction,
      center[1] + Math.sin(angle) * radius * fraction,
    ]
  }
  return (
    <svg
      className="ari-viz-svg"
      viewBox={`0 0 ${chartWidth} ${chartHeight}`}
      role="img"
      aria-label={spec.title}
      style={{ width: chartWidth, height: chartHeight, margin: '0 auto' }}
    >
      {[0.25, 0.5, 0.75, 1].map((f) => (
        <polygon
          className="ari-viz-radar-grid"
          key={f}
          points={spec.labels.map((_, i) => point(i, f).join(',')).join(' ')}
        />
      ))}
      {spec.labels.map((label, i) => {
        const p = point(i, 1),
          l = point(i, 1.22)
        return (
          <g key={i}>
            <line className="ari-viz-grid" x1={center[0]} y1={center[1]} x2={p[0]} y2={p[1]} />
            <text
              className="ari-viz-axis-label"
              x={l[0]}
              y={l[1] + 4}
              textAnchor={
                l[0] < center[0] - 20 ? 'end' : l[0] > center[0] + 20 ? 'start' : 'middle'
              }
            >
              <title>{label}</title>
              {short(
                fitLabel(label, Math.abs(l[0] - center[0]) < 20 ? chartWidth - 20 : labelRoom),
                20,
              )}
            </text>
          </g>
        )
      })}
      {visible.map((s) => (
        <g key={s.index}>
          <polygon
            points={s.values.map((v, i) => point(i, v / max).join(',')).join(' ')}
            fill={color(s.index)}
            fillOpacity="0.1"
            stroke={color(s.index)}
            strokeWidth="2"
          />
          {s.values.map((v, i) => {
            const p = point(i, v / max)
            return (
              <Mark
                key={i}
                label={`${s.name} · ${spec.labels[i] ?? ''}: ${formatNumber(v)}${spec.unit ? ` ${spec.unit}` : ''}`}
                inspect={inspect}
                detail={{
                  title: spec.labels[i] ?? s.name,
                  rows: visible.map((series) => ({
                    label: series.name,
                    value: `${series.values[i] ?? ''}${spec.unit ? ` ${spec.unit}` : ''}`,
                    color: color(series.index),
                  })),
                }}
              >
                <circle
                  className="ari-viz-hit-target"
                  cx={p[0]}
                  cy={p[1]}
                  r="12"
                  fill="transparent"
                />
                <circle cx={p[0]} cy={p[1]} r="4" fill={color(s.index)} />
              </Mark>
            )
          })}
        </g>
      ))}
      <text className="ari-viz-axis-label" x={center[0]} y={chartHeight - 12} textAnchor="middle">
        Scale 0–{formatNumber(max)}
        {spec.unit ? ` ${spec.unit}` : ''}
      </text>
    </svg>
  )
}

type Parts = Extract<VisualizationSpec, { items: { label: string; value: number }[] }>
export function PartsChart({ spec, inspect }: { spec: Parts; inspect: Inspect }) {
  const total = spec.items.reduce((sum, item) => sum + item.value, 0)
  let offset = 0
  return (
    <div className="ari-viz-parts">
      <svg className="ari-viz-svg" viewBox="0 0 320 280" role="img" aria-label={spec.title}>
        {spec.items.map((item, i) => {
          const fraction = item.value / total,
            start = offset
          offset += fraction
          const a = start * Math.PI * 2 - Math.PI / 2,
            b = offset * Math.PI * 2 - Math.PI / 2
          const path = `M160,140 L${160 + Math.cos(a) * 102},${140 + Math.sin(a) * 102} A102,102 0 ${fraction > 0.5 ? 1 : 0},1 ${160 + Math.cos(b) * 102},${140 + Math.sin(b) * 102} Z`
          return (
            <Mark
              key={i}
              label={`${item.label}: ${formatNumber(item.value)}${spec.unit ? ` ${spec.unit}` : ''} (${formatNumber(fraction * 100)}%)`}
              inspect={inspect}
              detail={{
                title: item.label,
                rows: [
                  { label: spec.unit ?? 'Value', value: item.value, color: color(i) },
                  { label: 'Share of total', value: `${formatNumber(fraction * 100)}%` },
                  { label: 'Total', value: total },
                ],
              }}
            >
              {spec.type === 'donut' ? (
                <circle
                  cx="160"
                  cy="140"
                  r="82"
                  fill="none"
                  stroke={color(i)}
                  strokeWidth="40"
                  strokeDasharray={`${fraction * 2 * Math.PI * 82} ${2 * Math.PI * 82}`}
                  strokeDashoffset={-start * 2 * Math.PI * 82}
                  transform="rotate(-90 160 140)"
                />
              ) : fraction === 1 ? (
                <circle cx="160" cy="140" r="102" fill={color(i)} />
              ) : fraction > 0 ? (
                <path d={path} fill={color(i)} stroke="var(--ari-surface-0)" strokeWidth="2" />
              ) : null}
            </Mark>
          )
        })}
        {spec.type === 'donut' && (
          <g>
            <text className="ari-viz-total" x="160" y="140" textAnchor="middle">
              {formatNumber(total)}
            </text>
            <text className="ari-viz-axis-label" x="160" y="161" textAnchor="middle">
              <title>{spec.unit ?? 'Total'}</title>
              {short(spec.unit ?? 'Total', 16)}
            </text>
          </g>
        )}
      </svg>
      <div className="ari-viz-item-legend">
        {spec.items.map((item, i) => (
          <button
            type="button"
            key={i}
            className="ari-viz-mark"
            data-viz-detail={pointDetail({
              title: item.label,
              rows: [
                { label: spec.unit ?? 'Value', value: item.value, color: color(i) },
                { label: 'Share of total', value: `${formatNumber((item.value / total) * 100)}%` },
              ],
            })}
            onFocus={() => inspect(`${item.label}: ${item.value}`)}
          >
            <span className="ari-viz-swatch" style={{ background: color(i) }} />
            <span className="ari-viz-legend-label">{item.label}</span>
            <strong>{formatNumber(item.value)}</strong>
          </button>
        ))}
      </div>
    </div>
  )
}

export function FunnelChart({ spec, inspect }: { spec: Parts; inspect: Inspect }) {
  const max = Math.max(...spec.items.map((item) => item.value))
  return (
    <div className="ari-viz-funnel">
      {spec.items.map((item, i) => (
        <div className="ari-viz-funnel-row" key={i}>
          <span className="ari-viz-funnel-label">{item.label}</span>
          <div className="ari-viz-funnel-track">
            <button
              type="button"
              className="ari-viz-mark"
              data-viz-detail={pointDetail({
                title: item.label,
                rows: [
                  { label: spec.unit ?? 'Value', value: item.value, color: color(i) },
                  { label: 'Of largest step', value: `${formatNumber((item.value / max) * 100)}%` },
                  ...(i > 0 && (spec.items[i - 1]?.value ?? 0) > 0
                    ? [
                        {
                          label: 'Change from previous',
                          value: `${formatNumber((item.value / (spec.items[i - 1]?.value ?? 1) - 1) * 100)}%`,
                        },
                      ]
                    : []),
                ],
              })}
              aria-label={`${item.label}: ${formatNumber(item.value)}${spec.unit ? ` ${spec.unit}` : ''}`}
              onFocus={() =>
                inspect(
                  `${item.label}: ${formatNumber(item.value)}${spec.unit ? ` ${spec.unit}` : ''}`,
                )
              }
              onMouseEnter={() =>
                inspect(
                  `${item.label}: ${formatNumber(item.value)}${spec.unit ? ` ${spec.unit}` : ''}`,
                )
              }
              style={{ width: `${Math.max(1, (item.value / max) * 100)}%`, background: color(i) }}
            />
          </div>
          <strong>{formatNumber(item.value)}</strong>
        </div>
      ))}
    </div>
  )
}

/** Slice-and-dice subdivision preserves item area, including very small values. */
export function TreemapChart({
  spec,
  inspect,
  width,
}: {
  spec: Parts
  inspect: Inspect
  width?: number | null
}) {
  const mapWidth = available(width, 600),
    mapHeight = 280
  const items = spec.items
    .map((item, i) => ({ ...item, index: i }))
    .filter((item) => item.value > 0)
    .sort((a, b) => b.value - a.value)
  const boxes: { x: number; y: number; w: number; h: number; item: (typeof items)[number] }[] = []
  const divide = (list: typeof items, x: number, y: number, w: number, h: number): void => {
    const first = list[0]
    if (first === undefined) return
    if (list.length === 1) {
      boxes.push({ x, y, w, h, item: first })
      return
    }
    const total = list.reduce((sum, item) => sum + item.value, 0)
    let partial = first.value,
      split = 1
    while (split < list.length - 1 && partial < total / 2) {
      partial += list[split]?.value ?? 0
      split++
    }
    const f = partial / total
    if (w >= h) {
      divide(list.slice(0, split), x, y, w * f, h)
      divide(list.slice(split), x + w * f, y, w * (1 - f), h)
    } else {
      divide(list.slice(0, split), x, y, w, h * f)
      divide(list.slice(split), x, y + h * f, w, h * (1 - f))
    }
  }
  divide(items, 0, 0, mapWidth, mapHeight)
  return (
    <svg
      className="ari-viz-svg"
      viewBox={`0 0 ${mapWidth} ${mapHeight}`}
      role="img"
      aria-label={spec.title}
      style={{ width: mapWidth, height: mapHeight }}
    >
      {boxes.map(({ x, y, w, h, item }) => (
        <Mark
          key={item.index}
          label={`${item.label}: ${formatNumber(item.value)}${spec.unit ? ` ${spec.unit}` : ''}`}
          inspect={inspect}
          detail={{
            title: item.label,
            rows: [
              { label: spec.unit ?? 'Value', value: item.value, color: color(item.index) },
              {
                label: 'Share of total',
                value: `${formatNumber((item.value / spec.items.reduce((sum, part) => sum + part.value, 0)) * 100)}%`,
              },
            ],
          }}
        >
          <rect
            x={x + 1}
            y={y + 1}
            width={Math.max(0, w - 2)}
            height={Math.max(0, h - 2)}
            rx="3"
            fill={color(item.index)}
            fillOpacity="0.16"
            stroke={color(item.index)}
            strokeOpacity="0.5"
          />
          {w > 56 && h > 34 && (
            <text className="ari-viz-treemap-label" x={x + 10} y={y + 22}>
              {fitLabel(item.label, w - 20, 13)}
            </text>
          )}
          {w > 56 && h > 54 && (
            <text className="ari-viz-axis-label" x={x + 10} y={y + 42}>
              {formatNumber(item.value)}
            </text>
          )}
        </Mark>
      ))}
    </svg>
  )
}

export function HeatmapChart({
  spec,
  inspect,
  width,
}: {
  spec: Extract<VisualizationSpec, { type: 'heatmap' }>
  inspect: Inspect
  width?: number | null
}) {
  const values = spec.values.flat()
  const min = Math.min(...values),
    max = Math.max(...values),
    peak = Math.max(...values.map(Math.abs))
  const room = available(width, 632)
  const left = room < 480 ? 96 : 120,
    cw = heatCellWidth(spec.xLabels.length, room - left - 12),
    ch = 42,
    top = 38
  const mapWidth = left + cw * spec.xLabels.length + 12,
    mapHeight = top + ch * spec.yLabels.length + 12
  return (
    <div>
      <div className="ari-viz-heatmap-key">
        <span>Low {formatNumber(min)}</span>
        <i
          style={{
            background:
              min < 0
                ? 'linear-gradient(90deg, var(--ari-info), var(--ari-surface-2), var(--ari-accent))'
                : 'linear-gradient(90deg, var(--ari-surface-2), var(--ari-accent))',
          }}
        />
        <span>
          High {formatNumber(max)}
          {spec.unit ? ` ${spec.unit}` : ''}
        </span>
      </div>
      <svg
        className="ari-viz-svg"
        viewBox={`0 0 ${mapWidth} ${mapHeight}`}
        role="img"
        aria-label={spec.title}
        style={{ width: mapWidth, height: mapHeight }}
      >
        {spec.xLabels.map((label, i) => (
          <text
            key={i}
            className="ari-viz-axis-label"
            x={left + cw * (i + 0.5)}
            y="24"
            textAnchor="middle"
          >
            <title>{label}</title>
            {fitLabel(label, cw - 6)}
          </text>
        ))}
        {spec.yLabels.map((label, y) => (
          <g key={y}>
            <text
              className="ari-viz-axis-label"
              x={left - 12}
              y={top + ch * (y + 0.5) + 4}
              textAnchor="end"
            >
              <title>{label}</title>
              {short(fitLabel(label, left - 20))}
            </text>
            {spec.values[y]?.map((value, x) => (
              <Mark
                key={x}
                label={`${label} · ${spec.xLabels[x] ?? ''}: ${formatNumber(value)}${spec.unit ? ` ${spec.unit}` : ''}`}
                inspect={inspect}
                detail={{
                  title: `${label} · ${spec.xLabels[x] ?? ''}`,
                  rows: [{ label: spec.unit ?? 'Value', value }],
                }}
              >
                <rect
                  x={left + cw * x + 2}
                  y={top + ch * y + 2}
                  width={cw - 4}
                  height={ch - 4}
                  rx="4"
                  fill={
                    value === 0
                      ? 'var(--ari-surface-2)'
                      : value < 0
                        ? 'var(--ari-info)'
                        : 'var(--ari-accent)'
                  }
                  fillOpacity={heatFillOpacity(value, peak)}
                />
                {heatShowsValue(formatNumber(value), cw) && (
                  <text
                    className="ari-viz-heat-value"
                    x={left + cw * (x + 0.5)}
                    y={top + ch * (y + 0.5) + 4}
                    textAnchor="middle"
                  >
                    {formatNumber(value)}
                  </text>
                )}
              </Mark>
            ))}
          </g>
        ))}
      </svg>
    </div>
  )
}
