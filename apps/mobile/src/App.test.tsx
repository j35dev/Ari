// @vitest-environment jsdom
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
