import { memo, useId, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { parseVisualization, type VisualizationSpec } from '@ari/contracts/visualization'
import { Dialog } from '../components/Dialog'
import {
  CartesianChart,
  color,
  FunnelChart,
  HeatmapChart,
  PartsChart,
  RadarChart,
  ScatterChart,
  TreemapChart,
} from './charts'
import { GanttDiagram, GraphDiagram, MetricCards, TimelineDiagram } from './diagrams'
import { visualizationData } from './data'

function DataTable({ spec }: { spec: VisualizationSpec }) {
  const data = visualizationData(spec)
  return (
    <div className="ari-viz-scroll">
      <table className="ari-viz-table">
        <caption className="ari-viz-sr-only">{spec.title} — data</caption>
        <thead>
          <tr>
            {data.columns.map((column, i) => (
              <th scope="col" key={i}>
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.rows.map((row, i) => (
            <tr key={i}>
              {row.map((cell, j) =>
                j === 0 ? (
                  <th scope="row" key={j}>
                    {cell}
                  </th>
                ) : (
                  <td key={j}>{cell}</td>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

const typeLabels: Record<VisualizationSpec['type'], string> = {
  bar: 'Bar chart',
  line: 'Line chart',
  area: 'Area chart',
  scatter: 'Scatter plot',
  pie: 'Pie chart',
  donut: 'Donut chart',
  radar: 'Radar chart',
  heatmap: 'Heatmap',
  treemap: 'Treemap',
  funnel: 'Funnel',
  graph: 'Diagram',
  timeline: 'Timeline',
  gantt: 'Schedule',
  metrics: 'Metrics',
  comparison: 'Comparison',
}

function Panel({ spec, source }: { spec: VisualizationSpec; source: string }) {
  const titleId = useId()
  const [mode, setMode] = useState<'visual' | 'data'>('visual')
  const [hidden, setHidden] = useState<Set<number>>(() => new Set())
  const [inspected, inspect] = useState('')
  const [expanded, setExpanded] = useState(false)
  const [copyState, setCopyState] = useState('')
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(source)
      setCopyState('Copied')
    } catch {
      setCopyState('Copy unavailable')
    }
  }
  const series = 'series' in spec ? spec.series : null
  const toggleSeries = (index: number): void => {
    setHidden((current) => {
      const next = new Set(current)
      if (next.has(index)) next.delete(index)
      else if (series !== null && next.size < series.length - 1) next.add(index)
      return next
    })
    inspect('')
  }
  let chart: ReactNode
  switch (spec.type) {
    case 'bar':
    case 'line':
    case 'area':
      chart = <CartesianChart spec={spec} hidden={hidden} inspect={inspect} />
      break
    case 'radar':
      chart = <RadarChart spec={spec} hidden={hidden} inspect={inspect} />
      break
    case 'scatter':
      chart = <ScatterChart spec={spec} hidden={hidden} inspect={inspect} />
      break
    case 'pie':
    case 'donut':
      chart = <PartsChart spec={spec} inspect={inspect} />
      break
    case 'funnel':
      chart = <FunnelChart spec={spec} inspect={inspect} />
      break
    case 'treemap':
      chart = <TreemapChart spec={spec} inspect={inspect} />
      break
    case 'heatmap':
      chart = <HeatmapChart spec={spec} inspect={inspect} />
      break
    case 'graph':
      chart = <GraphDiagram spec={spec} inspect={inspect} />
      break
    case 'gantt':
      chart = <GanttDiagram spec={spec} inspect={inspect} />
      break
    case 'timeline':
      chart = <TimelineDiagram spec={spec} />
      break
    case 'metrics':
      chart = <MetricCards spec={spec} />
      break
    case 'comparison':
      chart = <DataTable spec={spec} />
      break
  }
  const view = (
    <>
      {series !== null && mode === 'visual' && (
        <div className="ari-viz-series" role="group" aria-label="Data series">
          {series.map((s, i) => (
            <button
              type="button"
              key={i}
              aria-pressed={!hidden.has(i)}
              disabled={!hidden.has(i) && hidden.size === series.length - 1}
              onClick={() => toggleSeries(i)}
            >
              <span className="ari-viz-swatch" style={{ background: color(i) }} />
              {s.name}
            </button>
          ))}
        </div>
      )}
      <div className="ari-viz-body">
        {mode === 'data' ? (
          <DataTable spec={spec} />
        ) : (
          <div className="ari-viz-scroll">{chart}</div>
        )}
      </div>
      {mode === 'visual' && !['metrics', 'timeline', 'comparison'].includes(spec.type) && (
        <div className="ari-viz-inspect" role="status">
          {inspected || 'Hover or focus a mark to inspect its value'}
        </div>
      )}
    </>
  )
  const controls = (
    <div className="ari-viz-controls">
      {spec.type !== 'comparison' && (
        <div className="ari-viz-view-switch" aria-label="Visualization view">
          <button type="button" aria-pressed={mode === 'visual'} onClick={() => setMode('visual')}>
            Visual
          </button>
          <button type="button" aria-pressed={mode === 'data'} onClick={() => setMode('data')}>
            Data
          </button>
        </div>
      )}
      <button
        type="button"
        className="ari-viz-action"
        onClick={() => {
          void copy()
        }}
        aria-label="Copy visualization data"
      >
        {copyState || 'Copy'}
      </button>
    </div>
  )
  return (
    <Dialog open={expanded} onOpenChange={setExpanded}>
      <figure className="ari-viz" aria-labelledby={titleId} data-type={spec.type}>
        <figcaption className="ari-viz-header">
          <div>
            <span className="ari-viz-kind">{typeLabels[spec.type]}</span>
            <span className="ari-viz-title" id={titleId}>
              {spec.title}
            </span>
          </div>
          <div className="ari-viz-toolbar">
            {controls}
            <button
              type="button"
              className="ari-viz-action"
              onClick={() => setExpanded(true)}
              aria-label="Expand visualization"
            >
              ↗
            </button>
          </div>
        </figcaption>
        {spec.description && <p className="ari-viz-description">{spec.description}</p>}
        {view}
        {spec.source && <footer className="ari-viz-source">Source: {spec.source}</footer>}
      </figure>
      <Dialog.Content size="lg" className="ari-viz-modal">
        <div className="ari-viz-modal-head">
          <Dialog.Title>{spec.title}</Dialog.Title>
          {controls}
          <Dialog.Close className="ari-viz-action" aria-label="Close visualization">
            Close
          </Dialog.Close>
        </div>
        {spec.description && <Dialog.Description>{spec.description}</Dialog.Description>}
        {view}
      </Dialog.Content>
    </Dialog>
  )
}

/** The only agent-authored input is bounded, schema-checked JSON. React escapes all labels. */
export const Visualization = memo(function Visualization({
  source,
  pending = false,
}: {
  source: string
  pending?: boolean
}) {
  const parsed = useMemo(() => (pending ? null : parseVisualization(source)), [source, pending])
  if (parsed === null)
    return (
      <div className="ari-viz ari-viz-pending" role="status">
        <span className="ari-viz-pending-dot" />
        Building visualization…
      </div>
    )
  if (!parsed.ok)
    return (
      <div className="ari-viz ari-viz-error">
        <strong>Visualization unavailable</strong>
        <p>{parsed.error}</p>
        <details>
          <summary>View source</summary>
          <pre>
            <code>{source.slice(0, 64_000)}</code>
          </pre>
        </details>
      </div>
    )
  // New source resets interactive state; appending ordinary reply text preserves it.
  return <Panel key={source} spec={parsed.value} source={source} />
})
