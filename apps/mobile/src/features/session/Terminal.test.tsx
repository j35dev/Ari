// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RemoteError } from '../../lib/gateway-client'
import { readTerminalState, writeTerminalState } from '../../lib/terminal-state'
import { Terminal } from './Terminal'

const app = vi.hoisted(() => ({
  origin: 'https://studio.tailnet.ts.net:8443', connection: 'connected',
  session: { deviceId: 'phone', usable: true, allowTerminal: true, send: vi.fn(), query: vi.fn() },
}))
vi.mock('../../lib/app-state', () => ({ useApp: () => app }))
vi.mock('@xterm/xterm', () => ({ Terminal: class {
  cols = 80; rows = 24; options = {}
  loadAddon() {} open() {} reset() {} write() {} dispose() {}
  onData() { return { dispose() {} } }
} }))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }))
beforeEach(() => {
  vi.useFakeTimers()
  sessionStorage.clear()
  app.session.send.mockReset().mockRejectedValue(new RemoteError('unreachable', 'Lost shell creation'))
  app.session.query.mockReset().mockRejectedValue(new RemoteError('not_found', 'History absent'))
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    fillRect() {}, getImageData() { return { data: [0, 0, 0] } },
  } as unknown as CanvasRenderingContext2D)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('terminal receipt recovery', () => {
  it('never repeats shell creation while polling missing receipts', async () => {
    await act(async () => { render(<Terminal sessionId="same" active />) })
    const key = readTerminalState(app.origin, 'phone', 'same').creationKey
    expect(key).not.toBeNull()
    await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
    expect(app.session.send).toHaveBeenCalledOnce()
    expect(app.session.query).toHaveBeenCalledTimes(3)
    expect(app.session.query).toHaveBeenLastCalledWith('command.status', { idempotencyKey: key })
    expect(readTerminalState(app.origin, 'phone', 'same').creationKey).toBe(key)
  })

  it.each([null, { ok: true, result: {} }, new RemoteError('not_found', 'History absent')])(
    'restores a pending shell without creating another for missing/corrupt history: %j', async (outcome) => {
      writeTerminalState(app.origin, 'phone', 'same', { terminalId: null, creationKey: 'original-receipt', closed: false })
      if (outcome instanceof Error) app.session.query.mockRejectedValue(outcome)
      else app.session.query.mockResolvedValue(outcome)
      await act(async () => { render(<Terminal sessionId="same" active />) })
      await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
      expect(app.session.send).not.toHaveBeenCalled()
      expect(app.session.query).toHaveBeenLastCalledWith('command.status', { idempotencyKey: 'original-receipt' })
      expect(readTerminalState(app.origin, 'phone', 'same').creationKey).toBe('original-receipt')
    },
  )

  it('does not repopulate a forgotten shell reference after leaving during creation', async () => {
    let resolve!: (outcome: unknown) => void
    app.session.send.mockImplementationOnce(() => new Promise((done) => { resolve = done }))
    const view = render(<Terminal sessionId="same" active />)
    expect(app.session.send).toHaveBeenCalledOnce()
    view.unmount()
    sessionStorage.clear()
    await act(async () => resolve({ ok: true, result: { terminalId: 'late-shell' } }))
    expect(sessionStorage.length).toBe(0)
  })
})
