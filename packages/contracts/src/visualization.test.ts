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
})
