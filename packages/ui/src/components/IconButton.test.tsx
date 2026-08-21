import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { IconButton } from './IconButton'

describe('IconButton', () => {
  it('exposes the required aria-label as its accessible name', () => {
    render(<IconButton icon={<svg data-testid="icon" />} aria-label="Close session" />)
    expect(screen.getByRole('button', { name: 'Close session' })).toBeInTheDocument()
    expect(screen.getByTestId('icon')).toBeInTheDocument()
  })

  it('is square at md size by default', () => {
    render(<IconButton icon="+" aria-label="Add" />)
    expect(screen.getByRole('button')).toHaveClass('h-9', 'w-9')
  })

  it('supports sm size and variants', () => {
    render(<IconButton icon="-" aria-label="Remove" size="sm" variant="danger" />)
    expect(screen.getByRole('button')).toHaveClass('h-7', 'w-7', 'bg-danger')
  })
})
