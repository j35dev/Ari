import { z } from 'zod'

/** A reply can describe a visual, never execute code or choose app colors. */
const label = z.string().trim().min(1).max(120)
const number = z.number().finite().min(-1e12).max(1e12)
const positive = number.nonnegative()
const base = {
  version: z.literal(1).default(1),
  title: label,
  description: z.string().max(1000).optional(),
  source: z.string().max(500).optional(),
}
const series = z.strictObject({ name: label, values: z.array(number).min(1).max(64) })
const item = z.strictObject({ label, value: positive })
const toneName = z.enum(['accent', 'info', 'success', 'warning', 'danger'])
const tone = toneName.default('accent')

export const visualizationSchema = z
  .discriminatedUnion('type', [
    z.strictObject({
      ...base,
      type: z.enum(['bar', 'line', 'area', 'radar']),
      orientation: z.enum(['vertical', 'horizontal']).optional(),
      labels: z.array(label).min(1).max(64),
      series: z.array(series).min(1).max(8),
      unit: z.string().max(30).optional(),
      xLabel: label.optional(),
      yLabel: label.optional(),
    }),
    z.strictObject({
      ...base,
      type: z.literal('scatter'),
      series: z
        .array(
          z.strictObject({
            name: label,
            points: z
              .array(z.strictObject({ x: number, y: number, label: label.optional() }))
              .min(1)
              .max(128),
          }),
        )
        .min(1)
        .max(8),
      xLabel: label.optional(),
      yLabel: label.optional(),
    }),
    z.strictObject({
      ...base,
      type: z.enum(['pie', 'donut', 'funnel', 'treemap']),
      items: z.array(item).min(1).max(32),
      unit: z.string().max(30).optional(),
    }),
    z.strictObject({
      ...base,
      type: z.literal('heatmap'),
      xLabels: z.array(label).min(1).max(32),
      yLabels: z.array(label).min(1).max(32),
      values: z.array(z.array(number).min(1).max(32)).min(1).max(32),
      unit: z.string().max(30).optional(),
    }),
    z.strictObject({
      ...base,
      type: z.literal('graph'),
      direction: z.enum(['right', 'down']).default('right'),
      nodes: z
        .array(
          z.strictObject({
            id: label,
            label,
            description: z.string().max(300).optional(),
            shape: z.enum(['process', 'decision', 'start', 'end']).default('process'),
            tone: toneName.optional(),
          }),
        )
        .min(1)
        .max(40),
      edges: z.array(z.strictObject({ from: label, to: label, label: label.optional() })).max(80),
    }),
    z.strictObject({
      ...base,
      type: z.literal('timeline'),
      events: z
        .array(
          z.strictObject({
            label,
            date: label.optional(),
            description: z.string().max(1000).optional(),
            tone,
          }),
        )
        .min(1)
        .max(40),
    }),
    z.strictObject({
      ...base,
      type: z.literal('gantt'),
      tasks: z
        .array(z.strictObject({ label, start: number, end: number }))
        .min(1)
        .max(40),
      unit: z.string().max(30).optional(),
    }),
    z.strictObject({
      ...base,
      type: z.literal('metrics'),
      items: z
        .array(
          z.strictObject({
            label,
            value: z.union([number, z.string().min(1).max(80)]),
            detail: z.string().max(300).optional(),
            tone,
          }),
        )
        .min(1)
        .max(12),
    }),
    z.strictObject({
      ...base,
      type: z.literal('comparison'),
      columns: z.array(label).min(1).max(8),
      rows: z
        .array(z.strictObject({ label, values: z.array(z.string().max(500)).min(1).max(8) }))
        .min(1)
        .max(40),
    }),
  ])
  .superRefine((visual, context) => {
    const issue = (message: string): void => context.addIssue({ code: 'custom', message })
    switch (visual.type) {
      case 'bar':
      case 'line':
      case 'area':
      case 'radar':
        if (visual.type !== 'bar' && visual.orientation !== undefined)
          issue('Orientation is supported for bar charts only.')
        if (visual.series.some((s) => s.values.length !== visual.labels.length))
          issue('Each series must have one value per label.')
        if (visual.type === 'radar' && (visual.labels.length < 3 || visual.labels.length > 12))
          issue('Radar charts need three to twelve labels.')
        if (visual.type === 'radar' && visual.series.some((s) => s.values.some((v) => v < 0)))
          issue('Radar values must be nonnegative.')
        break
      case 'pie':
      case 'donut':
      case 'treemap':
      case 'funnel':
        if (!visual.items.some((i) => i.value > 0))
          issue('At least one item must have a positive value.')
        break
      case 'heatmap':
        if (
          visual.values.length !== visual.yLabels.length ||
          visual.values.some((row) => row.length !== visual.xLabels.length)
        )
          issue('Heatmap values must match both label axes.')
        break
      case 'graph': {
        const ids = new Set(visual.nodes.map((node) => node.id))
        if (ids.size !== visual.nodes.length) issue('Graph node IDs must be unique.')
        if (visual.edges.some((edge) => !ids.has(edge.from) || !ids.has(edge.to)))
          issue('Graph edges must reference existing nodes.')
        break
      }
      case 'gantt':
        if (visual.tasks.some((task) => task.end < task.start))
          issue('Task end must be at or after its start.')
        break
      case 'comparison':
        if (visual.rows.some((row) => row.values.length !== visual.columns.length))
          issue('Each row must have one value per column.')
        break
    }
  })

export type VisualizationSpec = z.infer<typeof visualizationSchema>
export const VISUALIZATION_MAX_CHARS = 64_000

export function parseVisualization(
  source: string,
): { ok: true; value: VisualizationSpec } | { ok: false; error: string } {
  if (source.length > VISUALIZATION_MAX_CHARS)
    return { ok: false, error: 'This visualization is too large.' }
  let input: unknown
  try {
    input = JSON.parse(source)
  } catch {
    return { ok: false, error: 'The visualization needs valid JSON.' }
  }
  const result = visualizationSchema.safeParse(input)
  return result.success
    ? { ok: true, value: result.data }
    : { ok: false, error: result.error.issues[0]?.message ?? 'Unsupported visualization.' }
}
