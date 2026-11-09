import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { visualizationSchema } from '@ari/contracts/visualization'
import { Visualization } from './Visualization'
import { visualizationExamples } from './examples'
import { axis, domain, formatNumber } from './charts'

const bar = visualizationExamples[0]?.spec
if (bar === undefined) throw new Error('Missing example')
const source = JSON.stringify(bar)
describe('inline visualizations', () => {
  it.each(visualizationExamples)(
    'renders a $spec.type visualization with inspectable data',
    ({ spec }) => {
      const validated = visualizationSchema.parse(spec)
      const { container } = render(<Visualization source={JSON.stringify(spec)} />)
      const figure = screen.getByRole('figure', { name: validated.title })
      expect(container.querySelector('.ari-viz-error')).toBeNull()
      if (validated.type !== 'comparison')
        fireEvent.click(within(figure).getByRole('button', { name: 'Data' }))
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
            { id: 'b', label: 'B' },
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
    fireEvent.click(screen.getByRole('button', { name: 'Data' }))
    expect(screen.getByRole('table')).toHaveTextContent('0.0000123')
  })
})
