import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { IrisTile } from './IrisTile'
import { irisHue } from './iris-tile'

describe('IrisTile', () => {
  it('renders a nine-cell constellation for a seeded project', () => {
    const { container } = render(<IrisTile seed="proj-1" colorIndex={2} />)
    const tile = container.querySelector('[data-iris-tile]')
    expect(tile).not.toBeNull()
    expect(tile).not.toHaveAttribute('data-fallback')
    expect(tile?.querySelectorAll(':scope > span')).toHaveLength(9)
    expect(tile).toHaveStyle({ '--iris-h': String(irisHue(2)) })
  })

  it('chases the ring while running', () => {
    const { container } = render(<IrisTile seed="engine" running />)
    expect(container.querySelector('[data-iris-tile]')).toHaveAttribute('data-running')
  })

  it('falls back to a letter when the seed is empty', () => {
    const { container } = render(<IrisTile seed="" name="docs" />)
    const tile = container.querySelector('[data-iris-tile]')
    expect(tile).toHaveAttribute('data-fallback')
    expect(tile).toHaveTextContent('D')
    expect(tile?.querySelectorAll(':scope > span')).toHaveLength(1)
  })
})
