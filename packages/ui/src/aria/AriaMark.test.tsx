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

  it('keeps gradient references separate when several marks share a page', () => {
    const { container } = render(
      <>
        <AriaMark size={64} />
        <AriaMark size={12} state="thinking" />
      </>,
    )
    const marks = Array.from(container.querySelectorAll('svg'))
    const ids = marks.map((mark) => mark.querySelector('radialGradient')?.id)
    expect(new Set(ids).size).toBe(2)
    marks.forEach((mark, index) => {
      expect(mark.querySelector('[fill^="url"]')).toHaveAttribute('fill', `url(#${ids[index]})`)
      expect(mark.querySelector('filter')).toBeNull()
    })
  })
})
