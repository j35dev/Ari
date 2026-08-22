import { act, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { WorkingGlyph } from './WorkingGlyph'

/**
 * Motion animations share jsdom's requestAnimationFrame clock, so these tests
 * use real timers — faking any timer stalls the frameloop.
 */
const waitMs = (ms: number): Promise<void> =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms))
  })

describe('WorkingGlyph', () => {
  it('renders the default flavour word and a nine-cell matrix', () => {
    const { container } = render(<WorkingGlyph />)

    expect(screen.getByText('forging…')).toBeInTheDocument()
    expect(container.querySelectorAll('.size-1')).toHaveLength(9)
  })

  it('shows a fixed label instead of flavour words', () => {
    render(<WorkingGlyph label="compiling" />)

    expect(screen.getByText('compiling…')).toBeInTheDocument()
    expect(screen.queryByText('forging…')).not.toBeInTheDocument()
  })

  it('cycles to the next flavour word after two seconds', async () => {
    render(<WorkingGlyph />)

    await waitMs(2300)

    expect(await screen.findByText('thinking…', {}, { timeout: 3000 })).toBeInTheDocument()
    expect(screen.queryByText('forging…')).not.toBeInTheDocument()
  })
})
