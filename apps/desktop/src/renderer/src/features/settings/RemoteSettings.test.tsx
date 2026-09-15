import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import type { Project } from '@ari/contracts/project'
import type { RemoteState, TailscaleState } from '@ari/contracts/rpc'
import { RemoteSettings } from './RemoteSettings'

const rpcMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  subscribe: vi.fn(),
}))

vi.mock('../../lib/rpc', () => ({ rpc: rpcMocks }))

const invokeMock = rpcMocks.invoke as unknown as Mock<
  (method: string, params?: unknown) => Promise<unknown>
>
const subscribeMock = rpcMocks.subscribe as unknown as Mock<
  (name: string, params: Record<string, unknown>, onEvent: (payload: unknown) => void) => () => void
>

const PROJECT: Project = {
  id: 'proj_ari',
  name: 'Ari',
  path: 'D:\\Projects\\Ari',
  colorIndex: 0,
  createdAt: 1,
  lastOpenedAt: 1,
  open: true,
  status: 'ok',
}

const TAILNET = 'https://ari.tailnet.ts.net'

function remote(overrides: Partial<RemoteState> = {}): RemoteState {
  return {
    enabled: false,
    origin: null,
    clientUrl: null,
    allowedOrigins: [],
    devices: [],
    invitation: null,
    pending: null,
    error: null,
    ...overrides,
  }
}

function tailscale(overrides: Partial<TailscaleState> = {}): TailscaleState {
  return {
    installed: true,
    dnsName: 'ari.tailnet.ts.net',
    origin: TAILNET,
    serving: false,
    error: null,
    ...overrides,
  }
}

const PENDING = {
  invitationId: 'inv_1',
  displayName: 'Pixel 9',
  confirmationCode: '7F3K-2Q9D',
  expiresAt: 1_900_000_000_000,
}

let remoteState: RemoteState
let tailscaleState: TailscaleState

/** Delivers a `remote.updates` frame the way the main process does. */
function publish(frame: RemoteState): void {
  const onEvent = subscribeMock.mock.calls[0]?.[2]
  if (onEvent === undefined) throw new Error('the panel never subscribed to remote.updates')
  act(() => onEvent(frame))
}

beforeEach(() => {
  remoteState = remote()
  tailscaleState = tailscale()
  rpcMocks.invoke.mockReset()
  rpcMocks.subscribe.mockReset()
  rpcMocks.subscribe.mockImplementation(() => () => undefined)
  invokeMock.mockImplementation(async (method) => {
    if (method === 'remote.status') return remoteState
    if (method === 'remote.tailscale.status') return tailscaleState
    if (method === 'project.list') return [PROJECT]
    if (method === 'remote.enable' || method === 'remote.disable') return remoteState
    if (method === 'remote.invite' || method === 'remote.cancelInvite') return remoteState
    if (method === 'remote.approve' || method === 'remote.deny') return remoteState
    if (method === 'remote.revokeDevice') return remoteState
    // The fake main process reacts to the mutating calls the way the real one
    // does, so the panel can be driven through the whole flow.
    if (method === 'remote.tailscale.enable') {
      tailscaleState = tailscale({ serving: true })
      return remoteState
    }
    if (method === 'remote.tailscale.disable') {
      tailscaleState = tailscale({ serving: false })
      return tailscaleState
    }
    throw new Error(`unexpected method: ${method}`)
  })
})

describe('RemoteSettings', () => {
  it('starts off, and offers the Tailscale step that would make it reachable', async () => {
    render(<RemoteSettings />)

    const toggle = await screen.findByRole('switch', { name: 'Remote access' })
    expect(toggle).not.toBeChecked()
    expect(screen.getByText('Turn remote access on to pair a phone.')).toBeInTheDocument()
    expect(
      screen.getByText('Tailscale is connected; Ari is not served to the tailnet yet.'),
    ).toBeInTheDocument()
    // Serve needs a listener to point at, so the button cannot lie about being
    // usable while remote access is off.
    expect(screen.getByRole('button', { name: 'Serve Ari over Tailscale' })).toBeDisabled()
  })

  it('turns remote access on through the engine', async () => {
    const user = userEvent.setup()
    render(<RemoteSettings />)

    await user.click(await screen.findByRole('switch', { name: 'Remote access' }))
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('remote.enable', {}))
  })

  it('turns remote access off through the engine', async () => {
    remoteState = remote({ enabled: true, clientUrl: TAILNET })
    const user = userEvent.setup()
    render(<RemoteSettings />)

    await user.click(await screen.findByRole('switch', { name: 'Remote access' }))
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('remote.disable'))
  })

  it('shows why remote access could not start', async () => {
    remoteState = remote({ error: 'listen EADDRINUSE: address already in use 127.0.0.1:8787' })
    render(<RemoteSettings />)

    // An error the user cannot read is an error they cannot act on.
    expect(await screen.findByRole('alert')).toHaveTextContent('address already in use')
  })

  it('shows the waiting device and the code both screens display', async () => {
    remoteState = remote({ enabled: true, clientUrl: TAILNET, pending: PENDING })
    render(<RemoteSettings />)

    expect(await screen.findByText(/Pixel 9 asked to pair/)).toBeInTheDocument()
    expect(screen.getByLabelText('Confirmation code')).toHaveTextContent('7F3K-2Q9D')
    // The sentence that makes the code a deliberate act rather than a ritual.
    expect(screen.getByText(/must match the one on the phone's screen/)).toBeInTheDocument()
  })

  it('approves with the projects the user selected', async () => {
    remoteState = remote({ enabled: true, clientUrl: TAILNET, pending: PENDING })
    const user = userEvent.setup()
    render(<RemoteSettings />)

    const approve = await screen.findByRole('button', { name: 'Approve' })
    // A device granted nothing can reach nothing, so an empty grant is not an
    // approval the user could have meant.
    expect(approve).toBeDisabled()

    await user.click(screen.getByRole('checkbox', { name: 'Ari' }))
    expect(approve).toBeEnabled()
    await user.click(approve)

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith('remote.approve', {
        invitationId: 'inv_1',
        projectIds: ['proj_ari'],
      }),
    )
  })

  it('denies a device without granting anything', async () => {
    remoteState = remote({ enabled: true, clientUrl: TAILNET, pending: PENDING })
    const user = userEvent.setup()
    render(<RemoteSettings />)

    await user.click(await screen.findByRole('button', { name: 'Deny' }))

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith('remote.deny', { invitationId: 'inv_1' }),
    )
  })

  it('revokes a device only after the confirmation step', async () => {
    remoteState = remote({
      enabled: true,
      devices: [
        {
          deviceId: 'dev_1',
          displayName: 'Pixel 9',
          projectIds: ['proj_ari'],
          pairedAt: 1_700_000_000_000,
          lastSeenAt: 1_700_000_600_000,
        },
      ],
    })
    const user = userEvent.setup()
    render(<RemoteSettings />)

    expect(await screen.findByText('Pixel 9')).toBeInTheDocument()
    expect(screen.getByText('Projects: Ari')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Revoke Pixel 9' }))
    expect(invokeMock).not.toHaveBeenCalledWith('remote.revokeDevice', expect.anything())

    await user.click(screen.getByRole('button', { name: 'Confirm revoke Pixel 9' }))
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith('remote.revokeDevice', { deviceId: 'dev_1' }),
    )
  })

  it('follows the remote.updates stream', async () => {
    render(<RemoteSettings />)
    await screen.findByRole('switch', { name: 'Remote access' })

    publish(remote({ enabled: true, clientUrl: TAILNET }))

    expect(screen.getByText(`A phone should open ${TAILNET}.`)).toBeInTheDocument()
  })

  it('never shows a pairing code for an address a phone cannot reach', async () => {
    remoteState = remote({
      enabled: true,
      origin: 'http://127.0.0.1:8787',
      clientUrl: null,
      invitation: {
        invitationId: 'inv_1',
        url: 'http://127.0.0.1:8787/#pair=inv_1',
        expiresAt: 1_900_000_000_000,
      },
    })
    render(<RemoteSettings />)

    // The invitation exists, but loopback on a phone is the phone itself.
    expect(await screen.findByText(/No address a phone can reach exists yet/)).toBeInTheDocument()
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
  })

  it('shows the QR code and its expiry for a reachable invitation', async () => {
    remoteState = remote({
      enabled: true,
      clientUrl: TAILNET,
      invitation: {
        invitationId: 'inv_1',
        url: `${TAILNET}/#pair=inv_1`,
        expiresAt: 1_900_000_000_000,
      },
    })
    render(<RemoteSettings />)

    const image = await screen.findByRole('img', { name: 'Pairing QR code' })
    expect(image.getAttribute('src')).toMatch(/^data:image\/svg\+xml/)
    expect(screen.getByText(/^Expires /)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument()
  })

  it('serves and stops serving over Tailscale', async () => {
    remoteState = remote({ enabled: true, clientUrl: TAILNET })
    const user = userEvent.setup()
    render(<RemoteSettings />)

    await user.click(await screen.findByRole('button', { name: 'Serve Ari over Tailscale' }))
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('remote.tailscale.enable'))
    // The panel refreshes the status itself, not only the remote state.
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('remote.tailscale.status'))

    const stop = await screen.findByRole('button', { name: 'Stop serving Ari' })
    expect(screen.getByText(`Serving Ari at ${TAILNET}.`)).toBeInTheDocument()
    await user.click(stop)
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('remote.tailscale.disable'))
  })

  it('reports Tailscale as absent without offering Serve', async () => {
    tailscaleState = tailscale({
      installed: false,
      dnsName: null,
      origin: null,
      error: 'Tailscale is not installed on this computer.',
    })
    render(<RemoteSettings />)

    expect(
      await screen.findByText('Tailscale is not installed on this computer.'),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Serve Ari over Tailscale' })).toBeDisabled()
  })
})
