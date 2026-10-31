import { StrictMode } from 'react'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OnboardingAgents } from './OnboardingAgents'

const { invoke, subscribe } = vi.hoisted(() => ({
  invoke: vi.fn(),
  subscribe: vi.fn(() => () => undefined),
}))
vi.mock('../../lib/rpc', () => ({ rpc: { invoke, subscribe } }))
vi.mock('../terminal/TerminalPane', () => ({
  TerminalPane: () => <div>Native sign-in terminal</div>,
}))
const detected = [
  {
    kind: 'claude',
    installed: true,
    binaryPath: '/bin/claude',
    version: '2.1.0',
    authStatus: 'authenticated',
  },
  { kind: 'codex', installed: false, binaryPath: null, version: null, authStatus: 'unknown' },
]
afterEach(cleanup)
beforeEach(() => {
  invoke.mockReset()
  invoke.mockImplementation(async (method: string) => {
    if (method === 'providers.detect' || method === 'providers.rescan') return detected
    if (method === 'providers.plan')
      return { installCommand: ['npm', 'install', '-g', '@openai/codex'] }
    if (method === 'providers.install') return { started: true }
    if (method === 'providers.setupTerminal') return { ok: true, id: 'setup_1', cwd: '/home/user' }
    if (method === 'providers.authProbe')
      return { status: 'auth-required', label: 'Claude', logins: [] }
    return {}
  })
})
function mount() {
  const onSelect = vi.fn()
  const onBusyChange = vi.fn()
  return {
    ...render(<OnboardingAgents selected={null} onSelect={onSelect} onBusyChange={onBusyChange} />),
    onSelect,
    onBusyChange,
  }
}

describe('onboarding agents', () => {
  it('reuses detected sign-ins without starting login, probes or installs', async () => {
    const { onSelect } = mount()
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith('claude'))
    expect(screen.getByText('Sign-in found')).toBeInTheDocument()
    expect(invoke).not.toHaveBeenCalledWith('providers.authProbe', expect.anything())
    expect(invoke).not.toHaveBeenCalledWith('providers.install', expect.anything())
    expect(invoke).not.toHaveBeenCalledWith('providers.setupTerminal', expect.anything())
  })

  it('shows the install command and waits for explicit consent', async () => {
    const user = userEvent.setup()
    mount()
    await user.click(await screen.findByRole('button', { name: 'Install' }))
    expect(await screen.findByText('npm install -g @openai/codex')).toBeInTheDocument()
    expect(invoke).not.toHaveBeenCalledWith('providers.install', expect.anything())
    await user.click(screen.getByRole('button', { name: 'Install Codex' }))
    expect(invoke).toHaveBeenCalledWith('providers.install', {
      kind: 'codex',
      operation: 'install',
    })
    expect(await screen.findByRole('button', { name: 'Cancel install' })).toBeInTheDocument()
  })

  it('offers the native sign-in after a refused check and cleans up its terminal', async () => {
    const user = userEvent.setup()
    const { unmount, onBusyChange } = mount()
    const claude = screen.getByRole('region', { name: 'Claude Code' })
    await user.click(await within(claude).findByRole('button', { name: 'Check sign-in' }))
    await user.click(await within(claude).findByRole('button', { name: 'Sign in' }))
    expect(await screen.findByText('Native sign-in terminal')).toBeInTheDocument()
    expect(invoke).toHaveBeenCalledWith('providers.setupTerminal', { kind: 'claude' })
    expect(onBusyChange).toHaveBeenLastCalledWith(true)
    unmount()
    expect(invoke).toHaveBeenCalledWith('terminal.kill', { id: 'setup_1' })
  })

  it('a refused sign-in check outranks credential hints and clears after native sign-in', async () => {
    const user = userEvent.setup()
    mount()
    const claude = screen.getByRole('region', { name: 'Claude Code' })
    await user.click(await within(claude).findByRole('button', { name: 'Check sign-in' }))
    expect(await within(claude).findByText('Sign-in needed')).toBeInTheDocument()
    expect(within(claude).queryByText('Sign-in found')).not.toBeInTheDocument()
    await user.click(within(claude).getByRole('button', { name: 'Sign in' }))
    await user.click(await screen.findByRole('button', { name: 'Done, check again' }))
    expect(await within(claude).findByText('Sign-in found')).toBeInTheDocument()
    expect(within(claude).queryByText('Sign-in needed')).not.toBeInTheDocument()
    expect(invoke).toHaveBeenCalledWith('terminal.kill', { id: 'setup_1' })
  })

  it('releases the busy state and permits retry when starting an install rejects', async () => {
    const base = invoke.getMockImplementation()!
    let first = true
    invoke.mockImplementation(async (method: string, params: unknown): Promise<unknown> => {
      if (method === 'providers.install' && first) {
        first = false
        throw new Error('installer unavailable')
      }
      return base(method, params) as Promise<unknown>
    })
    const user = userEvent.setup()
    const { onBusyChange } = mount()
    await user.click(await screen.findByRole('button', { name: 'Install' }))
    await user.click(await screen.findByRole('button', { name: 'Install Codex' }))
    await waitFor(() => expect(onBusyChange).toHaveBeenLastCalledWith(false))
    expect(
      screen.getAllByRole('alert').some((p) => p.textContent?.includes('Could not start')),
    ).toBe(true)
    await user.click(screen.getByRole('button', { name: 'Install Codex' }))
    expect(await screen.findByRole('button', { name: 'Cancel install' })).toBeInTheDocument()
  })

  it('ignores the first StrictMode scan after a newer result has arrived', async () => {
    let resolve!: (value: unknown) => void
    invoke.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done
        }),
    )
    render(
      <StrictMode>
        <OnboardingAgents selected={null} onSelect={vi.fn()} onBusyChange={vi.fn()} />
      </StrictMode>,
    )
    expect(await screen.findByText('Sign-in found')).toBeInTheDocument()
    await act(async () => {
      resolve([])
    })
    expect(screen.getByText('Sign-in found')).toBeInTheDocument()
  })

  it('keeps detection failures recoverable', async () => {
    invoke.mockRejectedValueOnce(new Error('offline'))
    const user = userEvent.setup()
    mount()
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not check your agents')
    await user.click(screen.getByRole('button', { name: 'Check again' }))
    expect(await screen.findByText('Sign-in found')).toBeInTheDocument()
  })
})
