import type { CSSProperties, ReactNode } from 'react'
import type { VisualizationSpec } from '@ari/contracts/visualization'

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
const short = (text: string, max = 16): string =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text
const W = 640,
  H = 320,
  L = 68,
  R = 24,
  T = 28,
  B = 54
const PW = W - L - R,
  PH = H - T - B

export type Inspect = (text: string) => void
function Mark({
  label,
  inspect,
  children,
}: {
  label: string
  inspect: Inspect
  children: ReactNode
}) {
  return (
    <g
      className="ari-viz-mark"
      tabIndex={0}
      role="img"
      aria-label={label}
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
}: {
  yDomain: [number, number]
  ticks: number[]
  xLabel?: string
  yLabel?: string
}) {
  return (
    <g className="ari-viz-axis">
      {ticks.map((value, i) => {
        const y = T + PH - scale(value, yDomain, PH)
        return (
          <g key={i}>
            <line x1={L} x2={W - R} y1={y} y2={y} />
            <text x={L - 12} y={y + 4} textAnchor="end">
              {formatNumber(value)}
            </text>
          </g>
        )
      })}
      {xLabel && (
        <text x={L + PW / 2} y={H - 5} textAnchor="middle">
          {short(xLabel, 60)}
        </text>
      )}
      {yLabel && (
        <text x={L} y={15}>
          {short(yLabel, 60)}
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
}: {
  spec: Cartesian
  hidden: Set<number>
  inspect: Inspect
}) {
  const visible = spec.series
    .map((s, i) => ({ ...s, index: i }))
    .filter((s) => !hidden.has(s.index))
  const ya = axis(
    visible.flatMap((s) => s.values),
    true,
  )
  const yd = ya.extent
  const y = (value: number): number => T + PH - scale(value, yd, PH)
  const step = PW / spec.labels.length
  const x = (i: number): number =>
    spec.type === 'bar'
      ? L + step * (i + 0.5)
      : L + (spec.labels.length === 1 ? PW / 2 : (PW * i) / (spec.labels.length - 1))
  const baseline = y(0)
  return (
    <svg
      className="ari-viz-svg"
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label={spec.title}
      style={{ minWidth: Math.min(1800, Math.max(400, spec.labels.length * 34)) }}
    >
      <Axes yDomain={yd} ticks={ya.ticks} xLabel={spec.xLabel} yLabel={spec.yLabel ?? spec.unit} />
      {spec.labels.map((label, i) => (
        <text className="ari-viz-axis-label" key={i} x={x(i)} y={H - B + 22} textAnchor="middle">
          <title>{label}</title>
          {short(label, spec.labels.length > 10 ? 9 : 16)}
        </text>
      ))}
      {visible.map((s, si) => {
        const points = s.values.map((value, i) => `${x(i)},${y(value)}`).join(' ')
        const width = (step * 0.72) / visible.length
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
              >
                {spec.type === 'bar' ? (
                  <rect
                    x={x(i) - step * 0.36 + si * width + 1}
                    y={Math.min(baseline, y(value))}
                    width={Math.max(1, width - 2)}
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
}: {
  spec: Extract<VisualizationSpec, { type: 'scatter' }>
  hidden: Set<number>
  inspect: Inspect
}) {
  const visible = spec.series
    .map((s, i) => ({ ...s, index: i }))
    .filter((s) => !hidden.has(s.index))
  const xa = axis(visible.flatMap((s) => s.points.map((p) => p.x)))
  const ya = axis(visible.flatMap((s) => s.points.map((p) => p.y)))
  const xd = xa.extent,
    yd = ya.extent
  return (
    <svg className="ari-viz-svg" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={spec.title}>
      <Axes yDomain={yd} ticks={ya.ticks} xLabel={spec.xLabel} yLabel={spec.yLabel} />
      {xa.ticks.map((value, i) => (
        <text
          className="ari-viz-axis-label"
          key={i}
          x={L + scale(value, xd, PW)}
          y={H - B + 22}
          textAnchor="middle"
        >
          {formatNumber(value)}
        </text>
      ))}
      {visible.map((s) => (
        <g key={s.index}>
          {s.points.map((p, i) => (
            <Mark
              key={i}
              label={`${s.name}${p.label ? ` · ${p.label}` : ''}: ${spec.xLabel ?? 'x'} ${formatNumber(p.x)}, ${spec.yLabel ?? 'y'} ${formatNumber(p.y)}`}
              inspect={inspect}
            >
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
}: {
  spec: Cartesian
  hidden: Set<number>
  inspect: Inspect
}) {
  const visible = spec.series
    .map((s, i) => ({ ...s, index: i }))
    .filter((s) => !hidden.has(s.index))
  const max = Math.max(1, ...visible.flatMap((s) => s.values))
  const center = [320, 166] as const,
    radius = 110
  const point = (i: number, fraction: number): [number, number] => {
    const angle = (i * Math.PI * 2) / spec.labels.length - Math.PI / 2
    return [
      center[0] + Math.cos(angle) * radius * fraction,
      center[1] + Math.sin(angle) * radius * fraction,
    ]
  }
  return (
    <svg className="ari-viz-svg" viewBox="0 0 640 340" role="img" aria-label={spec.title}>
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
              textAnchor={l[0] < 300 ? 'end' : l[0] > 340 ? 'start' : 'middle'}
            >
              <title>{label}</title>
              {short(label, 20)}
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
              >
                <circle cx={p[0]} cy={p[1]} r="4" fill={color(s.index)} />
              </Mark>
            )
          })}
        </g>
      ))}
      <text className="ari-viz-axis-label" x="320" y="328" textAnchor="middle">
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
              {spec.unit ?? 'Total'}
            </text>
          </g>
        )}
      </svg>
      <div className="ari-viz-item-legend">
        {spec.items.map((item, i) => (
          <div key={i}>
            <span className="ari-viz-swatch" style={{ background: color(i) }} />
            <span>{item.label}</span>
            <strong>{formatNumber(item.value)}</strong>
          </div>
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
          <span>{item.label}</span>
          <div className="ari-viz-funnel-track">
            <button
              type="button"
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
export function TreemapChart({ spec, inspect }: { spec: Parts; inspect: Inspect }) {
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
  divide(items, 0, 0, 600, 280)
  return (
    <svg className="ari-viz-svg" viewBox="0 0 600 280" role="img" aria-label={spec.title}>
      {boxes.map(({ x, y, w, h, item }) => (
        <Mark
          key={item.index}
          label={`${item.label}: ${formatNumber(item.value)}${spec.unit ? ` ${spec.unit}` : ''}`}
          inspect={inspect}
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
          {w > 65 && h > 40 && (
            <>
              <text className="ari-viz-treemap-label" x={x + 12} y={y + 24}>
                {short(item.label, Math.floor(w / 8))}
              </text>
              <text className="ari-viz-axis-label" x={x + 12} y={y + 44}>
                {formatNumber(item.value)}
              </text>
            </>
          )}
        </Mark>
      ))}
    </svg>
  )
}

export function HeatmapChart({
  spec,
  inspect,
}: {
  spec: Extract<VisualizationSpec, { type: 'heatmap' }>
  inspect: Inspect
}) {
  const [min, max] = domain(spec.values.flat())
  const cw = Math.max(52, 500 / spec.xLabels.length),
    ch = 42,
    left = 120,
    top = 38
  return (
    <svg
      className="ari-viz-svg"
      viewBox={`0 0 ${left + cw * spec.xLabels.length + 12} ${top + ch * spec.yLabels.length + 12}`}
      role="img"
      aria-label={spec.title}
      style={{ minWidth: left + cw * spec.xLabels.length }}
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
          {short(label, Math.floor(cw / 7))}
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
            {short(label)}
          </text>
          {spec.values[y]?.map((value, x) => (
            <Mark
              key={x}
              label={`${label} · ${spec.xLabels[x] ?? ''}: ${formatNumber(value)}${spec.unit ? ` ${spec.unit}` : ''}`}
              inspect={inspect}
            >
              <rect
                x={left + cw * x + 2}
                y={top + ch * y + 2}
                width={cw - 4}
                height={ch - 4}
                rx="4"
                fill="var(--ari-accent)"
                fillOpacity={0.08 + ((value - min) / (max - min)) * 0.22}
              />
              <text
                className="ari-viz-heat-value"
                x={left + cw * (x + 0.5)}
                y={top + ch * (y + 0.5) + 4}
                textAnchor="middle"
              >
                {formatNumber(value)}
              </text>
            </Mark>
          ))}
        </g>
      ))}
    </svg>
  )
}
