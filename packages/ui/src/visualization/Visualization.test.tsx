import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { visualizationSchema } from '@ari/contracts/visualization'
import { Visualization } from './Visualization'
import { visualizationExamples } from './examples'
import {
  axis,
  clipLabel,
  color,
  domain,
  formatNumber,
  heatCellWidth,
  heatFillOpacity,
  heatShowsValue,
  textWidth,
} from './charts'

const bar = visualizationExamples[0]?.spec
if (bar === undefined) throw new Error('Missing example')
const source = JSON.stringify(bar)
const visualTypes = [
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

describe('inline visualizations', () => {
  it('covers each supported type once', () => {
    expect(visualizationExamples.map((example) => example.spec.type)).toEqual(visualTypes)
  })
  it.each(visualizationExamples)(
    'renders a $spec.type visualization with inspectable data',
    ({ spec }) => {
      const validated = visualizationSchema.parse(spec)
      const { container } = render(<Visualization source={JSON.stringify(spec)} />)
      const figure = screen.getByRole('figure', { name: validated.title })
      expect(container.querySelector('.ari-viz-error')).toBeNull()
      if (validated.type !== 'comparison')
        fireEvent.click(within(figure).getByRole('button', { name: 'Show data table' }))
      expect(within(figure).getByRole('table')).toHaveAccessibleName(`${validated.title} — data`)
      expect(within(figure).getAllByRole('row').length).toBeGreaterThan(1)
    },
  )
  it('keeps at least one series visible and lets keyboard users inspect marks', () => {
    render(<Visualization source={source} />)
    const before = screen.getByRole('button', { name: 'Before' })
    const after = screen.getByRole('button', { name: 'After' })
    fireEvent.click(before)
    expect(before).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(after)
    expect(after).toHaveAttribute('aria-pressed', 'true')
    const mark = screen.getByRole('img', { name: 'After · Research: 5 hours' })
    fireEvent.focus(mark)
    expect(screen.getByRole('status')).toHaveTextContent('After · Research: 5 hours')
  })
  it('shows bounded failures and treats HTML in labels as text', () => {
    const { container, rerender } = render(<Visualization source="{incomplete" pending />)
    expect(screen.getByRole('status')).toHaveTextContent('Building visualization')
    rerender(<Visualization source="{incomplete" />)
    expect(screen.getByText('Visualization unavailable')).toBeInTheDocument()
    rerender(
      <Visualization
        source={JSON.stringify({
          version: 1,
          type: 'metrics',
          title: '<img src=x onerror=alert(1)>',
          items: [{ label: '<script>bad()</script>', value: 2 }],
        })}
      />,
    )
    expect(container.querySelector('script, img, iframe')).toBeNull()
    expect(screen.getByText('<script>bad()</script>')).toBeInTheDocument()
  })
  it('copies the source and handles an unavailable clipboard', async () => {
    const copy = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText: copy } })
    try {
      render(<Visualization source={source} />)
      fireEvent.click(screen.getByRole('button', { name: 'Copy visualization data' }))
      await vi.waitFor(() => expect(screen.getByText('Copied')).toBeInTheDocument())
      expect(copy).toHaveBeenCalledWith(source)
      copy.mockRejectedValueOnce(new Error('Unavailable'))
      fireEvent.click(screen.getByRole('button', { name: 'Copy visualization data' }))
      await vi.waitFor(() => expect(screen.getByText('Copy unavailable')).toBeInTheDocument())
    } finally {
      vi.unstubAllGlobals()
    }
  })
  it('expands through Ari’s shared dialog and closes with Escape', async () => {
    render(<Visualization source={source} />)
    fireEvent.click(screen.getByRole('button', { name: 'Expand visualization' }))
    expect(screen.getByRole('dialog')).toHaveAccessibleName('Time back, every week')
    fireEvent.keyDown(document, { key: 'Escape' })
    await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })
  it('renders self loops, cycles, zero slices, flat domains and negative bars without invalid geometry', () => {
    const { container, rerender } = render(
      <Visualization
        source={JSON.stringify({
          type: 'graph',
          title: 'Cycle',
          nodes: [
            { id: 'a', label: 'A' },
            { id: 'b', label: 'B', tone: 'warning' },
          ],
          edges: [
            { from: 'a', to: 'a' },
            { from: 'a', to: 'b' },
            { from: 'b', to: 'a' },
          ],
        })}
      />,
    )
    expect(container.innerHTML).not.toMatch(/NaN|Infinity/)
    // Position is not a category: only the node given a tone carries colour.
    const fills = [...container.querySelectorAll('rect')].map((rect) => rect.getAttribute('fill'))
    expect(fills.filter((fill) => fill === 'var(--ari-warning)')).toHaveLength(1)
    expect(fills.filter((fill) => fill === color(0) || fill === color(1))).toEqual([])
    rerender(
      <Visualization
        source={JSON.stringify({
          type: 'donut',
          title: 'One slice',
          items: [
            { label: 'Zero', value: 0 },
            { label: 'All', value: 1 },
          ],
        })}
      />,
    )
    expect(container.innerHTML).not.toMatch(/NaN|Infinity/)
    rerender(
      <Visualization
        source={JSON.stringify({ ...bar, series: [{ name: 'Negative', values: [-5, 0, 5, -2] }] })}
      />,
    )
    expect(container.innerHTML).not.toMatch(/NaN|Infinity/)
    expect(domain([0, 0])).toEqual([-1, 1])
  })

  it('renders one historical data wrapper and refuses conflicts without echoing markup', () => {
    const historical =
      '{"version":1,"type":"timeline","title":"Release progress","data":{"events":[{"label":"v0.2.0","date":"2026-08-30","description":"Previous release"},{"label":"v0.3.13","date":"in progress","tone":"warning"}]}}'
    const { rerender } = render(<Visualization source={historical} />)
    expect(screen.getByRole('figure')).toBeInTheDocument()
    expect(screen.getByText('v0.2.0')).toBeInTheDocument()
    expect(screen.getByText('Previous release')).toBeInTheDocument()
    expect(screen.getByText('v0.3.13').closest('li')?.getAttribute('style')).toContain(
      'var(--ari-warning)',
    )
    expect(screen.getByText('v0.2.0').closest('li')?.getAttribute('style')).toContain(
      'var(--ari-accent)',
    )
    const script = '<script>alert(1)</script>'
    rerender(
      <Visualization
        source={JSON.stringify({
          version: 1,
          type: 'timeline',
          title: script,
          events: [{ label: 'A' }],
          html: script,
        })}
      />,
    )
    expect(screen.getByText('Visualization unavailable')).toBeInTheDocument()
    expect(screen.getByText('Timeline charts cannot include "html".')).toBeInTheDocument()
    expect(screen.queryByRole('figure')).toBeNull()
    expect(document.body.querySelector('script')).toBeNull()
    expect(document.body.textContent).not.toContain(script)
    expect(document.body.textContent).not.toContain('Invalid input')
    rerender(
      <Visualization
        source={JSON.stringify({
          version: 1,
          type: 'bar',
          title: 'Conflict',
          labels: ['Visible'],
          data: {
            type: 'bar',
            title: 'Conflict',
            labels: ['Hidden'],
            series: [{ name: 'S', values: [1] }],
          },
        })}
      />,
    )
    expect(screen.getByText(/The field "type" is set both/)).toBeInTheDocument()
    expect(screen.queryByText('Hidden')).toBeNull()
    expect(screen.queryByText('Visible')).toBeNull()
    rerender(<Visualization source={JSON.stringify({ data: bar })} />)
    expect(screen.getByRole('figure', { name: bar.title as string })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Before' })).toBeInTheDocument()
  })

  it('separates heatmap magnitudes and keeps long digits out of narrow cells', () => {
    expect(heatFillOpacity(100, 100) - heatFillOpacity(1, 100)).toBeGreaterThan(0.6)
    expect(heatFillOpacity(0, 100)).toBe(1)
    expect(heatFillOpacity(-8, 8)).toBe(heatFillOpacity(8, 8))
    const wide = {
      version: 1,
      type: 'heatmap',
      title: 'Load',
      xLabels: ['Low', 'High'],
      yLabels: ['Row'],
      values: [[1, 100]],
      unit: 'requests',
    }
    const { container, rerender } = render(<Visualization source={JSON.stringify(wide)} />)
    const opacities = [...container.querySelectorAll('rect')].map((rect) =>
      Number(rect.getAttribute('fill-opacity')),
    )
    expect(opacities).toEqual([heatFillOpacity(1, 100), heatFillOpacity(100, 100)])
    expect(container.querySelector('.ari-viz-heat-value')).toHaveTextContent(formatNumber(1))
    const narrowValue = 0.0000123
    const printed = formatNumber(narrowValue)
    const columns = Array.from({ length: 32 }, (_, i) => `C${i}`)
    expect(heatShowsValue(printed, heatCellWidth(columns.length))).toBe(false)
    rerender(
      <Visualization
        source={JSON.stringify({
          version: 1,
          type: 'heatmap',
          title: 'Dense',
          xLabels: columns,
          yLabels: ['Row'],
          values: [Array.from({ length: 32 }, () => narrowValue)],
        })}
      />,
    )
    expect(container.querySelector('.ari-viz-heat-value')).toBeNull()
    expect(
      [...container.querySelectorAll('title')].some((node) => node.textContent?.includes(printed)),
    ).toBe(true)
    expect(container.innerHTML).not.toMatch(/NaN|Infinity/)
  })

  it('keeps long labels and units inside the chart without dropping them', () => {
    const unit = 'u'.repeat(30)
    const yLabel = 'y'.repeat(120)
    const funnelLabel = 'f'.repeat(120)
    const { container, rerender } = render(
      <Visualization
        source={JSON.stringify({
          version: 1,
          type: 'donut',
          title: 'Share',
          unit,
          items: [{ label: 'All', value: 1 }],
        })}
      />,
    )
    const caption = container.querySelector('.ari-viz-total')?.nextElementSibling
    expect(caption?.querySelector('title')?.textContent).toBe(unit)
    expect(
      [...(caption?.childNodes ?? [])]
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent)
        .join(''),
    ).toBe(clipLabel(unit, 16))
    rerender(
      <Visualization
        source={JSON.stringify({
          ...bar,
          orientation: 'horizontal',
          yLabel,
        })}
      />,
    )
    const axisTitle = [...container.querySelectorAll('title')].find(
      (node) => node.textContent === yLabel,
    )
    expect(
      [...(axisTitle?.parentElement?.childNodes ?? [])]
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent)
        .join(''),
    ).toBe(clipLabel(yLabel, 48))
    rerender(
      <Visualization
        source={JSON.stringify({
          version: 1,
          type: 'funnel',
          title: 'Steps',
          items: [{ label: funnelLabel, value: 4 }],
        })}
      />,
    )
    expect(screen.getByText(funnelLabel)).toHaveClass('ari-viz-funnel-label')
    const pieLabel = 'p'.repeat(120)
    const seriesName = 's'.repeat(120)
    rerender(
      <Visualization
        source={JSON.stringify({
          version: 1,
          type: 'pie',
          title: 'Share',
          items: [{ label: pieLabel, value: 1 }],
        })}
      />,
    )
    expect(screen.getByText(pieLabel)).toHaveClass('ari-viz-legend-label')
    rerender(
      <Visualization
        source={JSON.stringify({
          version: 1,
          type: 'bar',
          title: 'Series',
          labels: ['A'],
          series: [
            { name: seriesName, values: [1] },
            { name: 'Other', values: [2] },
          ],
        })}
      />,
    )
    expect(screen.getByText(seriesName)).toHaveClass('ari-viz-series-name')
    const timelineLabel = 't'.repeat(120)
    rerender(
      <Visualization
        source={JSON.stringify({
          version: 1,
          type: 'timeline',
          title: 'Long',
          events: [{ label: timelineLabel }],
        })}
      />,
    )
    expect(screen.getByText(timelineLabel)).toHaveClass('ari-viz-timeline-label')
    expect(container.innerHTML).not.toMatch(/NaN|Infinity/)
  })

  it('draws charts 1:1 in the measured reply width instead of stretching a fixed canvas', () => {
    const width = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get')
    try {
      for (const room of [368, 1246]) {
        width.mockReturnValue(room)
        const { unmount } = render(<Visualization source={source} />)
        const svg = screen.getByRole('img', { name: bar.title as string })
        // Text stays 12px at every width: the chart widens, its height does not grow.
        expect(svg).toHaveStyle({ width: `${room}px`, height: '300px' })
        expect(svg.getAttribute('viewBox')).toBe(`0 0 ${room} 300`)
        unmount()
      }
      width.mockReturnValue(368)
      const { container } = render(
        <Visualization
          source={JSON.stringify({
            version: 1,
            type: 'line',
            title: 'Long ends',
            labels: ['First '.repeat(12).trim(), 'Middle', 'Last '.repeat(12).trim()],
            series: [{ name: 'S', values: [1, 2, 3] }],
          })}
        />,
      )
      const svg = screen.getByRole('img', { name: 'Long ends' })
      const labels = [...container.querySelectorAll('text.ari-viz-axis-label')]
      expect(labels).toHaveLength(3)
      for (const label of labels) {
        const text = [...label.childNodes]
          .filter((node) => node.nodeType === Node.TEXT_NODE)
          .map((node) => node.textContent)
          .join('')
        const half = textWidth(text) / 2
        const x = Number(label.getAttribute('x'))
        expect(x - half).toBeGreaterThanOrEqual(0)
        expect(x + half).toBeLessThanOrEqual(parseFloat(svg.style.width))
      }
    } finally {
      width.mockRestore()
    }
  })

  it('fits schedules, pie charts and flows to a phone-width reply', () => {
    const width = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(368)
    try {
      const { container, rerender } = render(
        <Visualization
          source={JSON.stringify({
            version: 1,
            type: 'gantt',
            title: 'Plan',
            unit: 'days',
            tasks: [
              { label: 'Design', start: 0, end: 2 },
              { label: 'Build', start: 2, end: 5 },
            ],
          })}
        />,
      )
      const gantt = screen.getByRole('img', { name: 'Plan' })
      expect(Number(gantt.getAttribute('viewBox')?.split(' ')[2])).toBeLessThanOrEqual(368)
      rerender(
        <Visualization
          source={JSON.stringify({
            version: 1,
            type: 'graph',
            title: 'Flow',
            nodes: [
              { id: 'a', label: 'User prompt' },
              { id: 'b', label: 'Agent' },
              { id: 'c', label: 'Answer' },
            ],
            edges: [
              { from: 'a', to: 'b' },
              { from: 'b', to: 'c' },
            ],
          })}
        />,
      )
      expect(screen.getByRole('button', { name: 'Vertical' })).toHaveAttribute(
        'aria-pressed',
        'true',
      )
      fireEvent.click(screen.getByRole('button', { name: 'Horizontal' }))
      expect(screen.getByRole('button', { name: 'Horizontal' })).toHaveAttribute(
        'aria-pressed',
        'true',
      )
      rerender(
        <Visualization
          source={JSON.stringify({
            version: 1,
            type: 'radar',
            title: 'Tradeoffs',
            labels: ['Speed', 'Quality', 'Cost'],
            series: [{ name: 'Option', values: [3, 4, 2] }],
          })}
        />,
      )
      expect(
        parseFloat(screen.getByRole('img', { name: 'Tradeoffs' }).style.width),
      ).toBeLessThanOrEqual(368)
      expect(container.innerHTML).not.toMatch(/NaN|Infinity/)
    } finally {
      width.mockRestore()
    }
  })

  it('keeps a left-to-right flow when the reply width is unknown', () => {
    render(
      <Visualization
        source={JSON.stringify({
          version: 1,
          type: 'graph',
          title: 'Flow',
          nodes: [
            { id: 'a', label: 'A' },
            { id: 'b', label: 'B' },
            { id: 'c', label: 'C' },
          ],
          edges: [
            { from: 'a', to: 'b' },
            { from: 'b', to: 'c' },
          ],
        })}
      />,
    )
    expect(screen.getByRole('button', { name: 'Horizontal' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
  })

  it('uses legible axis steps and retains small values in the original data', () => {
    expect(axis([0, 61], true)).toEqual({ extent: [0, 80], ticks: [0, 20, 40, 60, 80] })
    expect(formatNumber(0.0000123)).not.toBe('0')
    render(
      <Visualization
        source={JSON.stringify({
          ...bar,
          series: [{ name: 'Small', values: [0.0000123, 0, 1, 2] }],
        })}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Show data table' }))
    expect(screen.getByRole('table')).toHaveTextContent('0.0000123')
  })

  it('draws many bars as ranked rows and names a lone series by the title alone', () => {
    const many = {
      version: 1,
      type: 'bar',
      title: 'Sizes',
      unit: 'KB',
      labels: Array.from({ length: 12 }, (_, i) => `file-${String(i)}`),
      series: [{ name: 'Size', values: Array.from({ length: 12 }, (_, i) => 12 - i) }],
    }
    const { container, unmount } = render(<Visualization source={JSON.stringify(many)} />)
    const flip = screen.getByRole('button', { name: 'Show bars as rows' })
    expect(flip).toHaveAttribute('aria-pressed', 'true')
    // One series: the title says what is plotted, so there is no legend to repeat it.
    expect(screen.queryByRole('group', { name: 'Data series' })).toBeNull()
    // A single series prints each value at its bar's tip.
    expect(container.querySelectorAll('.ari-viz-value-label')).toHaveLength(12)
    fireEvent.click(flip)
    expect(flip).toHaveAttribute('aria-pressed', 'false')
    unmount()
    // The agent's own choice of orientation is kept.
    render(<Visualization source={JSON.stringify({ ...many, orientation: 'vertical' })} />)
    expect(screen.getByRole('button', { name: 'Show bars as rows' })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
  })

  it('fits a long line to the reply and thins its labels instead of scrolling', () => {
    const width = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(600)
    try {
      const { container } = render(
        <Visualization
          source={JSON.stringify({
            version: 1,
            type: 'line',
            title: 'Day',
            labels: Array.from({ length: 48 }, (_, i) => `t${String(i)}`),
            series: [
              { name: 'A', values: Array.from({ length: 48 }, (_, i) => i) },
              { name: 'B', values: Array.from({ length: 48 }, (_, i) => 48 - i) },
            ],
          })}
        />,
      )
      expect(screen.getByRole('img', { name: 'Day' })).toHaveStyle({ width: '600px' })
      const printed = container.querySelectorAll('text.ari-viz-axis-label').length
      expect(printed).toBeGreaterThan(2)
      expect(printed).toBeLessThan(48)
      // Every point of every series is still there to inspect.
      expect(screen.getAllByRole('img', { name: /^[AB] · t\d+: / })).toHaveLength(96)
    } finally {
      width.mockRestore()
    }
  })
})
