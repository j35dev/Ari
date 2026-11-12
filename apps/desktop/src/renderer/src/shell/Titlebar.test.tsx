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
  it('offers one toggle for the docked panel, not a button per tool', () => {
    render(<Titlebar onTogglePanel={() => undefined} />)
    const nav = screen.getByRole('navigation', { name: 'Workspace' })
    expect(nav.querySelectorAll('button')).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Open panel' })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
    // The panel's own tabs choose between these; the titlebar no longer does.
    for (const label of ['Review changes', 'Files', 'Terminal', 'Browser']) {
      expect(screen.queryByRole('button', { name: label })).not.toBeInTheDocument()
    }
    // Usage and settings are app destinations: they live in the sidebar footer.
    expect(screen.queryByRole('button', { name: 'Usage' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Settings' })).not.toBeInTheDocument()
  })

  it('marks the toggle while the panel is open and omits it when it has no handler', () => {
    const { rerender } = render(<Titlebar panelOpen onTogglePanel={() => undefined} />)
    expect(screen.getByRole('button', { name: 'Close panel' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    rerender(<Titlebar />)
    expect(screen.queryByRole('navigation', { name: 'Workspace' })).not.toBeInTheDocument()
  })

  it('renders the Git control it is given beside the tools', () => {
    render(
      <Titlebar
        onTogglePanel={() => undefined}
        git={<button type="button">Commit &amp; push</button>}
      />,
    )
    expect(screen.getByRole('button', { name: 'Commit & push' })).toBeInTheDocument()
  })

  it('shows the provider usage it is given, ahead of the Git control', () => {
    render(
      <Titlebar
        onTogglePanel={() => undefined}
        usage={<button type="button">Codex usage: 5h 12% used</button>}
        git={<button type="button">Commit</button>}
      />,
    )
    const usage = screen.getByRole('button', { name: 'Codex usage: 5h 12% used' })
    const git = screen.getByRole('button', { name: 'Commit' })
    expect(usage.compareDocumentPosition(git) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('keeps usage out of the bare setup titlebar', () => {
    render(<Titlebar minimal usage={<button type="button">Codex usage</button>} />)
    expect(screen.queryByRole('button', { name: 'Codex usage' })).not.toBeInTheDocument()
  })

  it('reports a press of the toggle', async () => {
    const onToggle = vi.fn()
    const user = userEvent.setup()
    render(<Titlebar onTogglePanel={onToggle} />)
    await user.click(screen.getByRole('button', { name: 'Open panel' }))
    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  it('gives the sidebar header a leading zone as wide as the sidebar', () => {
    render(<Titlebar leading={<span>sidebar header</span>} leadingWidth={264} />)
    const zone = screen.getByText('sidebar header').parentElement
    expect(zone).toHaveStyle({ width: '264px' })
    // The header carries collapse, so the expand affordance is not offered too.
    expect(screen.queryByRole('button', { name: 'Expand sidebar' })).not.toBeInTheDocument()
  })

  it('shows no place and no branch label of its own', () => {
    render(<Titlebar />)
    expect(screen.queryByText('ARI')).not.toBeInTheDocument()
    // The branch lives in the Git control; the titlebar never renders one.
    expect(screen.queryByText('demo')).not.toBeInTheDocument()
    expect(screen.queryByTitle('Active branch')).not.toBeInTheDocument()
  })

  it('insets the leading cluster under macOS traffic lights', () => {
    stubUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15')
    const { container } = render(<Titlebar />)
    expect(container.querySelector('.pl-\\[76px\\]')).not.toBeNull()
  })

  it('offers expand-sidebar only when the rail is collapsed', async () => {
    const onExpand = vi.fn()
    const user = userEvent.setup()
    const { rerender } = render(<Titlebar />)
    expect(screen.queryByRole('button', { name: 'Expand sidebar' })).not.toBeInTheDocument()

    rerender(<Titlebar onExpandSidebar={onExpand} />)
    await user.click(screen.getByRole('button', { name: 'Expand sidebar' }))
    expect(onExpand).toHaveBeenCalledOnce()
  })
})
