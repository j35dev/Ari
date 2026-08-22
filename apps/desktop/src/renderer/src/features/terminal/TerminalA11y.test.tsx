import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { TerminalA11y } from './TerminalA11y'

describe('TerminalA11y', () => {
  it('renders a polite status region announcing the terminal title', () => {
    render(<TerminalA11y title="zsh — ari" />)

    const region = screen.getByRole('status')
    expect(region).toHaveAttribute('aria-live', 'polite')
    expect(region).toHaveAttribute('aria-atomic', 'true')
    expect(region).toHaveTextContent('Terminal: zsh — ari')
  })

  it('re-announces when the title changes', () => {
    const { rerender } = render(<TerminalA11y title="zsh — ari" />)
    rerender(<TerminalA11y title="node repl" />)

    expect(screen.getByRole('status')).toHaveTextContent('Terminal: node repl')
  })
})
