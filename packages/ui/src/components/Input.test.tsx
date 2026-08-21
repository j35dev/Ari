import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Input } from './Input'

describe('Input', () => {
  it('renders the native input and forwards placeholder', () => {
    render(<Input placeholder="Session name" />)
    expect(screen.getByRole('textbox')).toHaveAttribute(
      'placeholder',
      'Session name',
    )
  })

  it('renders the leading slot inside the wrapper', () => {
    render(<Input leading={<span data-testid="lead">@</span>} />)
    expect(screen.getByTestId('lead')).toBeInTheDocument()
    expect(screen.getByRole('textbox')).toBeInTheDocument()
  })

  it('renders the trailing slot inside the wrapper', () => {
    render(<Input trailing={<kbd data-testid="trail">⌘K</kbd>} />)
    expect(screen.getByTestId('trail')).toBeInTheDocument()
  })

  it('invalid sets aria-invalid on the input', () => {
    const { rerender } = render(<Input />)
    expect(screen.getByRole('textbox').getAttribute('aria-invalid')).toBeNull()
    rerender(<Input invalid />)
    expect(screen.getByRole('textbox').getAttribute('aria-invalid')).toBe('true')
  })

  it('forwards ref to the underlying input element', () => {
    let el: HTMLInputElement | null = null
    render(
      <Input
        ref={(node) => {
          el = node
        }}
      />,
    )
    expect(el).toBe(screen.getByRole('textbox'))
  })
})
