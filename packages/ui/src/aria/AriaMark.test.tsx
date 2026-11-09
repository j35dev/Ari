import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { AriaMark } from './AriaMark'

describe('AriaMark', () => {
  it.each([
    ['idle', 'Ready', 2, 6],
    ['thinking', 'Thinking', 2, 6],
    ['working', 'Sessions running', 1, 7],
    ['attention', 'Needs you', 3, 5],
  ] as const)('renders %s with an accessible name and state', (state, description, height, y) => {
    render(<AriaMark state={state} />)
    const mark = screen.getByRole('img', { name: 'Aria' })
    expect(mark).toHaveAttribute('data-state', state)
    expect(mark).toHaveAttribute('aria-description', description)
    expect(mark).toHaveAttribute('width', '16')
    expect(mark).toHaveAttribute('height', '16')
    const eyes = mark.querySelectorAll('.ari-aria-mark-eyes rect')
    expect(eyes).toHaveLength(2)
    eyes.forEach((eye) => {
      expect(eye).toHaveAttribute('height', String(height))
      expect(eye).toHaveAttribute('y', String(y))
    })
  })

  it('accepts a name, size and row styling', () => {
    render(<AriaMark size={12} title="Aria needs your input" className="row-mark" />)
    const mark = screen.getByRole('img', { name: 'Aria needs your input' })
    expect(mark).toHaveClass('row-mark')
    expect(mark).toHaveAttribute('width', '12')
    expect(mark.querySelector('title')).toHaveTextContent('Aria needs your input')
  })

  it('keeps square pixels on the same grid at sidebar and larger sizes', () => {
    const { container } = render(
      <>
        <AriaMark size={64} />
        <AriaMark size={28} />
        <AriaMark size={16} />
      </>,
    )
    const marks = Array.from(container.querySelectorAll('svg'))
    marks.forEach((mark) => {
      expect(mark).toHaveAttribute('viewBox', '0 0 16 16')
      expect(mark).toHaveAttribute('shape-rendering', 'crispEdges')
      const pixels = mark.querySelectorAll('rect')
      expect(pixels).toHaveLength(10)
      pixels.forEach((pixel) => {
        expect(pixel).not.toHaveAttribute('rx')
        for (const attribute of ['x', 'y', 'width', 'height']) {
          expect(Number.isInteger(Number(pixel.getAttribute(attribute)))).toBe(true)
        }
      })
    })
    expect(container.querySelector('defs, filter, image, path, circle, ellipse')).toBeNull()
  })
})
