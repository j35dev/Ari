import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SegmentedControl } from './SegmentedControl'

afterEach(cleanup)

const options = [
  { value: 'day', label: 'Day' },
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' },
]

describe('SegmentedControl', () => {
  it('selects on click and reports onChange', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(
      <SegmentedControl
        options={options}
        defaultValue="day"
        onChange={onChange}
        aria-label="Range"
      />,
    )
    const week = screen.getByRole('button', { name: 'Week' })
    await user.click(week)
    expect(onChange).toHaveBeenCalledWith('week')
    expect(week).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Day' })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
  })

  it('renders a single thumb element inside the selected option', () => {
    const { container } = render(
      <SegmentedControl options={options} defaultValue="month" aria-label="Range" />,
    )
    const thumb = container.querySelector('[data-thumb]')
    expect(thumb).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Month' }).contains(thumb)).toBe(
      true,
    )
  })

  it('defers to the controlled value', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    const { rerender } = render(
      <SegmentedControl options={options} value="day" onChange={onChange} />,
    )
    await user.click(screen.getByRole('button', { name: 'Week' }))
    expect(onChange).toHaveBeenCalledWith('week')
    expect(screen.getByRole('button', { name: 'Day' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    rerender(<SegmentedControl options={options} value="week" onChange={onChange} />)
    expect(screen.getByRole('button', { name: 'Week' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
  })
})
