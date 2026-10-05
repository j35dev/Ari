// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://phone.test/"}
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from './App'
import { useApp, type AppValue } from './lib/app-state'
import { DeviceKeyring, MemoryDeviceStore } from './lib/device-key'
import { GatewayClient, RemoteError } from './lib/gateway-client'
import { MobileSession } from './lib/session'
import type * as AppStateModule from './lib/app-state'

vi.mock('./lib/app-state', async (original) => ({
  ...(await original<typeof AppStateModule>()),
  useApp: vi.fn(),
}))
vi.mock('./shell/AppShell', () => ({ AppShell: () => <p>Workspace</p> }))

let app: AppValue
beforeEach(() => {
  history.replaceState(null, '', '/')
  app = {
    origin: location.origin,
    booted: true,
    connection: 'revoked',
    session: new MobileSession({
      keyring: new DeviceKeyring(new MemoryDeviceStore()),
      client: new GatewayClient({ origin: location.origin }),
    }),
    capabilities: [],
    projects: [],
    sessions: [],
    catalog: null,
    error: null,
    refreshing: false,
    lastSyncedAt: null,
    pairingCode: null,
    managedComputerId: null,
    chooseComputer: vi.fn(),
    changeComputer: vi.fn(),
    refresh: vi.fn(async () => {}),
    pair: vi.fn(async () => {}),
    reconnect: vi.fn(async () => {}),
    forget: vi.fn(async () => {}),
    rememberOrigin: vi.fn(),
  }
  vi.mocked(useApp).mockImplementation(() => app)
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('Home Screen setup', () => {
  it('pairs the installed app from the short code shown on the computer', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }))
    app.connection = 'unpaired'
    const resolve = vi
      .spyOn(MobileSession.prototype, 'resolvePairingCode')
      .mockResolvedValue('inv_from_code')
    render(<App />)
    expect(screen.getByRole('heading', { name: 'Connect this app.' })).toBeTruthy()
    fireEvent.change(screen.getByRole('textbox', { name: 'Pairing code' }), {
      target: { value: 'k7qf-2m9x' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(await screen.findByRole('button', { name: 'Pair this phone' })).toBeTruthy()
    expect(resolve).toHaveBeenCalledWith('K7QF2M9X')
    expect(app.pair).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Pair this phone' }))
    expect(app.pair).toHaveBeenCalledWith('inv_from_code', 'My browser')
  })

  it('says a wrong or expired code is wrong without leaving the screen', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }))
    app.connection = 'unpaired'
    vi.spyOn(MobileSession.prototype, 'resolvePairingCode').mockRejectedValue(
      new RemoteError('not_found', 'unknown code'),
    )
    render(<App />)
    fireEvent.change(screen.getByRole('textbox', { name: 'Pairing code' }), {
      target: { value: '0000-0000' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect((await screen.findByRole('alert')).textContent).toMatch(/not right, or it has expired/)
    expect(screen.getByRole('textbox', { name: 'Pairing code' })).toBeTruthy()
  })

  it('accepts a pasted link within the installed app and still waits for explicit pairing', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }))
    app.connection = 'unpaired'
    render(<App />)
    fireEvent.change(screen.getByRole('textbox', { name: 'Pairing code' }), {
      target: { value: `${location.origin}/#pair=inv_installed` },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(location.hash).toBe('')
    expect(app.pair).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Pair this phone' }))
    expect(app.pair).toHaveBeenCalledWith('inv_installed', 'My browser')
  })

  it('explains an address that carries no pairing code', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }))
    app.connection = 'unpaired'
    render(<App />)
    fireEvent.change(screen.getByRole('textbox', { name: 'Pairing code' }), {
      target: { value: 'https://phone.test/' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(screen.getByRole('alert').textContent).toMatch(/8-character code/)
    expect(app.pair).not.toHaveBeenCalled()
  })

  it('warns an iPhone in Safari that pairing here does not pair the Home Screen app', () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (iPhone; CPU iPhone OS)')
    app.connection = 'unpaired'
    history.replaceState(null, '', '/#pair=inv_safari')
    render(<App />)
    expect(screen.getByText(/pairs Safari only/)).toBeTruthy()
    expect(screen.getByText(/Add to Home Screen/)).toBeTruthy()
  })

  it('does not show the Safari warning inside the installed app', () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (iPhone; CPU iPhone OS)')
    vi.stubGlobal('matchMedia', () => ({ matches: true }))
    app.connection = 'unpaired'
    history.replaceState(null, '', '/#pair=inv_app')
    render(<App />)
    expect(screen.queryByText(/pairs Safari only/)).toBeNull()
  })

  it('opens a saved installed-app connection directly into the workspace', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }))
    app.connection = 'connected'
    render(<App />)
    expect(screen.getByText('Workspace')).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Connect this app.' })).toBeNull()
  })
})

describe('revoked phone recovery', () => {
  it('replaces Retry with instructions for a fresh desktop approval', () => {
    render(<App />)
    expect(screen.getByRole('heading', { name: 'Pair this phone again.' })).toBeTruthy()
    expect(screen.getByText(/Retrying the old connection cannot restore access/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
    expect(app.pair).not.toHaveBeenCalled()
    expect(app.reconnect).not.toHaveBeenCalled()
  })

  it('accepts a fresh QR at launch despite a saved revoked identity', () => {
    history.replaceState(null, '', '/#pair=inv_fresh')
    render(<App />)
    expect(location.hash).toBe('')
    expect(app.pair).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Pair this phone' }))
    expect(app.pair).toHaveBeenCalledWith('inv_fresh', 'My browser')
  })

  it('accepts a new fragment in an already running app without automatic pairing', () => {
    render(<App />)
    act(() => {
      history.replaceState(null, '', '/#pair=inv_second')
      window.dispatchEvent(new HashChangeEvent('hashchange'))
    })
    expect(location.hash).toBe('')
    expect(app.pair).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Pair this phone' }))
    expect(app.pair).toHaveBeenCalledWith('inv_second', 'My browser')
  })

  it('discards a consumed invitation after successful pairing', () => {
    history.replaceState(null, '', '/#pair=inv_consumed')
    const view = render(<App />)
    app.connection = 'connected'
    view.rerender(<App />)
    expect(screen.getByText('Workspace')).toBeTruthy()
    app.connection = 'unreachable'
    view.rerender(<App />)
    expect(screen.getByText('Workspace')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Pair this phone' })).toBeNull()
  })

  it('also offers pairing when the desktop has lost its device record', () => {
    app.connection = 'unknown-device'
    render(<App />)
    expect(screen.getByRole('heading', { name: 'Reconnect this phone.' })).toBeTruthy()
    expect(screen.getByText(/no longer recognizes this phone/)).toBeTruthy()
  })
})
