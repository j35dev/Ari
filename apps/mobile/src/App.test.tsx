// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://phone.test/"}
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from './App'
import { useApp, type AppValue } from './lib/app-state'
import { DeviceKeyring, MemoryDeviceStore } from './lib/device-key'
import { GatewayClient } from './lib/gateway-client'
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
  it('accepts a fresh link within the installed app and still waits for explicit pairing', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }))
    app.connection = 'unpaired'
    render(<App />)
    expect(screen.getByRole('heading', { name: 'Connect this app.' })).toBeTruthy()
    expect(screen.getByText(/own secure storage/)).toBeTruthy()
    fireEvent.change(screen.getByRole('textbox', { name: 'Fresh pairing link' }), {
      target: { value: `${location.origin}/#pair=inv_installed` },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Use pairing link' }))
    expect(location.hash).toBe('')
    expect(app.pair).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Pair this phone' }))
    expect(app.pair).toHaveBeenCalledWith('inv_installed', 'My browser')
  })

  it.each([
    ['https://other.test/#pair=inv_other', /another address/],
    [`https://phone.test/`, /no pairing code/],
    ['https://user:password@phone.test/#pair=inv_secret', /full HTTPS pairing link/],
    ['http://phone.test/#pair=inv_http', /full HTTPS pairing link/],
  ])('rejects an inappropriate installed-app link: %s', (link, message) => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }))
    app.connection = 'unpaired'
    render(<App />)
    fireEvent.change(screen.getByRole('textbox', { name: 'Fresh pairing link' }), {
      target: { value: link },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Use pairing link' }))
    expect(screen.getByRole('alert').textContent).toMatch(message)
    expect(app.pair).not.toHaveBeenCalled()
    expect(location.hash).toBe('')
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
