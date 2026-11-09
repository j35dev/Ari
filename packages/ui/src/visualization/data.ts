import type { VisualizationSpec } from '@ari/contracts/visualization'

export function visualizationData(spec: VisualizationSpec): {
  columns: string[]
  rows: (string | number)[][]
} {
  switch (spec.type) {
    case 'bar':
    case 'line':
    case 'area':
    case 'radar':
      return {
        columns: [spec.xLabel ?? 'Label', ...spec.series.map((s) => s.name)],
        rows: spec.labels.map((label, i) => [label, ...spec.series.map((s) => s.values[i] ?? '')]),
      }
    case 'scatter':
      return {
        columns: ['Series', 'Label', spec.xLabel ?? 'X', spec.yLabel ?? 'Y'],
        rows: spec.series.flatMap((s) => s.points.map((p) => [s.name, p.label ?? '', p.x, p.y])),
      }
    case 'pie':
    case 'donut':
    case 'treemap':
    case 'funnel':
      return {
        columns: ['Label', spec.unit ?? 'Value'],
        rows: spec.items.map((item) => [item.label, item.value]),
      }
    case 'heatmap':
      return {
        columns: ['Label', ...spec.xLabels],
        rows: spec.yLabels.map((label, i) => [label, ...(spec.values[i] ?? [])]),
      }
    case 'graph':
      return {
        columns: ['From', 'To', 'Relationship'],
        rows: [
          ...spec.nodes.map((node) => [
            node.id,
            '',
            `${node.label}${node.description ? `: ${node.description}` : ''}`,
          ]),
          ...spec.edges.map((edge) => [edge.from, edge.to, edge.label ?? '']),
        ],
      }
    case 'timeline':
      return {
        columns: ['Date', 'Event', 'Description'],
        rows: spec.events.map((event) => [event.date ?? '', event.label, event.description ?? '']),
      }
    case 'gantt':
      return {
        columns: ['Task', 'Start', 'End'],
        rows: spec.tasks.map((task) => [task.label, task.start, task.end]),
      }
    case 'metrics':
      return {
        columns: ['Metric', 'Value', 'Detail'],
        rows: spec.items.map((item) => [item.label, item.value, item.detail ?? '']),
      }
    case 'comparison':
      return {
        columns: ['', ...spec.columns],
        rows: spec.rows.map((row) => [row.label, ...row.values]),
      }
  }
}
