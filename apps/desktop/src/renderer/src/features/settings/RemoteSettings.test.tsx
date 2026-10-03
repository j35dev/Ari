import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import QRCode from 'qrcode'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import type { Project } from '@ari/contracts/project'
import type { RemoteConnectState, RemoteState, TailscaleState } from '@ari/contracts/rpc'
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

function connect(overrides: Partial<RemoteConnectState> = {}): RemoteConnectState {
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

const PENDING = {
  invitationId: 'inv_1',
  displayName: 'Pixel 9',
  confirmationCode: '7F3K-2Q9D',
  expiresAt: 1_900_000_000_000,
}

let remoteState: RemoteState
let tailscaleState: TailscaleState
let connectState: RemoteConnectState

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

/** Delivers a `remote.updates` frame the way the main process does. */
function publish(frame: RemoteState): void {
  const onEvent = subscribeMock.mock.calls[0]?.[2]
  if (onEvent === undefined) throw new Error('the panel never subscribed to remote.updates')
  act(() => onEvent(frame))
}

beforeEach(() => {
  remoteState = remote()
  tailscaleState = tailscale()
  connectState = connect()
  rpcMocks.invoke.mockReset()
  rpcMocks.subscribe.mockReset()
  rpcMocks.subscribe.mockImplementation(() => () => undefined)
  invokeMock.mockImplementation(async (method) => {
    if (method === 'remote.status') return remoteState
    if (method === 'remote.tailscale.status') return tailscaleState
    if (method === 'remote.connect.status') return connectState
    if (method === 'remote.connect.configure') return connectState
    if (method === 'remote.connect.signIn') return connectState
    if (method === 'remote.connect.signOut') return connectState
    if (method === 'project.list') return [PROJECT]
    if (method === 'remote.enable' || method === 'remote.disable') return remoteState
    if (method === 'remote.invite' || method === 'remote.cancelInvite') return remoteState
    if (method === 'remote.approve' || method === 'remote.deny') return remoteState
    if (method === 'remote.revokeDevice') return remoteState
    // The fake main process reacts to the mutating calls the way the real one
    // does, so the panel can be driven through the whole flow.
    if (method === 'remote.tailscale.enable') {
      tailscaleState = tailscale({ serving: true })
      return { remote: remoteState, tailscale: tailscaleState }
    }
    if (method === 'remote.tailscale.disable') {
      tailscaleState = tailscale({ serving: false })
      return tailscaleState
    }
    throw new Error(`unexpected method: ${method}`)
  })
})

describe('RemoteSettings', () => {
  it.each([true, false])(
    'shows the persisted terminal grant %s on a paired device',
    async (allowTerminal) => {
      remoteState = remote({
        devices: [
          {
            deviceId: 'dev_1',
            displayName: 'Phone',
            projectIds: [PROJECT.id],
            pairedAt: 1,
            lastSeenAt: null,
            allowTerminal,
          },
        ],
      })
      render(<RemoteSettings />)
      expect(
        await screen.findByText(`Terminal: ${allowTerminal ? 'enabled' : 'not granted'}`),
      ).toBeInTheDocument()
    },
  )

  it('grants terminal only when the user explicitly enables it while approving this device', async () => {
    remoteState = remote({ enabled: true, clientUrl: TAILNET, pending: PENDING })
    const user = userEvent.setup()
    render(<RemoteSettings />)
    expect(await screen.findByRole('checkbox', { name: 'Allow terminal access' })).not.toBeChecked()
    expect(screen.getByText(/a project folder is not a sandbox/)).toBeInTheDocument()
    await user.click(screen.getByRole('checkbox', { name: 'Ari' }))
    await user.click(screen.getByRole('checkbox', { name: 'The codes match' }))
    await user.click(screen.getByRole('checkbox', { name: 'Allow terminal access' }))
    await user.click(screen.getByRole('button', { name: 'Approve' }))
    expect(invokeMock).toHaveBeenCalledWith('remote.approve', {
      invitationId: 'inv_1',
      projectIds: ['proj_ari'],
      allowTerminal: true,
    })
    publish(
      remote({ enabled: true, clientUrl: TAILNET, pending: { ...PENDING, invitationId: 'inv_2' } }),
    )
    expect(screen.getByRole('checkbox', { name: 'Allow terminal access' })).not.toBeChecked()
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled()
  })

  it('refreshes both connection states after master access is turned off', async () => {
    connectState = connect({
      phase: 'ready',
      origin: 'https://connect.example.com',
      clientUrl: 'https://connect.example.com/?computer=computer_1',
    })
    remoteState = remote({ enabled: true, clientUrl: TAILNET })
    tailscaleState = tailscale({ serving: true })
    const normal = invokeMock.getMockImplementation()
    invokeMock.mockImplementation(async (method, params) => {
      if (method === 'remote.disable') {
        remoteState = remote()
        tailscaleState = tailscale()
        connectState = connect({ phase: 'signed-out', origin: 'https://connect.example.com' })
        return remoteState
      }
      return normal!(method, params)
    })
    const user = userEvent.setup()
    render(<RemoteSettings />)
    await screen.findByRole('heading', { name: 'Connected through Ari Connect' })
    await user.click(screen.getByRole('switch', { name: 'Remote access' }))
    expect(await screen.findByText('Mobile access is off')).toBeInTheDocument()
    expect(
      await screen.findByRole('heading', { name: 'Sign in to connect this computer' }),
    ).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Your Tailscale/ }))
    expect(screen.queryByRole('button', { name: 'Stop serving Ari' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Serve Ari over Tailscale' })).toBeDisabled()
  })

  it.each(['provisioning', 'connecting'] as const)(
    'does not expose a %s managed route as a Tailscale invitation',
    async (phase) => {
      connectState = connect({ phase, origin: 'https://connect.example.com' })
      remoteState = remote({
        enabled: true,
        clientUrl: 'https://connect.example.com/?computer=computer_1',
      })
      const user = userEvent.setup()
      render(<RemoteSettings />)
      await waitFor(() =>
        expect(screen.getByRole('button', { name: /^Ari Connect/ })).toHaveAttribute(
          'aria-pressed',
          'true',
        ),
      )
      await user.click(screen.getByRole('button', { name: /Your Tailscale/ }))
      expect(screen.getByText(/No address a phone can reach exists yet/)).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Show pairing code' })).not.toBeInTheDocument()
    },
  )

  it('creates an invitation for the selected route and hides the previous route QR', async () => {
    connectState = connect({
      phase: 'ready',
      origin: 'https://connect.example.com',
      clientUrl: 'https://connect.example.com/?computer=computer_1',
    })
    tailscaleState = tailscale({ serving: true })
    remoteState = remote({
      enabled: true,
      clientUrl: TAILNET,
      invitation: {
        invitationId: 'inv_1',
        url: `${TAILNET}/#pair=inv_1`,
        expiresAt: 1_900_000_000_000,
      },
    })
    const user = userEvent.setup()
    render(<RemoteSettings />)
    await screen.findByRole('heading', { name: 'Connected through Ari Connect' })
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Show pairing code' }))
    expect(invokeMock).toHaveBeenCalledWith('remote.invite', { method: 'connect' })
    await user.click(screen.getByRole('button', { name: /Your Tailscale/ }))
    expect(await screen.findByRole('img', { name: 'Pairing QR code' })).toBeInTheDocument()
  })

  it('does not show a managed invitation belonging to a different computer', async () => {
    connectState = connect({
      phase: 'ready',
      origin: 'https://connect.example.com',
      clientUrl: 'https://connect.example.com/?computer=computer_1',
    })
    remoteState = remote({
      enabled: true,
      clientUrl: connectState.clientUrl,
      invitation: {
        invitationId: 'inv_other',
        url: 'https://connect.example.com/?computer=computer_other#pair=inv_other',
        expiresAt: 1_900_000_000_000,
      },
    })
    render(<RemoteSettings />)
    await screen.findByRole('heading', { name: 'Connected through Ari Connect' })
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Show pairing code' })).toBeEnabled()
  })

  it('never substitutes a managed fallback address for an unavailable Tailscale route', async () => {
    connectState = connect({
      phase: 'ready',
      origin: 'https://connect.example.com',
      clientUrl: 'https://connect.example.com/?computer=computer_1',
    })
    remoteState = remote({ enabled: true, clientUrl: connectState.clientUrl })
    const user = userEvent.setup()
    render(<RemoteSettings />)
    await screen.findByRole('heading', { name: 'Connected through Ari Connect' })
    await user.click(screen.getByRole('button', { name: /Your Tailscale/ }))
    expect(screen.getByText(/No address a phone can reach exists yet/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Show pairing code' })).not.toBeInTheDocument()
  })

  it('configures Connect through the host and signs in without creating a premature invitation', async () => {
    const normal = invokeMock.getMockImplementation()
    invokeMock.mockImplementation(async (method, params) => {
      if (method === 'remote.connect.configure') {
        connectState = connect({ phase: 'signed-out', origin: 'https://connect.example.com' })
        return connectState
      }
      if (method === 'remote.connect.signIn') {
        connectState = connect({
          phase: 'awaiting-approval',
          origin: 'https://connect.example.com',
          computerName: 'Work desktop',
          browserUrl: 'https://connect.example.com/approve',
          expiresAt: Date.now() + 600000,
        })
        return connectState
      }
      return normal!(method, params)
    })
    remoteState = remote({ enabled: true })
    const user = userEvent.setup()
    render(<RemoteSettings />)
    await waitFor(() => expect(screen.getByRole('button', { name: /Ari Connect/ })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: /Ari Connect/ }))
    await user.type(
      screen.getByRole('textbox', { name: 'Ari Connect service address' }),
      'https://connect.example.com',
    )
    await user.click(screen.getByRole('button', { name: 'Save service address' }))
    await user.type(await screen.findByRole('textbox', { name: 'Computer name' }), 'Work desktop')
    await user.click(screen.getByRole('button', { name: 'Sign in with Ari Connect' }))
    expect(
      await screen.findByRole('heading', { name: 'Finish approval in your browser' }),
    ).toBeInTheDocument()
    expect(invokeMock).toHaveBeenCalledWith('remote.connect.configure', {
      origin: 'https://connect.example.com',
    })
    expect(invokeMock).toHaveBeenCalledWith('remote.connect.signIn', {
      computerName: 'Work desktop',
    })
    expect(invokeMock).not.toHaveBeenCalledWith('remote.invite', expect.anything())
  })

  it('polls Connect approval into a ready route before presenting pairing', async () => {
    connectState = connect({
      phase: 'awaiting-approval',
      origin: 'https://connect.example.com',
      browserUrl: 'https://connect.example.com/approve',
    })
    remoteState = remote({ enabled: true })
    vi.useFakeTimers()
    await act(async () => {
      render(<RemoteSettings />)
    })
    expect(
      screen.getByRole('heading', { name: 'Finish approval in your browser' }),
    ).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Show pairing code' })).not.toBeInTheDocument()
    connectState = connect({
      phase: 'ready',
      origin: 'https://connect.example.com',
      clientUrl: 'https://connect.example.com/?computer=computer_1',
    })
    remoteState = remote({ enabled: true, clientUrl: connectState.clientUrl })
    await act(() => vi.advanceTimersByTimeAsync(5000))
    expect(
      screen.getByRole('heading', { name: 'Connected through Ari Connect' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Show pairing code' })).toBeEnabled()
  })

  it('disconnects only Connect and keeps the Tailscale controls available', async () => {
    connectState = connect({
      phase: 'ready',
      origin: 'https://connect.example.com',
      clientUrl: 'https://connect.example.com/?computer=computer_1',
    })
    remoteState = remote({ enabled: true, clientUrl: TAILNET })
    const normal = invokeMock.getMockImplementation()
    invokeMock.mockImplementation(async (method, params) => {
      if (method === 'remote.connect.signOut') {
        connectState = connect({ phase: 'signed-out', origin: 'https://connect.example.com' })
        return connectState
      }
      return normal!(method, params)
    })
    const user = userEvent.setup()
    render(<RemoteSettings />)
    await user.click(await screen.findByRole('button', { name: 'Disconnect Ari Connect' }))
    expect(invokeMock).not.toHaveBeenCalledWith('remote.connect.signOut')
    await user.click(screen.getByRole('button', { name: 'Confirm disconnect' }))
    expect(
      await screen.findByRole('heading', { name: 'Sign in to connect this computer' }),
    ).toBeInTheDocument()
    expect(invokeMock).toHaveBeenCalledWith('remote.connect.signOut')
    expect(invokeMock).not.toHaveBeenCalledWith('remote.disable')
    expect(invokeMock).not.toHaveBeenCalledWith('remote.tailscale.disable')
    await user.click(screen.getByRole('button', { name: /Your Tailscale/ }))
    expect(screen.getByRole('button', { name: 'Serve Ari over Tailscale' })).toBeEnabled()
  })

  it('expires a request and its later invitation independently while the page stays open', async () => {
    render(<RemoteSettings />)
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Remote access' })).toBeEnabled())
    vi.useFakeTimers()
    const at = Date.now()
    publish(
      remote({
        enabled: true,
        clientUrl: TAILNET,
        pending: { ...PENDING, expiresAt: at + 1000 },
        invitation: { invitationId: 'inv_1', url: `${TAILNET}/#pair=inv_1`, expiresAt: at + 2000 },
      }),
    )
    await act(() => vi.advanceTimersByTimeAsync(1001))
    expect(screen.getByRole('alert')).toHaveTextContent('This request expired')
    expect(screen.queryByText(/The invitation expired/)).not.toBeInTheDocument()
    await act(() => vi.advanceTimersByTimeAsync(1001))
    expect(screen.getByText(/The invitation expired/)).toBeInTheDocument()
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
  })

  it('does not grant projects implicitly when the project list arrives after the request', async () => {
    let deliverProjects: ((projects: Project[]) => void) | undefined
    const normal = invokeMock.getMockImplementation()
    invokeMock.mockImplementation((method, params) =>
      method === 'project.list'
        ? new Promise((resolve) => {
            deliverProjects = resolve
          })
        : normal!(method, params),
    )
    remoteState = remote({ enabled: true, clientUrl: TAILNET, pending: PENDING })
    render(<RemoteSettings />)
    expect(await screen.findByText('No projects are registered yet.')).toBeInTheDocument()
    await act(async () => {
      deliverProjects!([PROJECT])
    })
    expect(screen.getByRole('checkbox', { name: 'Ari' })).not.toBeChecked()
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled()
  })

  it('explains a disconnected tailnet and prevents Serve without a network origin', async () => {
    tailscaleState = tailscale({ origin: null, dnsName: null })
    remoteState = remote({ enabled: true })
    render(<RemoteSettings />)
    expect(
      await screen.findByText(/Open Tailscale on this computer and sign in/),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Serve Ari over Tailscale' })).toBeDisabled()
  })

  it('explains unconfigured invite-only Connect without enabling access', async () => {
    const user = userEvent.setup()
    render(<RemoteSettings />)
    await waitFor(() => expect(screen.getByRole('button', { name: /Ari Connect/ })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: /Ari Connect/ }))
    expect(screen.getByRole('heading', { name: 'Ari Connect is invite-only' })).toBeInTheDocument()
    expect(screen.getByText(/has not been configured on this computer/)).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Sign in with Ari Connect' }),
    ).not.toBeInTheDocument()
    expect(screen.getByRole('switch', { name: 'Remote access' })).not.toBeChecked()
    expect(invokeMock).not.toHaveBeenCalledWith('remote.enable', expect.anything())
    await user.click(screen.getByRole('button', { name: /Your Tailscale/ }))
    expect(screen.getByRole('switch', { name: 'Remote access' })).toBeInTheDocument()
  })

  it('surfaces failed initial checks and retries without granting access', async () => {
    invokeMock.mockRejectedValueOnce(new Error('Gateway unavailable'))
    const user = userEvent.setup()
    render(<RemoteSettings />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Gateway unavailable')
    expect(screen.getByRole('switch', { name: 'Remote access' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Retry checks' }))
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Remote access' })).toBeEnabled())
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(invokeMock).not.toHaveBeenCalledWith('remote.enable', expect.anything())
  })

  it('blocks repeated mutations while a request is pending and recovers after failure', async () => {
    const normal = invokeMock.getMockImplementation()
    let rejectEnable: ((reason: Error) => void) | undefined
    invokeMock.mockImplementation((method, params) =>
      method === 'remote.enable'
        ? new Promise((_resolve, reject) => {
            rejectEnable = reject
          })
        : normal!(method, params),
    )
    const user = userEvent.setup()
    render(<RemoteSettings />)
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Remote access' })).toBeEnabled())
    const toggle = screen.getByRole('switch', { name: 'Remote access' })
    await user.click(toggle)
    expect(toggle).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Check connection' })).toBeDisabled()
    await user.click(toggle)
    expect(invokeMock.mock.calls.filter(([method]) => method === 'remote.enable')).toHaveLength(1)
    act(() => rejectEnable!(new Error('Port in use')))
    expect(await screen.findByRole('alert')).toHaveTextContent('Port in use')
    await waitFor(() => expect(toggle).toBeEnabled())
    expect(toggle).not.toBeChecked()
  })

  it('resets verification and project access when another device request replaces the first', async () => {
    remoteState = remote({ enabled: true, clientUrl: TAILNET, pending: PENDING })
    const user = userEvent.setup()
    render(<RemoteSettings />)
    await user.click(await screen.findByRole('checkbox', { name: 'Ari' }))
    await user.click(screen.getByRole('checkbox', { name: 'The codes match' }))
    expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled()
    publish(
      remote({
        enabled: true,
        clientUrl: TAILNET,
        pending: { ...PENDING, confirmationCode: 'NEW-CODE', displayName: 'Another phone' },
      }),
    )
    expect(screen.getByRole('checkbox', { name: 'Ari' })).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'The codes match' })).not.toBeChecked()
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled()
  })

  it('selects all only on request and sends exactly the narrowed project grant', async () => {
    const other = { ...PROJECT, id: 'proj_other', name: 'Other project' }
    const normal = invokeMock.getMockImplementation()
    invokeMock.mockImplementation((method, params) =>
      method === 'project.list' ? Promise.resolve([PROJECT, other]) : normal!(method, params),
    )
    remoteState = remote({ enabled: true, clientUrl: TAILNET, pending: PENDING })
    const user = userEvent.setup()
    render(<RemoteSettings />)
    await user.click(await screen.findByRole('button', { name: 'Select all' }))
    expect(screen.getByRole('checkbox', { name: 'Ari' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Other project' })).toBeChecked()
    await user.click(screen.getByRole('checkbox', { name: 'Other project' }))
    await user.click(screen.getByRole('checkbox', { name: 'The codes match' }))
    await user.click(screen.getByRole('button', { name: 'Approve' }))
    expect(invokeMock).toHaveBeenCalledWith('remote.approve', {
      invitationId: 'inv_1',
      projectIds: ['proj_ari'],
      allowTerminal: false,
    })
    await user.click(screen.getByRole('button', { name: 'Select none' }))
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled()
  })

  it('removes an expired pairing code and offers a new invitation', async () => {
    remoteState = remote({
      enabled: true,
      clientUrl: TAILNET,
      invitation: {
        invitationId: 'inv_expired',
        url: `${TAILNET}/#pair=expired`,
        expiresAt: Date.now() - 1000,
      },
    })
    const user = userEvent.setup()
    render(<RemoteSettings />)
    expect(await screen.findByText(/The invitation expired/)).toBeInTheDocument()
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Show pairing code' }))
    expect(invokeMock).toHaveBeenCalledWith('remote.invite', { method: 'tailscale' })
  })

  it('does not approve an expired device request', async () => {
    remoteState = remote({
      enabled: true,
      clientUrl: TAILNET,
      pending: { ...PENDING, expiresAt: Date.now() - 1000 },
    })
    render(<RemoteSettings />)
    expect(await screen.findByRole('alert')).toHaveTextContent('This request expired')
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled()
    expect(screen.getByRole('checkbox', { name: 'The codes match' })).toBeDisabled()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Deny' })).toBeEnabled())
  })

  it('provides an invitation-address fallback when QR generation fails', async () => {
    const qrSpy = vi.spyOn(QRCode, 'toString').mockRejectedValueOnce(new Error('QR unavailable'))
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
    expect(await screen.findByRole('alert')).toHaveTextContent('Open the invitation address')
    expect(screen.getByText(`${TAILNET}/#pair=inv_1`)).toBeInTheDocument()
    qrSpy.mockRestore()
  })

  it('lets a user cancel a revocation and preserves confirmation after a failed revoke', async () => {
    remoteState = remote({
      devices: [
        { deviceId: 'dev_1', displayName: 'Phone', projectIds: [], pairedAt: 1, lastSeenAt: null },
      ],
    })
    const normal = invokeMock.getMockImplementation()
    invokeMock.mockImplementation((method, params) =>
      method === 'remote.revokeDevice'
        ? Promise.reject(new Error('Could not save'))
        : normal!(method, params),
    )
    const user = userEvent.setup()
    render(<RemoteSettings />)
    await user.click(await screen.findByRole('button', { name: 'Revoke Phone' }))
    await user.click(screen.getByRole('button', { name: 'Keep Phone' }))
    expect(invokeMock).not.toHaveBeenCalledWith('remote.revokeDevice', expect.anything())
    await user.click(screen.getByRole('button', { name: 'Revoke Phone' }))
    await user.click(screen.getByRole('button', { name: 'Confirm revoke Phone' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not save')
    expect(screen.getByRole('button', { name: 'Confirm revoke Phone' })).toBeEnabled()
    expect(screen.getByText('Projects: none')).toBeInTheDocument()
  })

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

  it('requires matching codes and an explicit project grant before approving', async () => {
    remoteState = remote({ enabled: true, clientUrl: TAILNET, pending: PENDING })
    const user = userEvent.setup()
    render(<RemoteSettings />)

    const approve = await screen.findByRole('button', { name: 'Approve' })
    expect(approve).toBeDisabled()
    await user.click(screen.getByRole('checkbox', { name: 'Ari' }))
    expect(approve).toBeDisabled()
    await user.click(screen.getByRole('checkbox', { name: 'The codes match' }))
    expect(approve).toBeEnabled()
    await user.click(approve)

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith('remote.approve', {
        invitationId: 'inv_1',
        projectIds: ['proj_ari'],
        allowTerminal: false,
      }),
    )
  })

  it('lets the user narrow the grant before approving', async () => {
    remoteState = remote({ enabled: true, clientUrl: TAILNET, pending: PENDING })
    const user = userEvent.setup()
    render(<RemoteSettings />)

    await user.click(await screen.findByRole('checkbox', { name: 'Ari' }))
    await user.click(screen.getByRole('checkbox', { name: 'The codes match' }))
    await user.click(screen.getByRole('checkbox', { name: 'Ari' }))
    // A device granted nothing can reach nothing, so an empty grant is not an
    // approval the user could have meant.
    expect(await screen.findByRole('button', { name: 'Approve' })).toBeDisabled()
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

    expect(screen.getByText('Ready to pair')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Show pairing code' })).toBeEnabled()
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

    const stop = await screen.findByRole('button', { name: 'Stop serving Ari' })
    expect(screen.getByText(`Serving Ari at ${TAILNET}.`)).toBeInTheDocument()
    await user.click(stop)
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('remote.tailscale.disable'))
  })

  it('shows a Serve refusal instead of silently staying unserved', async () => {
    remoteState = remote({ enabled: true, clientUrl: TAILNET })
    invokeMock.mockImplementation(async (method) => {
      if (method === 'remote.tailscale.enable') {
        // The refusal lives in the enable answer: a re-read afterwards would
        // report a healthy tailnet with nothing served, which reads as "the
        // button did nothing".
        const refused = tailscale({ error: 'Tailscale refused to change the Serve configuration.' })
        return { remote: remoteState, tailscale: refused }
      }
      if (method === 'remote.tailscale.status') return tailscale()
      if (method === 'remote.connect.status') return connectState
      if (method === 'remote.status') return remoteState
      if (method === 'project.list') return [PROJECT]
      throw new Error(`unexpected method: ${method}`)
    })
    const user = userEvent.setup()
    render(<RemoteSettings />)

    await user.click(await screen.findByRole('button', { name: 'Serve Ari over Tailscale' }))
    expect(
      await screen.findByText('Tailscale refused to change the Serve configuration.'),
    ).toBeInTheDocument()
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
