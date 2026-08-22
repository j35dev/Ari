import { render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { BootSplash } from './BootSplash'

describe('BootSplash', () => {
  it('renders the ARI wordmark letters and progress sweep while connecting', () => {
    render(<BootSplash ready={false} />)

    expect(screen.getByText('A')).toBeInTheDocument()
    expect(screen.getByText('R')).toBeInTheDocument()
    expect(screen.getByText('I')).toBeInTheDocument()
    expect(screen.getByTestId('boot-progress')).toBeInTheDocument()
  })

  it('fades itself out once the engine is ready', async () => {
    const { container, rerender } = render(<BootSplash ready={false} />)

    rerender(<BootSplash ready={true} />)

    const splash = container.firstElementChild
    expect(splash).toHaveAttribute('aria-hidden', 'true')
    await waitFor(() => expect(splash).toHaveStyle({ opacity: '0' }), { timeout: 2000 })
  })
})
