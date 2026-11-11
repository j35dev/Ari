import { afterEach, describe, expect, it, vi } from 'vitest'
import { GatewayClient } from './gateway-client'
import { RemoteSession } from './session'
import type { DeviceCredential, LeaseAdapter } from './credential'

afterEach(() => vi.useRealTimers())
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  return { promise: new Promise<T>((done) => { resolve = done }), resolve: (value) => resolve(value) }
}
function keyring(paired = true): DeviceCredential {
  return {
    deviceId: paired ? 'device_fixture' : null,
    load: async () => undefined,
    publicKey: async () => ({ kty: 'EC', crv: 'P-256', x: 'fixture_x', y: 'fixture_y' }),
    sign: async () => 'fixture_signature',
    remember: vi.fn(async () => undefined),
  }
}
function success(result: unknown): Response { return Response.json({ ok: true, result }) }
const info = { protocolVersion: 1, capabilities: ['session.list', 'session.prompt', 'events.subscribe'] }
const authorized = { deviceId: 'device_fixture', token: 'fixture_token', projectIds: ['project'], allowTerminal: true }

describe('RemoteSession disposal boundary', () => {
  it('discards a late connect authorization even after a fresh connection succeeds', async () => {
    const late = deferred<Response>()
    let authorizations = 0
    const request = vi.fn<typeof fetch>(async (input) => {
      const path = String(input)
      if (path.endsWith('/info')) return success(info)
      if (path.endsWith('/device/challenge')) return success({ nonce: 'fixture_nonce' })
      if (path.endsWith('/device/authorize')) return ++authorizations === 1 ? late.promise : success({ ...authorized, token: 'fresh_token', allowTerminal: false })
      return success([])
    })
    const client = new GatewayClient({ origin: 'https://a.tailnet.ts.net', fetch: request })
    const session = new RemoteSession({ client, keyring: keyring() })
    const connecting = session.connect()
    const cancelled = expect(connecting).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(authorizations).toBe(1))
    session.disconnect()
    expect(await session.connect()).toBe('connected')
    late.resolve(success(authorized))
    await cancelled
    expect(session.state).toBe('connected')
    expect(session.allowTerminal).toBe(false)
    await client.query('session.list')
    expect(new Headers(request.mock.calls.at(-1)?.[1]?.headers).get('authorization')).toBe('Bearer fresh_token')
  })

  it.each(['query', 'send'] as const)('cannot reinstall a token from delayed %s reauthorization after disconnect', async (operation) => {
    const late = deferred<Response>()
    let authorizations = 0
    let operations = 0
    const request = vi.fn<typeof fetch>(async (input) => {
      const path = String(input)
      if (path.endsWith('/info')) return success(info)
      if (path.endsWith('/device/challenge')) return success({ nonce: 'fixture_nonce' })
      if (path.endsWith('/device/authorize')) return ++authorizations === 1 ? success(authorized) : late.promise
      operations++
      return Response.json({ ok: false, error: { code: 'authentication_expired', message: 'expired' } }, { status: 401 })
    })
    const client = new GatewayClient({ origin: 'https://a.tailnet.ts.net', fetch: request })
    const session = new RemoteSession({ client, keyring: keyring() })
    await session.connect()
    const pending = operation === 'query' ? session.query('session.list') : session.send({ op: 'session.prompt', sessionId: 'same', text: 'one' }, 'receipt_same')
    const cancelled = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(authorizations).toBe(2))
    session.disconnect()
    late.resolve(success(authorized))
    await cancelled
    expect(session.state).toBe('unpaired')
    expect(session.usable).toBe(false)
    expect(session.allowTerminal).toBe(false)
    expect(operations).toBe(1)
    await expect(client.query('session.list')).rejects.toMatchObject({ code: 'unauthenticated' })
  })

  it('cannot install a late lease or publish state after disconnect', async () => {
    const late = deferred<string>()
    let leases = 0
    const lease: LeaseAdapter = { token: async () => ++leases === 1 ? 'initial_lease' : late.promise }
    const request = vi.fn<typeof fetch>(async (input) => {
      if (String(input).endsWith('/info')) return success(info)
      if (String(input).endsWith('/device/challenge')) return success({ nonce: 'fixture_nonce' })
      if (String(input).endsWith('/device/authorize')) return success(authorized)
      return success([])
    })
    const client = new GatewayClient({ origin: 'https://a.tailnet.ts.net', fetch: request })
    const states: string[] = []
    const session = new RemoteSession({ client, keyring: keyring(), lease, onState: (state) => states.push(state) })
    await session.connect()
    const query = session.query('session.list')
    const cancelled = expect(query).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(leases).toBe(2))
    session.disconnect()
    const stateCount = states.length
    late.resolve('late_lease')
    await cancelled
    expect(states).toHaveLength(stateCount)
    expect(session.state).toBe('unpaired')
    await expect(client.query('session.list')).rejects.toMatchObject({ code: 'unauthenticated' })
    client.token = 'inspection_token'
    await client.query('session.list')
    expect(new Headers(request.mock.calls.at(-1)?.[1]?.headers).has('x-ari-connect-lease')).toBe(false)
  })

  it('closes owned streams and cancels delayed stream lease renewal', async () => {
    const late = deferred<string>()
    let leases = 0
    const lease: LeaseAdapter = { token: async () => ++leases === 1 ? 'initial_lease' : late.promise }
    const request: typeof fetch = async (input) => {
      if (String(input).endsWith('/info')) return success(info)
      if (String(input).endsWith('/device/challenge')) return success({ nonce: 'fixture_nonce' })
      return success(authorized)
    }
    const socket = Object.assign(new EventTarget(), { send: vi.fn(), close: vi.fn() })
    const open = vi.fn(() => socket as unknown as WebSocket)
    const session = new RemoteSession({ client: new GatewayClient({ origin: 'https://a.tailnet.ts.net', fetch: request, webSocket: open }), keyring: keyring(), lease })
    await session.connect()
    vi.useFakeTimers()
    const onFrame = vi.fn()
    const onClose = vi.fn()
    session.subscribe('same', { onFrame, onClose })
    await vi.advanceTimersByTimeAsync(45_000)
    expect(leases).toBe(2)
    session.disconnect()
    late.resolve('late_lease')
    await vi.advanceTimersByTimeAsync(0)
    socket.dispatchEvent(Object.assign(new Event('message'), { data: JSON.stringify({ type: 'events.frame', sessionId: 'same', events: [] }) }))
    socket.dispatchEvent(Object.assign(new Event('close'), { code: 1008, reason: 'late refusal' }))
    expect(open).toHaveBeenCalledTimes(1)
    expect(socket.close).toHaveBeenCalledTimes(1)
    expect(onFrame).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
    expect(session.state).toBe('unpaired')
  })

  it('does not remember or install a late pairing redemption after removal', async () => {
    const late = deferred<Response>()
    let redeeming = false
    const request: typeof fetch = async (input) => {
      const path = String(input)
      if (path.endsWith('/info')) return success(info)
      if (path.endsWith('/pair/request')) return success({ nonce: 'nonce', confirmationCode: 'AAAA-BBBB' })
      if (path.endsWith('/pair/status')) return success({ status: 'approved' })
      if (path.endsWith('/pair/redeem')) { redeeming = true; return late.promise }
      return success(authorized)
    }
    const credential = keyring(false)
    const client = new GatewayClient({ origin: 'https://a.tailnet.ts.net', fetch: request })
    const session = new RemoteSession({ client, keyring: credential })
    const pairing = session.pair('inv_fixture', 'Desktop')
    const cancelled = expect(pairing).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(redeeming).toBe(true))
    session.disconnect()
    late.resolve(success(authorized))
    await cancelled
    expect(credential.remember).not.toHaveBeenCalled()
    expect(session.state).toBe('unpaired')
    expect(session.allowTerminal).toBe(false)
    await expect(client.query('session.list')).rejects.toMatchObject({ code: 'unauthenticated' })
  })
})
