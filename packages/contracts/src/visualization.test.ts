import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseVisualization, VISUALIZATION_MAX_CHARS, visualizationSchema } from './visualization'

const bar = {
  version: 1,
  type: 'bar',
  title: 'Hours',
  labels: ['Before', 'After'],
  series: [{ name: 'Work', values: [12, 5] }],
}
describe('visualization contract', () => {
  it('parses a versioned, labeled chart and allows a negative axis', () => {
    const result = parseVisualization(
      JSON.stringify({ ...bar, series: [{ name: 'Change', values: [-12, 5] }] }),
    )
    expect(result.ok).toBe(true)
    expect(visualizationSchema.parse({ ...bar, version: undefined }).version).toBe(1)
  })
  it.each([
    { ...bar, version: 2 },
    { ...bar, type: 'html', html: '<script>alert(1)</script>' },
    { ...bar, colors: ['red'] },
    { ...bar, series: [{ name: 'Bad', values: [1] }] },
    { ...bar, series: [{ name: 'Huge', values: [1e20, 1] }] },
    { ...bar, series: [{ name: 'Infinite', values: [Infinity, 1] }] },
    {
      version: 1,
      type: 'radar',
      title: 'Few',
      labels: ['A', 'B'],
      series: [{ name: 'S', values: [1, 2] }],
    },
    { version: 1, type: 'pie', title: 'Empty', items: [{ label: 'A', value: 0 }] },
    { version: 1, type: 'donut', title: 'Negative', items: [{ label: 'A', value: -1 }] },
    {
      version: 1,
      type: 'heatmap',
      title: 'Ragged',
      xLabels: ['A', 'B'],
      yLabels: ['C'],
      values: [[1]],
    },
    {
      version: 1,
      type: 'graph',
      title: 'Unknown',
      nodes: [{ id: 'a', label: 'A' }],
      edges: [{ from: 'a', to: 'b' }],
    },
    {
      version: 1,
      type: 'graph',
      title: 'Duplicate',
      nodes: [
        { id: 'a', label: 'A' },
        { id: 'a', label: 'B' },
      ],
      edges: [],
    },
    { version: 1, type: 'gantt', title: 'Reversed', tasks: [{ label: 'Work', start: 5, end: 2 }] },
    {
      version: 1,
      type: 'comparison',
      title: 'Ragged',
      columns: ['A', 'B'],
      rows: [{ label: 'Cost', values: ['1'] }],
    },
  ])('rejects invalid data: $title $type', (input) => {
    expect(visualizationSchema.safeParse(input).success).toBe(false)
  })
  it('bounds parsing and reports malformed JSON without throwing', () => {
    expect(parseVisualization('{broken')).toEqual({
      ok: false,
      error: 'The visualization needs valid JSON.',
    })
    expect(parseVisualization(' '.repeat(VISUALIZATION_MAX_CHARS + 1))).toEqual({
      ok: false,
      error: 'This visualization is too large.',
    })
    expect(parseVisualization('null').ok).toBe(false)
  })
  it('accepts agent-authored graph shapes, theme tones and bar orientation', () => {
    expect(visualizationSchema.safeParse({ ...bar, orientation: 'horizontal' }).success).toBe(true)
    expect(
      visualizationSchema.safeParse({ ...bar, type: 'line', orientation: 'horizontal' }).success,
    ).toBe(false)
    expect(
      visualizationSchema.safeParse({
        type: 'graph',
        title: 'Decision',
        direction: 'down',
        nodes: [{ id: 'a', label: 'Ready?', shape: 'decision', tone: 'warning' }],
        edges: [],
      }).success,
    ).toBe(true)
    expect(
      visualizationSchema.safeParse({
        type: 'graph',
        title: 'Custom color',
        nodes: [{ id: 'a', label: 'A', tone: '#ff0000' }],
        edges: [],
      }).success,
    ).toBe(false)
  })

  const types = [
    'bar',
    'line',
    'area',
    'scatter',
    'pie',
    'donut',
    'radar',
    'heatmap',
    'treemap',
    'funnel',
    'graph',
    'timeline',
    'gantt',
    'metrics',
    'comparison',
  ] as const
  const minimal: Record<(typeof types)[number], Record<string, unknown>> = {
    bar: { type: 'bar', title: 'T', labels: ['A'], series: [{ name: 'S', values: [1] }] },
    line: { type: 'line', title: 'T', labels: ['A'], series: [{ name: 'S', values: [-1] }] },
    area: { type: 'area', title: 'T', labels: ['A'], series: [{ name: 'S', values: [0] }] },
    scatter: { type: 'scatter', title: 'T', series: [{ name: 'S', points: [{ x: 1, y: -2 }] }] },
    pie: { type: 'pie', title: 'T', items: [{ label: 'A', value: 1 }] },
    donut: { type: 'donut', title: 'T', items: [{ label: 'A', value: 1 }] },
    radar: {
      type: 'radar',
      title: 'T',
      labels: ['A', 'B', 'C'],
      series: [{ name: 'S', values: [1, 0, 2] }],
    },
    heatmap: { type: 'heatmap', title: 'T', xLabels: ['A'], yLabels: ['B'], values: [[-1]] },
    treemap: { type: 'treemap', title: 'T', items: [{ label: 'A', value: 1 }] },
    funnel: { type: 'funnel', title: 'T', items: [{ label: 'A', value: 1 }] },
    graph: { type: 'graph', title: 'T', nodes: [{ id: 'a', label: 'A' }], edges: [] },
    timeline: { type: 'timeline', title: 'T', events: [{ label: 'A' }] },
    gantt: { type: 'gantt', title: 'T', tasks: [{ label: 'A', start: 1e12, end: 1e12 }] },
    metrics: { type: 'metrics', title: 'T', items: [{ label: 'A', value: 'ok' }] },
    comparison: {
      type: 'comparison',
      title: 'T',
      columns: ['A'],
      rows: [{ label: 'R', values: ['x'] }],
    },
  }
  it.each(types)('accepts a flat %s object and rejects a data wrapper', (type) => {
    const flat = minimal[type]
    expect(visualizationSchema.safeParse(flat).success).toBe(true)
    const wrapped = { version: 1, type, title: 'T', data: flat }
    const rejected = visualizationSchema.safeParse(wrapped)
    expect(rejected.success).toBe(false)
    if (!rejected.success) expect(JSON.stringify(rejected.error.issues)).toContain('data')
  })

  it('applies tone and shape defaults without inventing a graph-node tone', () => {
    const timeline = visualizationSchema.parse(minimal.timeline)
    const metrics = visualizationSchema.parse(minimal.metrics)
    const graph = visualizationSchema.parse(minimal.graph)
    if (timeline.type !== 'timeline' || metrics.type !== 'metrics' || graph.type !== 'graph')
      throw new Error('unexpected type')
    expect(timeline.events[0]?.tone).toBe('accent')
    expect(metrics.items[0]?.tone).toBe('accent')
    expect(graph.nodes[0]?.tone).toBeUndefined()
    expect(graph.nodes[0]?.shape).toBe('process')
    expect(graph.direction).toBe('right')
  })

  it('enforces the published length, count and numeric bounds', () => {
    expect(
      visualizationSchema.safeParse({
        ...bar,
        labels: ['A'.repeat(121)],
        series: [{ name: 'S', values: [1] }],
      }).success,
    ).toBe(false)
    expect(
      visualizationSchema.safeParse({
        ...bar,
        labels: ['A'.repeat(120)],
        series: [{ name: 'S', values: [1] }],
        unit: 'u'.repeat(30),
      }).success,
    ).toBe(true)
    expect(
      visualizationSchema.safeParse({ ...bar, labels: [' '], series: [{ name: 'S', values: [1] }] })
        .success,
    ).toBe(false)
    expect(visualizationSchema.safeParse({ ...bar, unit: 'u'.repeat(31) }).success).toBe(false)
    expect(
      visualizationSchema.safeParse({
        ...bar,
        series: [{ name: 'S', values: [1e12, -1e12] }],
      }).success,
    ).toBe(true)
    expect(
      visualizationSchema.safeParse({
        ...bar,
        series: [{ name: 'S', values: [1e13, 1] }],
      }).success,
    ).toBe(false)
    expect(
      visualizationSchema.safeParse({
        type: 'pie',
        title: 'Many',
        items: Array.from({ length: 32 }, (_, i) => ({ label: `I${i}`, value: 1 })),
      }).success,
    ).toBe(true)
    expect(
      visualizationSchema.safeParse({
        type: 'pie',
        title: 'Too many',
        items: Array.from({ length: 33 }, (_, i) => ({ label: `I${i}`, value: 1 })),
      }).success,
    ).toBe(false)
    expect(
      visualizationSchema.safeParse({
        type: 'scatter',
        title: 'Points',
        series: [
          {
            name: 'S',
            points: Array.from({ length: 129 }, (_, i) => ({ x: i, y: i })),
          },
        ],
      }).success,
    ).toBe(false)
    expect(
      visualizationSchema.safeParse({
        type: 'comparison',
        title: 'Wide',
        columns: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'],
        rows: [{ label: 'R', values: ['1', '2', '3', '4', '5', '6', '7', '8', '9'] }],
      }).success,
    ).toBe(false)
  })

  it('parses every ari-viz example published in the shared skill', () => {
    const skillPath = join(
      dirname(fileURLToPath(import.meta.url)),
      '../../../apps/desktop/resources/cli/ari/SKILL.md',
    )
    const skill = readFileSync(skillPath, 'utf8')
    const section = skill.slice(
      skill.indexOf('## Inline visualizations'),
      skill.indexOf('## Typed tasks'),
    )
    expect(section).toContain('Do not nest fields under a `data` object')
    expect(section).not.toContain('title, and data')
    const examples = [...section.matchAll(/```ari-viz\r?\n([\s\S]*?)\r?\n```/g)].map((match) =>
      match[1]?.trim(),
    )
    expect(examples).toHaveLength(2)
    for (const example of examples) {
      const parsed = parseVisualization(example ?? '')
      expect(parsed.ok).toBe(true)
    }
  })
})
