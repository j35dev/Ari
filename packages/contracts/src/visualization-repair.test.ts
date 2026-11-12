import { describe, expect, it } from 'vitest'
import { parseVisualization, type VisualizationSpec } from './visualization'

function parsed(input: unknown): VisualizationSpec {
  const result = parseVisualization(JSON.stringify(input))
  if (!result.ok) throw new Error(result.error)
  return result.value
}
function rejected(input: unknown): string {
  const result = parseVisualization(JSON.stringify(input))
  if (result.ok) throw new Error('expected the visualization to fail')
  return result.error
}

describe('visualization repair', () => {
  it('reads the chart an agent wrote with series data instead of values', () => {
    // The reply that showed "Visualization unavailable" in a real session.
    const spec = parsed({
      version: 1,
      type: 'bar',
      title: 'HTML files by size (KB)',
      labels: ['herbarium', 'deepseek', 'simple'],
      series: [{ name: 'Size (KB)', data: [50.8, 26.4, 0.8] }],
    })
    expect(spec).toMatchObject({
      type: 'bar',
      labels: ['herbarium', 'deepseek', 'simple'],
      series: [{ name: 'Size (KB)', values: [50.8, 26.4, 0.8] }],
    })
  })

  it('accepts the dataset vocabulary of other chart libraries', () => {
    expect(
      parsed({
        type: 'Line Chart',
        title: 'Trend',
        categories: ['Jan', 'Feb'],
        datasets: [{ label: 'Visits', data: ['1,200', '1500'], borderColor: '#f00' }],
      }),
    ).toMatchObject({
      type: 'line',
      labels: ['Jan', 'Feb'],
      series: [{ name: 'Visits', values: [1200, 1500] }],
    })
    expect(
      parsed({
        type: 'bar',
        title: 'Named',
        labels: ['A', 'B'],
        series: { One: [1, 2], Two: [3, 4] },
      }),
    ).toMatchObject({
      series: [
        { name: 'One', values: [1, 2] },
        { name: 'Two', values: [3, 4] },
      ],
    })
  })

  it('turns one list of labelled rows into labels and a single series', () => {
    const rows = [
      { name: 'index.html', value: 6.2 },
      { name: 'simple.html', value: 0.8 },
    ]
    for (const field of ['data', 'items', 'series']) {
      expect(parsed({ type: 'bar', title: 'Sizes', unit: 'KB', [field]: rows })).toMatchObject({
        labels: ['index.html', 'simple.html'],
        series: [{ name: 'KB', values: [6.2, 0.8] }],
      })
    }
    expect(
      parsed({ type: 'bar', title: 'Bare', labels: ['A', 'B'], values: [1, 2] }),
    ).toMatchObject({
      series: [{ name: 'Value', values: [1, 2] }],
    })
    expect(
      parsed({
        type: 'line',
        title: 'Points',
        series: [
          {
            name: 'Visits',
            points: [
              { x: 'Mon', y: 3 },
              { x: 'Tue', y: 5 },
            ],
          },
        ],
      }),
    ).toMatchObject({ labels: ['Mon', 'Tue'], series: [{ name: 'Visits', values: [3, 5] }] })
  })

  it('builds parts from parallel arrays or renamed item fields', () => {
    expect(
      parsed({ type: 'doughnut', title: 'Split', labels: ['A', 'B'], values: [3, 1] }),
    ).toMatchObject({
      type: 'donut',
      items: [
        { label: 'A', value: 3 },
        { label: 'B', value: 1 },
      ],
    })
    expect(
      parsed({ type: 'pie', title: 'Share', data: [{ name: 'Core', count: '3', color: 'red' }] }),
    ).toMatchObject({ items: [{ label: 'Core', value: 3 }] })
  })

  it('normalises graphs, timelines, schedules, heatmaps, scatter and tables', () => {
    expect(
      parsed({
        type: 'flowchart',
        title: 'Flow',
        direction: 'TB',
        nodes: [{ id: 1, name: 'Start', shape: 'diamond', tone: 'good' }, { id: 2 }],
        links: [{ source: 1, target: 2, text: 'then' }],
      }),
    ).toMatchObject({
      type: 'graph',
      direction: 'down',
      nodes: [
        { id: '1', label: 'Start', shape: 'decision', tone: 'success' },
        { id: '2', label: '2' },
      ],
      edges: [{ from: '1', to: '2', label: 'then' }],
    })
    expect(parsed({ type: 'graph', title: 'Lone', nodes: [{ id: 'a' }] })).toMatchObject({
      edges: [],
    })
    expect(
      parsed({
        type: 'timeline',
        title: 'Releases',
        milestones: [{ title: 'Shipped', year: 2026, details: 'First cut', tone: 'neutral' }],
      }),
    ).toMatchObject({
      events: [{ label: 'Shipped', date: '2026', description: 'First cut', tone: 'accent' }],
    })
    expect(
      parsed({ type: 'gantt', title: 'Plan', items: [{ name: 'Design', from: '0', to: 2 }] }),
    ).toMatchObject({ tasks: [{ label: 'Design', start: 0, end: 2 }] })
    expect(
      parsed({
        type: 'heatmap',
        title: 'Load',
        columns: ['Mon', 'Tue'],
        rows: ['AM'],
        matrix: [['1', 2]],
      }),
    ).toMatchObject({ xLabels: ['Mon', 'Tue'], yLabels: ['AM'], values: [[1, 2]] })
    expect(
      parsed({
        type: 'scatter',
        title: 'Points',
        data: [
          [1, 2],
          [3, 4],
        ],
      }),
    ).toMatchObject({
      series: [
        {
          name: 'Points',
          points: [
            { x: 1, y: 2 },
            { x: 3, y: 4 },
          ],
        },
      ],
    })
    expect(
      parsed({
        type: 'table',
        title: 'Choice',
        headers: ['', 'Local', 'Hosted'],
        rows: [['Network', 'Optional', true], { name: 'Cost', cells: [0, 20] }],
      }),
    ).toMatchObject({
      type: 'comparison',
      columns: ['Local', 'Hosted'],
      rows: [
        { label: 'Network', values: ['Optional', 'Yes'] },
        { label: 'Cost', values: ['0', '20'] },
      ],
    })
    expect(
      parsed({
        type: 'kpi',
        title: 'Figures',
        metrics: [{ name: 'Saved', value: '4 h', note: 'per week' }],
      }),
    ).toMatchObject({
      type: 'metrics',
      items: [{ label: 'Saved', value: '4 h', detail: 'per week' }],
    })
  })

  it('never overrides a published field, invents data, or lets unknown input through', () => {
    // The published field wins, so its alias is left for the schema to refuse.
    expect(
      rejected({ type: 'pie', title: 'Both', items: [{ label: 'A', name: 'B', value: 1 }] }),
    ).toBe('Pie charts cannot include "name".')
    // Text that only looks numeric is not a number.
    expect(
      rejected({
        type: 'bar',
        title: 'Units',
        labels: ['A'],
        series: [{ name: 'S', values: ['4 h'] }],
      }),
    ).toBe('Bar charts need valid values.')
    expect(rejected({ type: 'bar', title: 'Short', labels: ['A', 'B'], values: [1] })).toBe(
      'Each series must have one value per label.',
    )
    expect(rejected({ type: 'pie', title: 'Ragged', labels: ['A', 'B'], values: [1] })).toMatch(
      /^Pie charts/,
    )
    expect(rejected({ type: 'graph', title: 'Tone', nodes: [{ id: 'a', tone: '#ff0000' }] })).toBe(
      'Graph charts need a valid tone.',
    )
    expect(rejected({ type: 'chart', title: 'Vague' })).toBe(
      'A visualization needs a supported type.',
    )
    // Reserved keys nested in rows are dropped, never copied onto an object.
    const nested = parseVisualization(
      '{"type":"pie","title":"T","items":[{"label":"A","value":1,"__proto__":{"polluted":true}}]}',
    )
    expect(nested.ok).toBe(true)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })
})
