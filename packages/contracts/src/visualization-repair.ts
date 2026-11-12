/**
 * Agents write charts from habit, and most habits come from other chart
 * libraries: `datasets` with `data`, `name` where Ari says `label`, numbers as
 * strings. None of that is unsafe, only differently named, so it is renamed to
 * the published shape before the strict schema runs. Anything not recognised
 * here is left alone for the schema to refuse.
 *
 * Rules: a published field always wins over an alias; nothing is invented
 * except a series name; colours and layout hints are dropped because Ari
 * chooses those.
 */

type Rec = Record<string, unknown>

const RESERVED = new Set(['__proto__', 'constructor', 'prototype'])

/** Presentation an agent may add from habit. Ari owns colour and layout, so these are ignored. */
const IGNORED = new Set([
  'color',
  'colors',
  'colour',
  'colours',
  'backgroundColor',
  'borderColor',
  'fill',
  'stroke',
  'palette',
  'theme',
  'legend',
  'showLegend',
  'options',
  'style',
  'width',
  'height',
  'stacked',
  'smooth',
])

const TYPE_ALIASES: Record<string, string> = {
  column: 'bar',
  columns: 'bar',
  bars: 'bar',
  histogram: 'bar',
  horizontalbar: 'bar',
  hbar: 'bar',
  lines: 'line',
  doughnut: 'donut',
  ring: 'donut',
  spider: 'radar',
  bubble: 'scatter',
  flow: 'graph',
  flowchart: 'graph',
  diagram: 'graph',
  network: 'graph',
  schedule: 'gantt',
  roadmap: 'gantt',
  metric: 'metrics',
  kpi: 'metrics',
  kpis: 'metrics',
  stats: 'metrics',
  table: 'comparison',
}

const TONE_ALIASES: Record<string, string> = {
  good: 'success',
  positive: 'success',
  ok: 'success',
  done: 'success',
  bad: 'danger',
  negative: 'danger',
  error: 'danger',
  critical: 'danger',
  warn: 'warning',
  caution: 'warning',
  primary: 'accent',
}

const DIRECTION_ALIASES: Record<string, string> = {
  lr: 'right',
  horizontal: 'right',
  tb: 'down',
  td: 'down',
  vertical: 'down',
}

const SHAPE_ALIASES: Record<string, string> = {
  diamond: 'decision',
  rectangle: 'process',
  rect: 'process',
  box: 'process',
  step: 'process',
}

const NUMERIC = /^[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$/

function isRec(value: unknown): value is Rec {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value) as object | null
  return proto === Object.prototype || proto === null
}

/** A copy without reserved or ignored keys, so nothing below can reach a prototype. */
function copy(rec: Rec): Rec {
  const out: Rec = {}
  for (const key of Object.keys(rec)) {
    if (RESERVED.has(key) || IGNORED.has(key)) continue
    out[key] = rec[key]
  }
  return out
}

/** Moves the first alias present onto `field`, unless `field` is already set. */
function rename(rec: Rec, field: string, aliases: readonly string[]): void {
  if (Object.hasOwn(rec, field)) return
  for (const alias of aliases) {
    if (!Object.hasOwn(rec, alias)) continue
    rec[field] = rec[alias]
    delete rec[alias]
    return
  }
}

/** "1,234.5" is a number someone quoted. "50%" and "4 h" are not, and stay text. */
function num(value: unknown): unknown {
  if (typeof value !== 'string') return value
  const text = value.trim()
  return NUMERIC.test(text) ? Number(text.replace(/,/g, '')) : value
}

function text(value: unknown): unknown {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  return value
}

const records = (value: unknown): value is Rec[] => Array.isArray(value) && value.every(isRec)
const scalars = (value: unknown): value is unknown[] =>
  Array.isArray(value) && value.every((item) => typeof item !== 'object' || item === null)

function each(value: unknown, fix: (item: Rec, index: number) => Rec): unknown {
  if (!Array.isArray(value)) return value
  return value.map((item: unknown, index) => (isRec(item) ? fix(copy(item), index) : item))
}

function tone(rec: Rec): void {
  if (typeof rec.tone !== 'string') return
  const key = rec.tone.trim().toLowerCase()
  if (key === 'neutral' || key === 'default' || key === 'none') delete rec.tone
  else rec.tone = TONE_ALIASES[key] ?? key
}

const LABEL_ALIASES = ['name', 'title', 'category', 'key', 'text'] as const
const VALUE_ALIASES = ['count', 'amount', 'size', 'total', 'y', 'percent', 'percentage'] as const

/** `{ label, value }`, however the agent spelled it. */
function labelled(item: Rec): Rec {
  rename(item, 'label', LABEL_ALIASES)
  rename(item, 'value', VALUE_ALIASES)
  item.label = text(item.label)
  return item
}

function seriesName(rec: Rec, index: number, single: boolean): string {
  if (single && typeof rec.yLabel === 'string' && rec.yLabel.trim()) return rec.yLabel
  if (single && typeof rec.unit === 'string' && rec.unit.trim()) return rec.unit
  return single ? 'Value' : `Series ${String(index + 1)}`
}

function cartesian(rec: Rec): void {
  rename(rec, 'labels', ['categories', 'xLabels', 'x'])
  rename(rec, 'series', ['datasets'])
  if (!Object.hasOwn(rec, 'series') && Array.isArray(rec.data)) rename(rec, 'series', ['data'])

  // `series: { Before: [...], After: [...] }`
  if (isRec(rec.series)) {
    const byName = rec.series
    rec.series = Object.keys(byName)
      .filter((key) => !RESERVED.has(key))
      .map((key) => ({ name: key, values: byName[key] }))
  }

  // One list of `{ label, value }` rows, or bare numbers, is one series.
  const rows = !Object.hasOwn(rec, 'series')
    ? (['items', 'values', 'bars', 'points'] as const).find((key) => Array.isArray(rec[key]))
    : Array.isArray(rec.series) && rec.series.length > 0 && rec.series.every(isRowLike)
      ? 'series'
      : undefined
  if (rows !== undefined) {
    const list = rec[rows] as unknown[]
    delete rec[rows]
    rec.series = [{ values: list }]
  }

  if (!Array.isArray(rec.series)) return
  const single = rec.series.length === 1
  rec.series = rec.series.map((entry: unknown, index) => {
    // `series: [[1, 2], [3, 4]]`
    if (!Array.isArray(entry) && !isRec(entry)) return entry
    const series: Rec = Array.isArray(entry) ? { values: entry } : copy(entry)
    rename(series, 'values', ['data', 'y', 'points'])
    rename(series, 'name', ['label', 'title', 'key', 'id'])
    if (records(series.values)) {
      const points = series.values.map((point) => {
        const fixed = copy(point)
        rename(fixed, 'label', ['x'])
        return labelled(fixed)
      })
      if (!Object.hasOwn(rec, 'labels')) rec.labels = points.map((point) => point.label)
      series.values = points.map((point) => point.value)
    }
    if (Array.isArray(series.values)) series.values = series.values.map(num)
    if (series.name === undefined) series.name = seriesName(rec, index, single)
    series.name = text(series.name)
    return series
  })
  if (Array.isArray(rec.labels)) rec.labels = rec.labels.map(text)
}

/** A `{ label, value }` row rather than a series: it has a value and no list of them. */
function isRowLike(entry: unknown): boolean {
  if (!isRec(entry)) return false
  const hasList = ['values', 'data', 'points', 'y'].some((key) => Array.isArray(entry[key]))
  return !hasList && ['value', ...VALUE_ALIASES].some((key) => Object.hasOwn(entry, key))
}

function parts(rec: Rec): void {
  rename(rec, 'items', ['slices', 'segments', 'parts', 'stages', 'steps'])
  if (!Object.hasOwn(rec, 'items') && records(rec.data)) rename(rec, 'items', ['data'])
  if (!Object.hasOwn(rec, 'items') && records(rec.values)) rename(rec, 'items', ['values'])
  if (!Object.hasOwn(rec, 'items') && Array.isArray(rec.series) && rec.series.every(isRowLike))
    rename(rec, 'items', ['series'])

  // `labels` beside a list of numbers is the same information in two arrays.
  if (!Object.hasOwn(rec, 'items') && scalars(rec.labels)) {
    const first: unknown = Array.isArray(rec.series) ? rec.series[0] : undefined
    const nested = isRec(first) ? (first.values ?? first.data) : undefined
    const values = scalars(rec.values) ? rec.values : scalars(nested) ? nested : undefined
    if (values !== undefined && values.length === rec.labels.length) {
      rec.items = rec.labels.map((label, index) => ({ label, value: values[index] }))
      delete rec.labels
      delete rec.values
      delete rec.series
    }
  }
  rec.items = each(rec.items, (item) => {
    labelled(item)
    item.value = num(item.value)
    return item
  })
}

function metrics(rec: Rec): void {
  rename(rec, 'items', ['metrics', 'cards', 'stats', 'values', 'data'])
  rec.items = each(rec.items, (item) => {
    rename(item, 'label', LABEL_ALIASES)
    rename(item, 'detail', ['description', 'caption', 'note', 'subtitle', 'delta', 'change'])
    item.label = text(item.label)
    if (item.detail !== undefined) item.detail = text(item.detail)
    tone(item)
    return item
  })
}

function scatter(rec: Rec): void {
  rename(rec, 'series', ['datasets'])
  if (!Object.hasOwn(rec, 'series') && Array.isArray(rec.data)) rename(rec, 'series', ['data'])
  if (!Object.hasOwn(rec, 'series') && Array.isArray(rec.points)) {
    rec.series = [{ name: 'Points', points: rec.points }]
    delete rec.points
  }
  // A flat list of points is one series.
  if (Array.isArray(rec.series) && rec.series.length > 0 && rec.series.every(isPointLike))
    rec.series = [{ name: 'Points', points: rec.series }]
  rec.series = each(rec.series, (series, index) => {
    rename(series, 'points', ['data', 'values'])
    rename(series, 'name', ['label', 'title', 'key', 'id'])
    if (series.name === undefined) series.name = `Series ${String(index + 1)}`
    series.name = text(series.name)
    if (Array.isArray(series.points))
      series.points = series.points.map((point: unknown) => {
        if (Array.isArray(point) && point.length >= 2) return { x: num(point[0]), y: num(point[1]) }
        if (!isRec(point)) return point
        const fixed = copy(point)
        rename(fixed, 'label', ['name', 'title', 'text'])
        fixed.x = num(fixed.x)
        fixed.y = num(fixed.y)
        if (fixed.label !== undefined) fixed.label = text(fixed.label)
        return fixed
      })
    return series
  })
}

function isPointLike(entry: unknown): boolean {
  if (Array.isArray(entry)) return entry.length >= 2 && entry.every((part) => !isRec(part))
  return isRec(entry) && Object.hasOwn(entry, 'x') && Object.hasOwn(entry, 'y')
}

function heatmap(rec: Rec): void {
  if (scalars(rec.columns)) rename(rec, 'xLabels', ['columns'])
  if (scalars(rec.rows)) rename(rec, 'yLabels', ['rows'])
  if (scalars(rec.x)) rename(rec, 'xLabels', ['x'])
  if (scalars(rec.y)) rename(rec, 'yLabels', ['y'])
  rename(rec, 'values', ['matrix', 'cells', 'z'])
  if (!Object.hasOwn(rec, 'values') && Array.isArray(rec.data)) rename(rec, 'values', ['data'])
  if (Array.isArray(rec.xLabels)) rec.xLabels = rec.xLabels.map(text)
  if (Array.isArray(rec.yLabels)) rec.yLabels = rec.yLabels.map(text)
  if (Array.isArray(rec.values))
    rec.values = rec.values.map((row: unknown) => (Array.isArray(row) ? row.map(num) : row))
}

function graph(rec: Rec): void {
  rename(rec, 'nodes', ['vertices'])
  rename(rec, 'edges', ['links', 'connections', 'arrows'])
  if (typeof rec.direction === 'string') {
    const direction = rec.direction.trim().toLowerCase()
    rec.direction = DIRECTION_ALIASES[direction] ?? direction
  }
  rec.nodes = each(rec.nodes, (node) => {
    rename(node, 'label', ['name', 'title', 'text'])
    rename(node, 'description', ['detail', 'details', 'note'])
    node.id = text(node.id)
    if (node.label === undefined) node.label = node.id
    node.label = text(node.label)
    if (typeof node.shape === 'string') {
      const shape = node.shape.trim().toLowerCase()
      node.shape = SHAPE_ALIASES[shape] ?? shape
    }
    tone(node)
    return node
  })
  if (rec.edges === undefined && Array.isArray(rec.nodes)) rec.edges = []
  rec.edges = each(rec.edges, (edge) => {
    rename(edge, 'from', ['source', 'src', 'start'])
    rename(edge, 'to', ['target', 'dst', 'dest', 'end'])
    rename(edge, 'label', ['text', 'name', 'title'])
    edge.from = text(edge.from)
    edge.to = text(edge.to)
    if (edge.label !== undefined) edge.label = text(edge.label)
    return edge
  })
}

function timeline(rec: Rec): void {
  rename(rec, 'events', ['items', 'milestones', 'entries', 'steps'])
  if (!Object.hasOwn(rec, 'events') && Array.isArray(rec.data)) rename(rec, 'events', ['data'])
  rec.events = each(rec.events, (event) => {
    rename(event, 'label', ['title', 'name', 'event'])
    rename(event, 'date', ['time', 'when', 'at', 'year', 'timestamp'])
    rename(event, 'description', ['detail', 'details', 'note', 'summary', 'text'])
    event.label = text(event.label)
    if (event.date !== undefined) event.date = text(event.date)
    tone(event)
    return event
  })
}

function gantt(rec: Rec): void {
  rename(rec, 'tasks', ['items', 'bars', 'rows'])
  if (!Object.hasOwn(rec, 'tasks') && Array.isArray(rec.data)) rename(rec, 'tasks', ['data'])
  rec.tasks = each(rec.tasks, (task) => {
    rename(task, 'label', ['name', 'title', 'task'])
    rename(task, 'start', ['from', 'begin'])
    rename(task, 'end', ['to', 'finish'])
    task.label = text(task.label)
    task.start = num(task.start)
    task.end = num(task.end)
    return task
  })
}

function comparison(rec: Rec): void {
  rename(rec, 'columns', ['headers', 'options'])
  rename(rec, 'rows', ['items'])
  if (!Object.hasOwn(rec, 'rows') && Array.isArray(rec.data)) rename(rec, 'rows', ['data'])
  if (Array.isArray(rec.columns)) rec.columns = rec.columns.map(text)
  if (!Array.isArray(rec.rows)) return
  rec.rows = rec.rows.map((entry: unknown) => {
    // `["Network", "Optional", "Required"]`
    if (Array.isArray(entry) && entry.length >= 2)
      return { label: text(entry[0]), values: entry.slice(1).map(text) }
    if (!isRec(entry)) return entry
    const row = copy(entry)
    rename(row, 'label', ['name', 'title', 'feature', 'criterion'])
    rename(row, 'values', ['cells', 'data'])
    row.label = text(row.label)
    if (Array.isArray(row.values)) row.values = row.values.map(text)
    return row
  })
  // A header for the label column is one column too many.
  const width = (rec.rows as unknown[]).reduce<number>(
    (most, row) =>
      isRec(row) && Array.isArray(row.values) ? Math.max(most, row.values.length) : most,
    0,
  )
  if (Array.isArray(rec.columns) && width > 0 && rec.columns.length === width + 1)
    rec.columns = rec.columns.slice(1)
}

const FAMILIES: Record<string, (rec: Rec) => void> = {
  bar: cartesian,
  line: cartesian,
  area: cartesian,
  radar: cartesian,
  scatter,
  pie: parts,
  donut: parts,
  funnel: parts,
  treemap: parts,
  heatmap,
  graph,
  timeline,
  gantt,
  metrics,
  comparison,
}

/**
 * Returns the visualization in its published shape where the intent is clear.
 * Input that is not a plain object is returned untouched.
 */
export function repairVisualization(input: unknown): unknown {
  if (!isRec(input)) return input
  const rec = copy(input)

  if (typeof rec.type === 'string') {
    // "Bar Chart", "bar_chart" and "barchart" all mean bar.
    const full = rec.type
      .trim()
      .toLowerCase()
      .replace(/[\s_-]+/g, '')
    const resolved = [full, full.replace(/(?:chart|plot|diagram)$/, '')]
      .map((key) => TYPE_ALIASES[key] ?? key)
      .find((key) => Object.hasOwn(FAMILIES, key))
    if (resolved !== undefined) rec.type = resolved
    const horizontal = full.startsWith('horizontalbar') || full.startsWith('hbar')
    if (horizontal && rec.orientation === undefined) rec.orientation = 'horizontal'
  }
  if (rec.version === '1') rec.version = 1

  rename(rec, 'title', ['name', 'heading'])
  rename(rec, 'description', ['subtitle', 'summary', 'caption'])
  rename(rec, 'unit', ['units'])
  if (typeof rec.xAxis === 'string') rename(rec, 'xLabel', ['xAxis'])
  if (typeof rec.yAxis === 'string') rename(rec, 'yLabel', ['yAxis'])
  rename(rec, 'xLabel', ['xAxisLabel', 'xTitle'])
  rename(rec, 'yLabel', ['yAxisLabel', 'yTitle'])

  if (typeof rec.type === 'string' && Object.hasOwn(FAMILIES, rec.type)) FAMILIES[rec.type]?.(rec)
  for (const key of Object.keys(rec)) if (rec[key] === undefined) delete rec[key]
  return rec
}
