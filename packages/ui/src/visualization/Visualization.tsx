import { memo, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
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
import { GanttDiagram, MetricCards, TimelineDiagram } from './diagrams'
import { GraphDiagram } from './GraphDiagram'
import { InteractiveSurface } from './interaction'
import { DataTable } from './DataTable'
import { HorizontalBarsChart } from './HorizontalBarsChart'
import { CheckIcon, CopyIcon, ExpandIcon, FlipIcon, TableIcon } from './icons'

/**
 * Columns suit a few short names. Many categories, or long names, read better
 * as ranked rows, where every label has room and nothing scrolls sideways.
 */
function barsReadBetterAsRows(labels: readonly string[]): boolean {
  return labels.length > 8 || labels.some((label) => label.length > 18)
}

/** Measures its own width so each chart draws at 1:1 in the inline reply and the dialog. */
function MeasuredVisual({
  diagram,
  label,
  render,
}: {
  diagram: boolean
  label: string
  render: (width: number | null) => ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState<number | null>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const read = (): void => {
      const next = Math.floor(el.clientWidth)
      setWidth(next > 0 ? next : null)
    }
    read()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(read)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  return (
    <div
      ref={ref}
      tabIndex={diagram ? undefined : 0}
      role={diagram ? undefined : 'region'}
      aria-label={diagram ? undefined : label}
      className={diagram ? 'ari-viz-diagram-view' : 'ari-viz-scroll ari-viz-visual-scroll'}
    >
      {render(width)}
    </div>
  )
}

function Panel({ spec, source }: { spec: VisualizationSpec; source: string }) {
  const titleId = useId()
  const [mode, setMode] = useState<'visual' | 'data'>('visual')
  const [hidden, setHidden] = useState<Set<number>>(() => new Set())
  const [inspected, inspect] = useState('')
  const [expanded, setExpanded] = useState(false)
  const [copyState, setCopyState] = useState('')
  const [orientation, setOrientation] = useState<'vertical' | 'horizontal'>(
    spec.type === 'bar'
      ? (spec.orientation ?? (barsReadBetterAsRows(spec.labels) ? 'horizontal' : 'vertical'))
      : 'vertical',
  )
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(source)
      setCopyState('Copied')
    } catch {
      setCopyState('Copy unavailable')
    }
  }
  const series = 'series' in spec ? spec.series : null
  const toggleSeries = (index: number, isolate = false): void => {
    setHidden((current) => {
      const next = new Set(current)
      if (isolate && series !== null)
        return new Set(series.map((_, i) => i).filter((i) => i !== index))
      if (next.has(index)) next.delete(index)
      else if (series !== null && next.size < series.length - 1) next.add(index)
      return next
    })
    inspect('')
  }
  const renderChart = (width: number | null): ReactNode => {
    switch (spec.type) {
      case 'bar':
        return orientation === 'horizontal' ? (
          <HorizontalBarsChart spec={spec} hidden={hidden} inspect={inspect} width={width} />
        ) : (
          <CartesianChart spec={spec} hidden={hidden} inspect={inspect} width={width} />
        )
      case 'line':
      case 'area':
        return <CartesianChart spec={spec} hidden={hidden} inspect={inspect} width={width} />
      case 'radar':
        return <RadarChart spec={spec} hidden={hidden} inspect={inspect} width={width} />
      case 'scatter':
        return <ScatterChart spec={spec} hidden={hidden} inspect={inspect} width={width} />
      case 'pie':
      case 'donut':
        return <PartsChart spec={spec} inspect={inspect} />
      case 'funnel':
        return <FunnelChart spec={spec} inspect={inspect} />
      case 'treemap':
        return <TreemapChart spec={spec} inspect={inspect} width={width} />
      case 'heatmap':
        return <HeatmapChart spec={spec} inspect={inspect} width={width} />
      case 'graph':
        return <GraphDiagram spec={spec} inspect={inspect} width={width} />
      case 'gantt':
        return <GanttDiagram spec={spec} inspect={inspect} width={width} />
      case 'timeline':
        return <TimelineDiagram spec={spec} />
      case 'metrics':
        return <MetricCards spec={spec} />
      case 'comparison':
        return null
    }
  }
  const view = (
    <>
      {/* One series is named by the title; a legend of one swatch would only repeat it. */}
      {series !== null && series.length > 1 && mode === 'visual' && (
        <div className="ari-viz-series" role="group" aria-label="Data series">
          {series.map((s, i) => (
            <button
              type="button"
              key={i}
              aria-pressed={!hidden.has(i)}
              disabled={!hidden.has(i) && hidden.size === series.length - 1}
              onClick={(event) => toggleSeries(i, event.shiftKey)}
              title="Click to toggle; Shift-click to isolate"
            >
              <span className="ari-viz-swatch" style={{ background: color(i) }} />
              <span className="ari-viz-series-name">{s.name}</span>
            </button>
          ))}
        </div>
      )}
      <div className="ari-viz-body">
        {mode === 'data' || spec.type === 'comparison' ? (
          <DataTable spec={spec} />
        ) : (
          <InteractiveSurface resetKey={`${[...hidden].join(',')}:${orientation}`}>
            <MeasuredVisual
              diagram={spec.type === 'graph'}
              label={`${spec.title} visual`}
              render={renderChart}
            />
          </InteractiveSurface>
        )}
      </div>
      {/* The tooltip shows this to sighted users; here it is announced. */}
      {mode === 'visual' && !['metrics', 'timeline', 'comparison'].includes(spec.type) && (
        <div className="ari-viz-sr-only" role="status">
          {inspected}
        </div>
      )}
    </>
  )
  const controls = (
    <div className="ari-viz-controls">
      {spec.type === 'bar' && mode === 'visual' && (
        <button
          type="button"
          className="ari-viz-action"
          aria-label="Show bars as rows"
          title={orientation === 'horizontal' ? 'Show bars as columns' : 'Show bars as rows'}
          aria-pressed={orientation === 'horizontal'}
          onClick={() =>
            setOrientation((current) => (current === 'horizontal' ? 'vertical' : 'horizontal'))
          }
        >
          <FlipIcon />
        </button>
      )}
      {spec.type !== 'comparison' && (
        <button
          type="button"
          className="ari-viz-action"
          aria-label="Show data table"
          title={mode === 'data' ? 'Show the chart' : 'Show the data as a table'}
          aria-pressed={mode === 'data'}
          onClick={() => setMode((current) => (current === 'data' ? 'visual' : 'data'))}
        >
          <TableIcon />
        </button>
      )}
      <button
        type="button"
        className="ari-viz-action"
        onClick={() => {
          void copy()
        }}
        aria-label="Copy visualization data"
        title="Copy the data"
      >
        {copyState === 'Copied' ? <CheckIcon /> : <CopyIcon />}
        {/* Announced, and shown only when copying failed and the icon cannot say so. */}
        <span className={copyState === 'Copy unavailable' ? undefined : 'ari-viz-sr-only'}>
          {copyState}
        </span>
      </button>
    </div>
  )
  return (
    <Dialog open={expanded} onOpenChange={setExpanded}>
      <figure className="ari-viz" aria-labelledby={titleId} data-type={spec.type}>
        <figcaption className="ari-viz-header">
          <div>
            <span className="ari-viz-title" id={titleId}>
              {spec.title}
            </span>
            {spec.description && <p className="ari-viz-description">{spec.description}</p>}
          </div>
          <div className="ari-viz-toolbar">
            {controls}
            <button
              type="button"
              className="ari-viz-action"
              onClick={() => setExpanded(true)}
              aria-label="Expand visualization"
              title="Open larger"
            >
              <ExpandIcon />
            </button>
          </div>
        </figcaption>
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
      </div>
    )
  // New source resets interactive state; appending ordinary reply text preserves it.
  return <Panel key={source} spec={parsed.value} source={source} />
})
