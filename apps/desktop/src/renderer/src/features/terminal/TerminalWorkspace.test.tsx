import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TerminalWorkspace } from './TerminalWorkspace'

const { invokeFn } = vi.hoisted(() => ({ invokeFn: vi.fn() }))

vi.mock('../../lib/rpc', () => ({
  rpc: {
    invoke: invokeFn,
    subscribe: vi.fn(() => () => undefined),
  },
}))

// xterm needs a real layout engine; the workspace's own logic (tree state,
// toolbar, launcher, close) is what's under test here.
vi.mock('./TerminalPane', () => ({
  TerminalPane: () => null,
}))

function installRpc(detections: { kind: string; binaryPath: string | null }[] = []): void {
  invokeFn.mockImplementation(async (method: string) => {
    switch (method) {
      case 'app.info':
        return { homeDir: 'C:\\Users\\tester' }
      case 'providers.detect':
        return detections
      case 'terminal.create':
      case 'terminal.kill':
      case 'terminal.write':
      case 'terminal.resize':
        return undefined
      default:
        throw new Error(`unexpected method: ${String(method)}`)
    }
  })
}

/** Pane sections are named regions; titles come back in reading order. */
function paneTitles(): string[] {
  return screen
    .queryAllByRole('region')
    .map((region) => region.getAttribute('aria-label') ?? '')
}

describe('TerminalWorkspace', () => {
  beforeEach(() => {
    invokeFn.mockReset()
  })

  it('auto-opens one shell pane once the cwd resolves', async () => {
    installRpc()
    render(<TerminalWorkspace />)

    await waitFor(() => {
      expect(paneTitles()).toHaveLength(1)
    })
    // The default shell pane carries the product name, not the platform binary.
    expect(paneTitles()[0]).toBe('Ari Terminal terminal pane')
    expect(screen.getByText('1 pane')).toBeInTheDocument()
  })

  it('falls back to the home dir when no cwd prop is given and surfaces failures', async () => {
    installRpc()
    invokeFn.mockImplementation(async (method: string) => {
      if (method === 'app.info') throw new Error('ipc down')
      if (method === 'providers.detect') return []
      return undefined
    })
    render(<TerminalWorkspace />)

    expect(await screen.findByText(/Terminal could not start: ipc down/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
  })

  it('splits the active pane right and down, then closes back', async () => {
    const user = userEvent.setup()
    installRpc()
    render(<TerminalWorkspace />)
    await waitFor(() => expect(paneTitles()).toHaveLength(1))

    await user.click(screen.getByRole('button', { name: 'Split pane right' }))
    expect(paneTitles()).toHaveLength(2)

    await user.click(screen.getByRole('button', { name: 'Split pane down' }))
    expect(paneTitles()).toHaveLength(3)
    expect(screen.getByText('3 panes')).toBeInTheDocument()

    // Dividers exist and expose their ratio for AT (one per split).
    const dividers = screen.getAllByRole('separator', { name: 'Resize panes' })
    expect(dividers.map((d) => d.getAttribute('aria-valuenow'))).toEqual(['50', '50'])

    const closeButtons = screen.getAllByRole('button', { name: /Close .* pane$/ })
    await user.click(closeButtons[0] as HTMLElement)
    expect(paneTitles()).toHaveLength(2)
  })

  it('closing every pane lands on an intentional empty state, not a respawn', async () => {
    const user = userEvent.setup()
    installRpc()
    render(<TerminalWorkspace />)
    await waitFor(() => expect(paneTitles()).toHaveLength(1))

    await user.click(screen.getByRole('button', { name: /Close .* pane$/ }))

    expect(await screen.findByText('No terminal panes open.')).toBeInTheDocument()
    expect(paneTitles()).toHaveLength(0)
    expect(screen.getByRole('button', { name: 'New terminal' })).toBeInTheDocument()
  })

  it('offers installed agent CLIs in the launcher and spawns them as panes', async () => {
    const user = userEvent.setup()
    installRpc([
      { kind: 'claude', binaryPath: 'C:\\cli\\claude.cmd' },
      { kind: 'codex', binaryPath: null },
    ])
    render(<TerminalWorkspace />)
    await waitFor(() => expect(paneTitles()).toHaveLength(1))

    await user.click(screen.getByRole('button', { name: 'New pane' }))

    const menu = await screen.findByRole('menu', { name: 'New pane' })
    expect(menu).toHaveTextContent('Ari Terminal')
    expect(menu).toHaveTextContent('Claude Code (claude)')
    // codex has no binary on this machine — it must not be offered.
    expect(menu).not.toHaveTextContent('Codex CLI')

    await user.click(screen.getByRole('menuitem', { name: 'Claude Code (claude)' }))

    expect(await screen.findByRole('region', { name: 'Claude Code terminal pane' })).toBeInTheDocument()
    expect(screen.getByText('2 panes')).toBeInTheDocument()
  })
})
