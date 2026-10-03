import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { RemoteConnectState } from '@ari/contracts/rpc'
import { RemoteConnectSetup } from './RemoteConnectSetup'

function state(overrides: Partial<RemoteConnectState> = {}): RemoteConnectState {
  return {
    phase: 'unconfigured',
    origin: null,
    computerName: null,
    computerId: null,
    clientUrl: null,
    error: null,
    browserUrl: null,
    expiresAt: null,
    cloudflaredAvailable: false,
    ...overrides,
  }
}

function setup(value: RemoteConnectState, disabled = false, enabled = true) {
  const actions = {
    configure: vi.fn(),
    signIn: vi.fn(),
    signOut: vi.fn(),
    refresh: vi.fn(),
    openBrowser: vi.fn(),
    openConnectorGuide: vi.fn(),
  }
  render(<RemoteConnectSetup state={value} disabled={disabled} enabled={enabled} {...actions} />)
  return actions
}

describe('RemoteConnectSetup', () => {
  it('can keep the managed computer connected after reviewing removal', async () => {
    const actions = setup(state({ phase: 'ready', origin: 'https://connect.example.com' }))
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Disconnect Ari Connect' }))
    await user.click(screen.getByRole('button', { name: 'Keep connected' }))
    expect(screen.queryByRole('button', { name: 'Confirm disconnect' })).not.toBeInTheDocument()
    expect(actions.signOut).not.toHaveBeenCalled()
  })

  it.each([
    ['unconfigured', 'Ari Connect is invite-only'],
    ['signed-out', 'Sign in to connect this computer'],
    ['awaiting-approval', 'Finish approval in your browser'],
    ['provisioning', 'Preparing your computer connection'],
    ['missing-cloudflared', 'Install the Cloudflare connector'],
    ['connecting', 'Connecting this computer'],
    ['ready', 'Connected through Ari Connect'],
    ['denied', 'Computer access was not approved'],
    ['error', 'Ari Connect needs attention'],
  ] as const)('labels the actual %s stage', (phase, label) => {
    setup(state({ phase }))
    expect(screen.getByRole('heading', { name: label })).toBeInTheDocument()
    if (phase !== 'ready')
      expect(screen.queryByText('Connected through Ari Connect')).not.toBeInTheDocument()
  })

  it('configures only the administrator-supplied service address', async () => {
    const actions = setup(state())
    const user = userEvent.setup()
    expect(screen.getByRole('button', { name: 'Save service address' })).toBeDisabled()
    await user.type(
      screen.getByRole('textbox', { name: 'Ari Connect service address' }),
      'https://connect.example.com',
    )
    await user.click(screen.getByRole('button', { name: 'Save service address' }))
    expect(actions.configure).toHaveBeenCalledWith('https://connect.example.com')
    expect(actions.signIn).not.toHaveBeenCalled()
  })

  it('requires a computer name and enabled gateway before sign-in', async () => {
    const actions = setup(
      state({ phase: 'signed-out', origin: 'https://connect.example.com' }),
      false,
      false,
    )
    const user = userEvent.setup()
    await user.type(screen.getByRole('textbox', { name: 'Computer name' }), 'My computer')
    expect(screen.getByRole('button', { name: 'Sign in with Ari Connect' })).toBeDisabled()
    expect(actions.signIn).not.toHaveBeenCalled()
  })

  it('starts real browser sign-in with the chosen name', async () => {
    const actions = setup(state({ phase: 'signed-out', origin: 'https://connect.example.com' }))
    const user = userEvent.setup()
    expect(screen.getByRole('button', { name: 'Sign in with Ari Connect' })).toBeDisabled()
    await user.type(screen.getByRole('textbox', { name: 'Computer name' }), 'Work desktop')
    await user.click(screen.getByRole('button', { name: 'Sign in with Ari Connect' }))
    expect(actions.signIn).toHaveBeenCalledWith('Work desktop')
  })

  it('reopens browser approval without issuing another authorization request', async () => {
    const actions = setup(
      state({
        phase: 'awaiting-approval',
        browserUrl: 'https://connect.example.com/desktop/approve?state=code',
        expiresAt: 1_900_000_000_000,
      }),
    )
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Open sign-in again' }))
    expect(actions.openBrowser).toHaveBeenCalledOnce()
    expect(actions.signIn).not.toHaveBeenCalled()
    expect(screen.getByText(/^Approval expires/)).toBeInTheDocument()
  })

  it('lets connector installation recover through status checks and supports disconnect', async () => {
    const actions = setup(
      state({ phase: 'missing-cloudflared', error: 'cloudflared was not found in PATH' }),
    )
    const user = userEvent.setup()
    expect(screen.getByRole('alert')).toHaveTextContent('not found in PATH')
    await user.click(screen.getByRole('button', { name: 'Open connector installation guide' }))
    expect(actions.openConnectorGuide).toHaveBeenCalledOnce()
    await user.click(screen.getByRole('button', { name: 'Check again' }))
    expect(actions.refresh).toHaveBeenCalledOnce()
    await user.click(screen.getByRole('button', { name: 'Disconnect Ari Connect' }))
    expect(actions.signOut).not.toHaveBeenCalled()
    expect(screen.getByText(/removes this computer from Ari Connect/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Confirm disconnect' }))
    expect(actions.signOut).toHaveBeenCalledOnce()
  })

  it('blocks service replacement and mutations while the connection is pending', async () => {
    setup(
      state({
        phase: 'awaiting-approval',
        browserUrl: 'https://connect.example.com/approve',
        origin: 'https://connect.example.com',
      }),
      true,
    )
    expect(screen.getByRole('button', { name: 'Open sign-in again' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Disconnect Ari Connect' })).toBeDisabled()
    expect(screen.getByRole('textbox', { name: 'Ari Connect service address' })).toBeDisabled()
  })

  it('shows the real phone address only once the connector is ready', () => {
    setup(
      state({
        phase: 'ready',
        computerName: 'Work desktop',
        clientUrl: 'https://connect.example.com/?computer=computer_1',
      }),
    )
    expect(screen.getByText('https://connect.example.com/?computer=computer_1')).toBeInTheDocument()
    expect(screen.getByText(/Pair a phone below/)).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Sign in with Ari Connect' }),
    ).not.toBeInTheDocument()
  })
})
