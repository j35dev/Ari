import { z } from 'zod'
import { repairVisualization } from './visualization-repair'

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

const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
const TYPE_LABELS: Record<string, string> = {
  bar: 'Bar',
  line: 'Line',
  area: 'Area',
  scatter: 'Scatter',
  pie: 'Pie',
  donut: 'Donut',
  radar: 'Radar',
  heatmap: 'Heatmap',
  treemap: 'Treemap',
  funnel: 'Funnel',
  graph: 'Graph',
  timeline: 'Timeline',
  gantt: 'Gantt',
  metrics: 'Metric',
  comparison: 'Comparison',
}
const SAFE_NAME = /^[A-Za-z][A-Za-z0-9]{0,40}$/
const SAFE_CUSTOM = /^[A-Za-z0-9 ,.'’:-]{1,180}$/

type ParseIssue = {
  code: string
  message: string
  path: ReadonlyArray<PropertyKey>
  keys?: ReadonlyArray<string>
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value) as object | null
  return proto === Object.prototype || proto === null
}

function hasReservedKey(value: object): boolean {
  return Object.getOwnPropertyNames(value).some((key) => RESERVED_KEYS.has(key))
}

function boundError(message: string): string {
  const clean = message.replace(/\s+/g, ' ').trim()
  return clean.length > 240 ? `${clean.slice(0, 239)}…` : clean
}

function issueField(path: ReadonlyArray<PropertyKey>): string | null {
  for (let index = path.length - 1; index >= 0; index -= 1) {
    const part = path[index]
    if (typeof part === 'string' && SAFE_NAME.test(part)) return part
  }
  return null
}

/** Zod's generic Invalid input text can echo a received value. Name the field instead. */
function visualizationError(issues: ReadonlyArray<ParseIssue>, input: unknown): string {
  const issue = issues[0]
  if (!issue) return 'Unsupported visualization.'
  if (issue.code === 'custom' && SAFE_CUSTOM.test(issue.message)) return boundError(issue.message)
  const type = isPlainRecord(input) && typeof input.type === 'string' ? input.type : ''
  const label = Object.hasOwn(TYPE_LABELS, type) ? TYPE_LABELS[type] : undefined
  const named = typeof label === 'string' ? label : null
  if (issue.code === 'unrecognized_keys') {
    const key = issue.keys?.find((item) => SAFE_NAME.test(item))
    const subject = named ? `${named} charts` : 'A visualization'
    return boundError(
      key ? `${subject} cannot include "${key}".` : `${subject} cannot include an extra field.`,
    )
  }
  if (!named) return 'A visualization needs a supported type.'
  const field = issueField(issue.path)
  if (!field) return `${named} charts need their required fields.`
  const missing =
    issue.code === 'invalid_type' &&
    issue.path.length === 1 &&
    issue.message.includes('received undefined')
  const article = field.endsWith('s') ? 'valid' : 'a valid'
  return boundError(
    missing ? `${named} charts need ${field}.` : `${named} charts need ${article} ${field}.`,
  )
}

/**
 * One top-level `data` object is the older envelope. Copy its fields once.
 * Overlapping keys, reserved keys, and a second nested `data` object fail closed.
 * A `data` list is not an envelope: it is the chart's rows under another name,
 * which the repair step renames.
 */
function prepareVisualization(
  input: unknown,
): { ok: true; value: unknown } | { ok: false; error: string } {
  if (input === null || typeof input !== 'object' || Array.isArray(input))
    return { ok: true, value: input }
  if (!isPlainRecord(input))
    return { ok: false, error: 'A visualization needs one plain JSON object.' }
  if (hasReservedKey(input))
    return { ok: false, error: 'Visualization objects cannot use reserved keys.' }
  if (!Object.hasOwn(input, 'data')) return { ok: true, value: input }
  const data = input.data
  if (Array.isArray(data)) return { ok: true, value: input }
  if (!isPlainRecord(data))
    return { ok: false, error: 'The data field must be one object of chart fields.' }
  if (hasReservedKey(data))
    return { ok: false, error: 'Visualization objects cannot use reserved keys.' }
  const dataKeys = Object.keys(data)
  const conflict = dataKeys.find((key) => Object.hasOwn(input, key))
  if (conflict) {
    const name = SAFE_NAME.test(conflict) ? conflict : null
    return {
      ok: false,
      error: name
        ? `The field "${name}" is set both on the visualization and inside data.`
        : 'A field is set both on the visualization and inside data.',
    }
  }
  const flat: Record<string, unknown> = {}
  for (const key of Object.keys(input)) {
    if (key === 'data') continue
    flat[key] = input[key]
  }
  for (const key of dataKeys) flat[key] = data[key]
  return { ok: true, value: flat }
}

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
  const prepared = prepareVisualization(input)
  if (!prepared.ok) return prepared
  const repaired = repairVisualization(prepared.value)
  const result = visualizationSchema.safeParse(repaired)
  return result.success
    ? { ok: true, value: result.data }
    : { ok: false, error: visualizationError(result.error.issues, repaired) }
}
