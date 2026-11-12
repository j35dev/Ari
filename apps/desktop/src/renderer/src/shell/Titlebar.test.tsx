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
  it('places the panels a session can dock in the titlebar', () => {
    render(<Titlebar activeTool="files" onSelectTool={() => undefined} />)
    expect(screen.getByRole('navigation', { name: 'Workspace' })).toBeInTheDocument()
    for (const label of ['Review changes', 'Files', 'Terminal', 'Browser']) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument()
    }
    // Usage and settings are app destinations: they live in the sidebar footer.
    expect(screen.queryByRole('button', { name: 'Usage' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Settings' })).not.toBeInTheDocument()
    // Git actions and pull requests live in the one Git control, not as extra tools.
    expect(screen.queryByRole('button', { name: 'Source control' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'PRs & issues' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Sessions' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Files' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.queryByText('Settings')).not.toBeInTheDocument()
  })

  it('badges Review changes with the working-tree file count', () => {
    render(<Titlebar activeTool="changes" changeCount={3} onSelectTool={() => undefined} />)
    expect(screen.getByRole('button', { name: 'Review changes, 3 files changed' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(screen.getByText('3')).toBeInTheDocument()
  })

  it('renders the Git control it is given beside the tools', () => {
    render(
      <Titlebar
        onSelectTool={() => undefined}
        git={<button type="button">Commit &amp; push</button>}
      />,
    )
    expect(screen.getByRole('button', { name: 'Commit & push' })).toBeInTheDocument()
  })

  it('shows the provider usage it is given, ahead of the Git control', () => {
    render(
      <Titlebar
        onSelectTool={() => undefined}
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

  it('reports the chosen tool', async () => {
    const onSelect = vi.fn()
    const user = userEvent.setup()
    render(<Titlebar onSelectTool={onSelect} />)
    await user.click(screen.getByRole('button', { name: 'Terminal' }))
    expect(onSelect).toHaveBeenCalledWith('terminal')
  })

  it('names the place: the project, then what is open in it', () => {
    const { rerender } = render(<Titlebar place={{ context: 'demo', title: 'Fix the build' }} />)
    expect(screen.getByText('demo')).toBeInTheDocument()
    expect(screen.getByText('Fix the build')).toBeInTheDocument()

    rerender(<Titlebar place={{ context: null, title: 'Aria' }} />)
    expect(screen.queryByText('demo')).not.toBeInTheDocument()
    expect(screen.getByText('Aria')).toBeInTheDocument()
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
