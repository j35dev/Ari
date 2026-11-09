import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { AriaMark } from './AriaMark'

describe('AriaMark', () => {
  it.each([
    ['idle', 'Ready'],
    ['thinking', 'Thinking'],
    ['working', 'Sessions running'],
    ['attention', 'Needs you'],
  ] as const)('renders %s with an accessible name and state', (state, description) => {
    render(<AriaMark state={state} />)
    const mark = screen.getByRole('img', { name: 'Aria' })
    expect(mark).toHaveAttribute('data-state', state)
    expect(mark).toHaveAttribute('aria-description', description)
    expect(mark).toHaveAttribute('width', '16')
    expect(mark).toHaveAttribute('height', '16')
  })

  it('accepts a name, size and row styling', () => {
    render(<AriaMark size={12} title="Aria needs your input" className="row-mark" />)
    const mark = screen.getByRole('img', { name: 'Aria needs your input' })
    expect(mark).toHaveClass('row-mark')
    expect(mark).toHaveAttribute('width', '12')
    expect(mark).toHaveAttribute('data-small', 'true')
    expect(mark.querySelector('title')).toHaveTextContent('Aria needs your input')
  })

  it('keeps the closed idle circle and opens a gap only for thinking', () => {
    const { container } = render(
      <>
        <AriaMark size={64} />
        <AriaMark size={12} state="thinking" />
      </>,
    )
    const marks = Array.from(container.querySelectorAll('svg'))
    expect(marks[0]?.querySelector('circle')).not.toHaveAttribute('stroke-dasharray')
    expect(marks[1]?.querySelector('circle')).toHaveAttribute('stroke-dasharray', '78 22')
    expect(marks[0]).toHaveAttribute('stroke-width', '2.3')
    expect(marks[1]).toHaveAttribute('stroke-width', '2.6')
    expect(container.querySelector('defs, filter, image')).toBeNull()
  })
})
