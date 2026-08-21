import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Button } from './Button'

describe('Button', () => {
  it('renders children', () => {
    render(<Button>Save</Button>)
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument()
  })

  it('applies the requested variant classes', () => {
    render(<Button variant="primary">Go</Button>)
    expect(screen.getByRole('button')).toHaveClass('bg-accent', 'text-fg-on-accent')
  })

  it('defaults to secondary variant and md size', () => {
    render(<Button>Go</Button>)
    expect(screen.getByRole('button')).toHaveClass('bg-surface-2', 'h-9')
  })

  it('renders the shortcut chip', () => {
    render(<Button shortcut="Ctrl+K">Palette</Button>)
    expect(screen.getByText('Ctrl+K')).toBeInTheDocument()
  })

  it('marks itself busy and inert to pointers while loading', () => {
    render(<Button loading>Go</Button>)
    const button = screen.getByRole('button')
    expect(button).toHaveAttribute('aria-busy', 'true')
    expect(button).toHaveClass('pointer-events-none')
  })

  it('passes through disabled', () => {
    render(<Button disabled>Go</Button>)
    expect(screen.getByRole('button')).toBeDisabled()
  })
})
