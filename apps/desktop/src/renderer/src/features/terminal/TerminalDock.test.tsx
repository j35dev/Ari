import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TerminalDock } from './TerminalDock'
import { resetTerminalDock } from './terminal-dock'
import { requestTerminalTab } from './terminal-requests'

const { invokeFn } = vi.hoisted(() => ({ invokeFn: vi.fn() }))

vi.mock('../../lib/rpc', () => ({
  rpc: {
    invoke: invokeFn,
    subscribe: vi.fn(() => () => undefined),
  },
}))

// xterm needs a real layout engine. Standing in for the pane keeps the rail's
// own behaviour — tab state, cwd plumbing, mounted background shells — testable.
vi.mock('./TerminalPane', () => ({
  TerminalPane: ({
    terminalId,
    cwd,
    initialCommand,
    active,
  }: {
    terminalId: string
    cwd: string | null
    initialCommand?: string
    active: boolean
  }) => (
    <div
      data-testid="pane"
      data-id={terminalId}
      data-cwd={cwd ?? ''}
      data-command={initialCommand ?? ''}
      data-active={String(active)}
    />
  ),
}))

function installRpc(detections: { kind: string; binaryPath: string | null }[] = []): void {
  invokeFn.mockImplementation(async (method: string) => {
    switch (method) {
      case 'app.info':
        return { homeDir: 'C:\\Users\\tester' }
      case 'providers.detect':
        return detections
      case 'terminal.kill':
        return undefined
      default:
        throw new Error(`unexpected method: ${String(method)}`)
    }
  })
}

function panes(): HTMLElement[] {
  return screen.queryAllByTestId('pane')
}

describe('TerminalDock', () => {
  beforeEach(() => {
    invokeFn.mockReset()
    resetTerminalDock()
  })

  it('opens one shell in the project folder as soon as the rail mounts', async () => {
    installRpc()
    render(<TerminalDock cwd={'D:\\Projects\\Ari'} />)

    await waitFor(() => expect(panes()).toHaveLength(1))
    // The shell must start where the user is working, not in the app's cwd.
    expect(panes()[0]).toHaveAttribute('data-cwd', 'D:\\Projects\\Ari')
    expect(panes()[0]).toHaveAttribute('data-active', 'true')
    expect(screen.getByRole('button', { name: 'Ari Terminal' })).toBeInTheDocument()
  })

  it('falls back to the home dir when no project is open', async () => {
    installRpc()
    render(<TerminalDock />)

    await waitFor(() => expect(panes()[0]).toHaveAttribute('data-cwd', 'C:\\Users\\tester'))
  })

  it('surfaces a failed cwd lookup with a retry', async () => {
    invokeFn.mockImplementation(async (method: string) => {
      if (method === 'app.info') throw new Error('ipc down')
      return []
    })
    render(<TerminalDock />)

    expect(await screen.findByText(/Terminal could not start: ipc down/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
    expect(panes()).toHaveLength(0)
  })

  it('keeps background shells mounted when another tab takes focus', async () => {
    const user = userEvent.setup()
    installRpc()
    render(<TerminalDock cwd="/repo" />)
    await waitFor(() => expect(panes()).toHaveLength(1))

    await user.click(screen.getByRole('button', { name: 'New terminal' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Ari Terminal' }))

    // Both shells stay in the tree; only the newest is focused and visible.
    expect(panes()).toHaveLength(2)
    expect(panes().map((pane) => pane.dataset['active'])).toEqual(['false', 'true'])
    expect(screen.getByRole('button', { name: 'Ari Terminal 2' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Ari Terminal' }))
    expect(panes().map((pane) => pane.dataset['active'])).toEqual(['true', 'false'])
  })

  it('closing a tab kills its pty and hands focus to the neighbour', async () => {
    const user = userEvent.setup()
    installRpc()
    render(<TerminalDock cwd="/repo" />)
    await waitFor(() => expect(panes()).toHaveLength(1))
    const firstId = panes()[0]?.dataset['id']

    await user.click(screen.getByRole('button', { name: 'New terminal' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Ari Terminal' }))
    const secondId = panes()[1]?.dataset['id']

    await user.click(screen.getByRole('button', { name: 'Close Ari Terminal 2' }))

    expect(invokeFn).toHaveBeenCalledWith('terminal.kill', { id: secondId })
    expect(panes()).toHaveLength(1)
    expect(panes()[0]).toHaveAttribute('data-id', firstId)
    expect(panes()[0]).toHaveAttribute('data-active', 'true')
  })

  it('emptying the rail by hand stays empty instead of respawning', async () => {
    const user = userEvent.setup()
    installRpc()
    render(<TerminalDock cwd="/repo" />)
    await waitFor(() => expect(panes()).toHaveLength(1))

    await user.click(screen.getByRole('button', { name: 'Close Ari Terminal' }))

    expect(await screen.findByText('No terminal open.')).toBeInTheDocument()
    expect(panes()).toHaveLength(0)
    await user.click(screen.getByRole('button', { name: 'Open a terminal' }))
    expect(panes()).toHaveLength(1)
  })

  it('offers installed agent CLIs in the launcher and runs them in a tab', async () => {
    const user = userEvent.setup()
    installRpc([
      { kind: 'claude', binaryPath: 'C:\\cli\\claude.cmd' },
      { kind: 'codex', binaryPath: null },
    ])
    render(<TerminalDock cwd="/repo" />)
    await waitFor(() => expect(panes()).toHaveLength(1))

    await user.click(screen.getByRole('button', { name: 'New terminal' }))

    const menu = await screen.findByRole('menu', { name: 'New terminal' })
    expect(menu).toHaveTextContent('Claude Code (claude)')
    // codex has no binary on this machine — it must not be offered.
    expect(menu).not.toHaveTextContent('Codex CLI')

    await user.click(screen.getByRole('menuitem', { name: 'Claude Code (claude)' }))

    expect(panes()[1]).toHaveAttribute('data-command', 'claude')
    expect(screen.getByRole('button', { name: 'Claude Code' })).toBeInTheDocument()
  })

  it('takes run-script requests as their own titled tab', async () => {
    installRpc()
    render(<TerminalDock cwd="/repo" />)
    await waitFor(() => expect(panes()).toHaveLength(1))

    act(() => {
      requestTerminalTab({ title: 'my-app: dev', cwd: '/repo/app', command: 'pnpm dev' })
    })

    await waitFor(() => expect(panes()).toHaveLength(2))
    expect(panes()[1]).toHaveAttribute('data-cwd', '/repo/app')
    expect(panes()[1]).toHaveAttribute('data-command', 'pnpm dev')
    expect(screen.getByRole('button', { name: 'my-app: dev' })).toBeInTheDocument()
  })

  it('reopening the rail adopts the parked shells instead of spawning more', async () => {
    installRpc()
    const first = render(<TerminalDock cwd="/repo" />)
    await waitFor(() => expect(panes()).toHaveLength(1))
    const id = panes()[0]?.dataset['id']
    first.unmount()

    render(<TerminalDock cwd="/repo" />)

    await waitFor(() => expect(panes()).toHaveLength(1))
    expect(panes()[0]).toHaveAttribute('data-id', id)
    expect(invokeFn).not.toHaveBeenCalledWith('terminal.kill', expect.anything())
  })

  it('closes the rail through the host when asked', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    installRpc()
    render(<TerminalDock cwd="/repo" onClose={onClose} />)
    await waitFor(() => expect(panes()).toHaveLength(1))

    await user.click(screen.getByRole('button', { name: 'Close terminal panel' }))

    expect(onClose).toHaveBeenCalledOnce()
    // Parking the rail must not kill the shell — only the tab's × does that.
    expect(invokeFn).not.toHaveBeenCalledWith('terminal.kill', expect.anything())
  })
})
