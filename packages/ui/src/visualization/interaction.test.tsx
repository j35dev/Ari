import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Visualization } from './Visualization'
import { visualizationExamples } from './examples'

const source = JSON.stringify(visualizationExamples[0]?.spec)
function hover(target: Element): void {
  const event = new MouseEvent('pointermove', { clientX: 300, clientY: 200, bubbles: true })
  Object.defineProperty(event, 'pointerType', { value: 'mouse' })
  fireEvent(target, event)
}
describe('visualization data tooltips', () => {
  it('shows every visible series with exact values on hover and dismisses on blank space', async () => {
    const { container } = render(<Visualization source={source} />)
    const mark = screen.getByRole('img', { name: 'Before · Research: 12 hours' })
    hover(mark)
    const tooltip = await screen.findByRole('tooltip')
    expect(tooltip).toHaveTextContent('Research')
    expect(tooltip).toHaveTextContent('12 hours')
    expect(tooltip).toHaveTextContent('5 hours')
    expect(mark).toHaveAttribute('aria-describedby', tooltip.id)
    const surface = container.querySelector('.ari-viz-interactive')
    if (surface === null) throw new Error('Missing interaction surface')
    hover(surface)
    expect(screen.queryByRole('tooltip')).toBeNull()
  })
  it('pins with keyboard or touch click and gives Escape priority over closing a dialog', async () => {
    render(<Visualization source={source} />)
    fireEvent.click(screen.getByRole('button', { name: 'Expand visualization' }))
    const dialog = screen.getByRole('dialog')
    const mark = within(dialog).getByRole('img', { name: 'Before · Research: 12 hours' })
    fireEvent.focus(mark)
    await screen.findByRole('tooltip')
    fireEvent.keyDown(mark, { key: 'Enter' })
    expect(screen.getByRole('tooltip')).toHaveTextContent('Pinned')
    expect(mark).toHaveAttribute('data-viz-pinned', 'true')
    hover(within(dialog).getByRole('img', { name: 'Before · Review: 9 hours' }))
    expect(screen.getByRole('tooltip')).toHaveTextContent('Research')
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('tooltip')).toBeNull()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    fireEvent.click(mark)
    await screen.findByRole('tooltip')
    expect(screen.getByRole('tooltip')).toHaveTextContent('Pinned')
    fireEvent.click(mark)
    expect(screen.queryByRole('tooltip')).toBeNull()
    fireEvent.keyDown(document, { key: 'Escape' })
    await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })
  it('keeps source labels as text in tooltips and clears an inspection when series change', async () => {
    const { container } = render(
      <Visualization
        source={JSON.stringify({
          type: 'bar',
          title: 'Safe',
          labels: ['<img onerror=bad()>'],
          series: [
            { name: '<script>bad()</script>', values: [12345.6789] },
            { name: 'Other', values: [2] },
          ],
        })}
      />,
    )
    const mark = container.querySelector('[data-viz-detail]')
    if (!mark) throw new Error('Missing point')
    fireEvent.focus(mark)
    const tooltip = await screen.findByRole('tooltip')
    expect(tooltip).toHaveTextContent('<img onerror=bad()>')
    expect(tooltip).toHaveTextContent('12345.6789')
    expect(tooltip.querySelector('img, script')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Other' }))
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('clears pinned marks when switching bar orientation from the keyboard', async () => {
    render(<Visualization source={source} />)
    const mark = screen.getByRole('img', { name: 'Before · Research: 12 hours' })
    fireEvent.click(mark)
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Pinned')
    fireEvent.click(screen.getByRole('button', { name: 'Show bars as rows' }))
    expect(screen.queryByRole('tooltip')).toBeNull()
    expect(screen.getByRole('img', { name: 'Before · Research: 12 hours' })).not.toBe(mark)
  })
})
