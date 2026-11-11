import { render, screen, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RemoteTerminal } from './RemoteTerminal'
import { machineFixture } from './fixtures.test-support'

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), write: vi.fn(), dispose: vi.fn(), onData: undefined as ((data: string) => void) | undefined }))
vi.mock('../../lib/rpc', () => ({ rpc: { invoke: mocks.invoke } }))
vi.mock('@xterm/xterm', () => ({ Terminal: class {
  cols = 80; rows = 24; options = { disableStdin: false }
  loadAddon() {} open() {} focus() {} reset() {}
  write = mocks.write
  dispose = mocks.dispose
  onData(listener: (data: string) => void) { mocks.onData = listener; return { dispose() {} } }
} }))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }))

describe('granted host terminal', () => {
  beforeEach(() => {
    localStorage.clear(); mocks.invoke.mockReset(); mocks.write.mockReset(); mocks.dispose.mockReset()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
    mocks.invoke.mockImplementation(async (method, params) => {
      if (method === 'machines.command') return { ok: true, result: params.command.op === 'terminal.create' ? { terminalId: 'host-terminal' } : { accepted: true } }
      return { ok: true, result: { terminalId: 'host-terminal', data: 'Host output\r\n', seq: 1, reset: false, exited: false, hasMore: false, error: null } }
    })
  })
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })
  it('requires an authenticated grant, and binds create/read/write/close to the host and session', async () => {
    const user = userEvent.setup()
    const host = machineFixture()
    const { rerender, unmount } = render(<RemoteTerminal machine={host} sessionId="same-session" />)
    expect(screen.getByRole('button', { name: 'Open host terminal' })).toBeDisabled()
    expect(mocks.invoke).not.toHaveBeenCalled()
    rerender(<RemoteTerminal machine={{ ...host, allowTerminal: true }} sessionId="same-session" />)
    await user.click(screen.getByRole('button', { name: 'Open host terminal' }))
    await waitFor(() => expect(mocks.write).toHaveBeenCalledWith('Host output\r\n'))
    act(() => mocks.onData?.('echo host\r'))
    await waitFor(() => expect(mocks.invoke.mock.calls.some(([, params]) => params.command?.op === 'terminal.write')).toBe(true))
    unmount()
    await waitFor(() => expect(mocks.invoke.mock.calls.some(([, params]) => params.command?.op === 'terminal.kill')).toBe(true))
    expect(mocks.invoke.mock.calls.every(([method, params]) => method.startsWith('machines.') && params.machineId === 'host-a' && (params.command ?? params.query).sessionId === 'same-session')).toBe(true)
    expect(mocks.dispose).toHaveBeenCalled()
  })
  it('blocks input after an uncertain write and never repeats it automatically', async () => {
    const user = userEvent.setup()
    render(<RemoteTerminal machine={{ ...machineFixture(), allowTerminal: true }} sessionId="same-session" />)
    await user.click(screen.getByRole('button', { name: 'Open host terminal' }))
    await screen.findByRole('button', { name: 'Close terminal' })
    const original = mocks.invoke.getMockImplementation()!
    mocks.invoke.mockImplementation(async (method, params) => params.command?.op === 'terminal.write' ? { ok: false, error: { code: 'unreachable', message: 'Lost terminal acknowledgement' } } : original(method, params))
    act(() => mocks.onData?.('one\r'))
    await screen.findByText('Terminal action unconfirmed. Input is blocked.')
    act(() => mocks.onData?.('two\r'))
    expect(mocks.invoke.mock.calls.filter(([, params]) => params.command?.op === 'terminal.write')).toHaveLength(1)
  })
})
