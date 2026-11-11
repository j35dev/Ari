// @vitest-environment jsdom
import { webcrypto } from 'node:crypto'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppProvider, useApp } from './app-state'
import { MemoryDeviceStore, type DeviceStore } from './device-key'

const transport = vi.hoisted(() => ({
  redeem: vi.fn<() => Promise<{ token: string; deviceId: string }>>(),
  failure: vi.fn(), forgotten: vi.fn(), token: null as string | null,
}))
vi.mock('./gateway-client', async (original) => ({
  ...(await original<typeof import('./gateway-client')>()),
  GatewayClient: class {
    get token() { return transport.token }
    set token(value: string | null) { transport.token = value }
    async info() { return { protocolVersion: 1, capabilities: ['project.list', 'session.list'] } }
    async pairRequest() { return { nonce: 'host-nonce', confirmationCode: '123456' } }
    async pairStatus() { return 'approved' }
    pairRedeem() { return transport.redeem() }
  },
}))
function Probe() {
  const app = useApp()
  return <>
    <p>{app.connection}</p>
    <button onClick={() => void app.pair('host-invitation', 'Review phone').catch(transport.failure)}>Pair</button>
    <button onClick={() => void app.forget().then(transport.forgotten)}>Forget</button>
  </>
}
function deferred() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => { release = resolve })
  return { promise, release }
}
beforeEach(() => { vi.stubGlobal('crypto', webcrypto); localStorage.clear(); transport.token = null; transport.redeem.mockReset() })
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks() })
describe('forget during host-approved pairing', () => {
  it('aborts a delayed redemption and never restores the forgotten key or record', async () => {
    const gate = deferred()
    transport.redeem.mockImplementation(async () => { await gate.promise; return { token: 'late-token', deviceId: 'late-device' } })
    const store = new MemoryDeviceStore()
    render(<AppProvider store={store}><Probe /></AppProvider>)
    await screen.findByText('unpaired')
    fireEvent.click(screen.getByRole('button', { name: 'Pair' }))
    await waitFor(() => expect(transport.redeem).toHaveBeenCalledOnce())
    fireEvent.click(screen.getByRole('button', { name: 'Forget' }))
    gate.release()
    await waitFor(() => expect(transport.forgotten).toHaveBeenCalledOnce())
    expect(transport.failure).toHaveBeenCalledOnce()
    expect(await store.forOrigin(location.origin).loadRecord()).toBeNull()
    expect(await store.forOrigin(location.origin).loadKey()).toBeNull()
    expect(transport.token).toBeNull()
  })
  it('clears after an already-running record write and preserves a different computer', async () => {
    const base = new MemoryDeviceStore()
    const selected = base.forOrigin(location.origin)
    const other = base.forOrigin('https://travel.tailnet.ts.net')
    await other.saveRecord({ deviceId: 'other-phone', displayName: 'Other computer', projectIds: [] })
    const writing = deferred()
    const releaseWrite = deferred()
    const store: DeviceStore = {
      forOrigin: (origin) => origin === location.origin ? store : base.forOrigin(origin),
      loadKey: () => selected.loadKey(), saveKey: (key) => selected.saveKey(key),
      loadRecord: () => selected.loadRecord(), clear: () => selected.clear(),
      saveRecord: async (record) => { writing.release(); await releaseWrite.promise; await selected.saveRecord(record) },
    }
    transport.redeem.mockResolvedValue({ token: 'early-token', deviceId: 'approved-device' })
    render(<AppProvider store={store}><Probe /></AppProvider>)
    await screen.findByText('unpaired')
    fireEvent.click(screen.getByRole('button', { name: 'Pair' }))
    await writing.promise
    fireEvent.click(screen.getByRole('button', { name: 'Forget' }))
    expect(transport.forgotten).not.toHaveBeenCalled()
    releaseWrite.release()
    await waitFor(() => expect(transport.forgotten).toHaveBeenCalledOnce())
    expect(await selected.loadRecord()).toBeNull()
    expect(await selected.loadKey()).toBeNull()
    expect((await other.loadRecord())?.deviceId).toBe('other-phone')
    expect(transport.token).toBeNull()
  })
})
