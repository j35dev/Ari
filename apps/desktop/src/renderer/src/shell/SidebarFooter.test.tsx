import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Titlebar } from './Titlebar'

const ORIGINAL_UA = navigator.userAgent

function stubUserAgent(value: string): void {
  Object.defineProperty(navigator, 'userAgent', { configurable: true, value })
}

afterEach(() => {
  stubUserAgent(ORIGINAL_UA)
})

describe('Titlebar workspace tools', () => {
  it('places workspace tools in the titlebar, not the session sidebar', () => {
    render(<Titlebar projectLabel="demo" activeTool="files" onSelectTool={() => undefined} />)
    expect(screen.getByRole('navigation', { name: 'Workspace' })).toBeInTheDocument()
    for (const label of ['Changes', 'Files', 'Usage', 'Terminal', 'Settings']) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument()
    }
    expect(screen.queryByRole('button', { name: 'Sessions' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Files' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('reports the chosen tool', async () => {
    const onSelect = vi.fn()
    const user = userEvent.setup()
    render(<Titlebar projectLabel="demo" onSelectTool={onSelect} />)
    await user.click(screen.getByRole('button', { name: 'Settings' }))
    expect(onSelect).toHaveBeenCalledWith('settings')
  })

  it('omits the ARI wordmark and keeps the project label', () => {
    render(<Titlebar projectLabel="demo" />)
    expect(screen.queryByText('ARI')).not.toBeInTheDocument()
    expect(screen.getByText('demo')).toBeInTheDocument()
  })

  it('insets the project label under macOS traffic lights', () => {
    stubUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15')
    const { container } = render(<Titlebar projectLabel="demo" />)
    expect(container.querySelector('.pl-\\[76px\\]')).not.toBeNull()
  })
})
