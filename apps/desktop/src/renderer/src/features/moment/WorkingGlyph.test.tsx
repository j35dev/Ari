import { act, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ElapsedSeconds, formatElapsed, WorkingGlyph } from './WorkingGlyph'

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

    expect(await screen.findByText('weighing…', {}, { timeout: 3000 })).toBeInTheDocument()
    expect(screen.queryByText('forging…')).not.toBeInTheDocument()
  })
})

describe('formatElapsed', () => {
  it('formats seconds under a minute and minutes beyond', () => {
    expect(formatElapsed(0)).toBe('0s')
    expect(formatElapsed(59)).toBe('59s')
    expect(formatElapsed(60)).toBe('1m 00s')
    expect(formatElapsed(125)).toBe('2m 05s')
  })
})

describe('ElapsedSeconds', () => {
  it('renders the live elapsed count from startedAt and ticks forward', async () => {
    const startedAt = Date.now() - 3_000
    render(<ElapsedSeconds startedAt={startedAt} />)

    expect(screen.getByText('3s')).toBeInTheDocument()

    await waitMs(1100)

    expect(screen.getByText('4s')).toBeInTheDocument()
  })
})
