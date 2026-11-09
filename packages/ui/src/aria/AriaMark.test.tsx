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

  it('gives every state a different eye expression without relying on color', () => {
    const { container } = render(
      <>
        <AriaMark state="idle" />
        <AriaMark state="thinking" />
        <AriaMark state="working" />
        <AriaMark state="attention" />
      </>,
    )
    const expressions = Array.from(container.querySelectorAll('svg')).map((mark) => {
      const eyes = mark.querySelectorAll('.ari-aria-mark-eyes rect')
      expect(eyes).toHaveLength(2)
      return `${eyes[0]?.getAttribute('width')} ${eyes[0]?.getAttribute('height')}`
    })
    expect(new Set(expressions).size).toBe(4)
  })

  it('omits the small nose in sidebar sizes and keeps the larger art flat', () => {
    const { container } = render(
      <>
        <AriaMark size={64} />
        <AriaMark size={16} />
      </>,
    )
    const marks = Array.from(container.querySelectorAll('svg'))
    expect(marks[0]?.querySelector('path.ari-aria-mark-ink')).not.toBeNull()
    expect(marks[1]?.querySelector('path.ari-aria-mark-ink')).toBeNull()
    expect(container.querySelector('defs, filter, image')).toBeNull()
  })
})
