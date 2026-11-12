import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { Kbd } from './Kbd'

afterEach(cleanup)

describe('Kbd', () => {
  it('renders its key text inside a kbd element with mono chip styling', () => {
    render(<Kbd>⌘K</Kbd>)
    const el = screen.getByText('⌘K')
    expect(el.tagName).toBe('KBD')
    expect(el).toHaveClass('font-mono', 'text-[11px]', 'border', 'border-border', 'text-fg-subtle')
    // An outline only: the chip has no fill.
    expect(el).not.toHaveClass('bg-surface-2')
  })
})
