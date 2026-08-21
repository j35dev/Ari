import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { Kbd } from './Kbd'

afterEach(cleanup)

describe('Kbd', () => {
  it('renders its key text inside a kbd element with mono chip styling', () => {
    render(<Kbd>⌘K</Kbd>)
    const el = screen.getByText('⌘K')
    expect(el.tagName).toBe('KBD')
    expect(el).toHaveClass('font-mono', 'text-2xs', 'bg-surface-2', 'border-border')
  })
})
