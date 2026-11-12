import { afterEach, describe, expect, it, vi } from 'vitest'
import { GatewayClient } from './gateway-client'
import { RemoteSession } from './session'
import type { DeviceCredential, LeaseAdapter } from './credential'

afterEach(() => vi.useRealTimers())
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  return {
    promise: new Promise<T>((done) => {
      resolve = done
    }),
    resolve: (value) => resolve(value),
  }
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
function success(result: unknown): Response {
  return Response.json({ ok: true, result })
}
const info = {
  protocolVersion: 1,
  capabilities: ['session.list', 'session.prompt', 'events.subscribe'],
}
const authorized = {
  deviceId: 'device_fixture',
  token: 'fixture_token',
  projectIds: ['project'],
  allowTerminal: true,
}

describe('RemoteSession protocol and device grants', () => {
  it('refuses an incompatible pairing before resolving a code, generating a key or requesting approval', async () => {
    const request = vi.fn<typeof fetch>(async () => success({ ...info, protocolVersion: 99 }))
    const credential = keyring(false)
    const publicKey = vi.spyOn(credential, 'publicKey')
    const session = new RemoteSession({
      client: new GatewayClient({ origin: 'https://a.tailnet.ts.net', fetch: request }),
      keyring: credential,
    })
    await expect(session.resolvePairingCode('AAAA-BBBB')).rejects.toMatchObject({
      code: 'unsupported_version',
    })
    await expect(session.pair('inv_fixture', 'Desktop')).rejects.toMatchObject({
      code: 'unsupported_version',
    })
    expect(publicKey).not.toHaveBeenCalled()
    expect(request.mock.calls.every(([url]) => String(url).endsWith('/info'))).toBe(true)
  })

  it('rechecks the protocol after host approval before redeeming a pairing', async () => {
    let approved = false
    const request = vi.fn<typeof fetch>(async (input) => {
      const path = String(input)
      if (path.endsWith('/info')) return success({ ...info, protocolVersion: approved ? 99 : 1 })
      if (path.endsWith('/pair/request'))
        return success({ nonce: 'nonce', confirmationCode: 'AAAA-BBBB' })
      approved = true
      return success({ status: 'approved' })
    })
    const credential = keyring(false)
    const session = new RemoteSession({
      client: new GatewayClient({ origin: 'https://a.tailnet.ts.net', fetch: request }),
      keyring: credential,
    })
    await expect(session.pair('inv_fixture', 'Desktop')).rejects.toMatchObject({
      code: 'unsupported_version',
    })
    expect(request.mock.calls.some(([url]) => String(url).endsWith('/pair/redeem'))).toBe(false)
    expect(credential.remember).not.toHaveBeenCalled()
    expect(session.usable).toBe(false)
  })

  it.each(['query', 'send'] as const)(
    'negotiates a restarted host before %s reauthorization',
    async (operation) => {
      let restarted = false
      let mutations = 0
      const request = vi.fn<typeof fetch>(async (input) => {
        const path = String(input)
        if (path.endsWith('/info')) return success({ ...info, protocolVersion: restarted ? 99 : 1 })
        if (path.endsWith('/device/challenge')) return success({ nonce: 'fixture_nonce' })
        if (path.endsWith('/device/authorize')) return success(authorized)
        mutations++
        restarted = true
        return Response.json(
          { ok: false, error: { code: 'authentication_expired', message: 'host restarted' } },
          { status: 401 },
        )
      })
      const client = new GatewayClient({ origin: 'https://a.tailnet.ts.net', fetch: request })
      const session = new RemoteSession({ client, keyring: keyring() })
      await session.connect()
      await expect(
        operation === 'query'
          ? session.query('session.list')
          : session.send({ op: 'session.prompt', sessionId: 'same', text: 'one' }, 'receipt_same'),
      ).rejects.toMatchObject({ code: 'unsupported_version' })
      expect(mutations).toBe(1)
      expect(
        request.mock.calls.filter(([url]) => String(url).endsWith('/device/challenge')),
      ).toHaveLength(1)
      expect(session.state).toBe('version-mismatch')
      expect(session.usable).toBe(false)
      expect(session.allowTerminal).toBe(false)
      expect(session.projectIds).toEqual([])
      await expect(client.query('session.list')).rejects.toMatchObject({ code: 'unauthenticated' })
    },
  )

  it('takes terminal access only from the current authenticated grant', async () => {
    let grant: boolean | undefined = true
    const request: typeof fetch = async (input) => {
      const path = String(input)
      if (path.endsWith('/info')) return success({ ...info, capabilities: ['terminal.create'] })
      if (path.endsWith('/device/challenge')) return success({ nonce: 'fixture_nonce' })
      return success({ ...authorized, allowTerminal: grant })
    }
    const session = new RemoteSession({
      client: new GatewayClient({ origin: 'https://a.tailnet.ts.net', fetch: request }),
      keyring: keyring(),
    })
    await session.connect()
    expect(session.supports('terminal.create')).toBe(true)
    grant = undefined
    await session.connect()
    expect(session.allowTerminal).toBe(false)
    expect(session.supports('terminal.create')).toBe(false)
  })
})

describe('RemoteSession disposal boundary', () => {
  it('discards a late connect authorization even after a fresh connection succeeds', async () => {
    const late = deferred<Response>()
    let authorizations = 0
    const request = vi.fn<typeof fetch>(async (input) => {
      const path = String(input)
      if (path.endsWith('/info')) return success(info)
      if (path.endsWith('/device/challenge')) return success({ nonce: 'fixture_nonce' })
      if (path.endsWith('/device/authorize'))
        return ++authorizations === 1
          ? late.promise
          : success({ ...authorized, token: 'fresh_token', allowTerminal: false })
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
    expect(new Headers(request.mock.calls.at(-1)?.[1]?.headers).get('authorization')).toBe(
      'Bearer fresh_token',
    )
  })

  it.each(['query', 'send'] as const)(
    'cannot reinstall a token from delayed %s reauthorization after disconnect',
    async (operation) => {
      const late = deferred<Response>()
      let authorizations = 0
      let operations = 0
      const request = vi.fn<typeof fetch>(async (input) => {
        const path = String(input)
        if (path.endsWith('/info')) return success(info)
        if (path.endsWith('/device/challenge')) return success({ nonce: 'fixture_nonce' })
        if (path.endsWith('/device/authorize'))
          return ++authorizations === 1 ? success(authorized) : late.promise
        operations++
        return Response.json(
          { ok: false, error: { code: 'authentication_expired', message: 'expired' } },
          { status: 401 },
        )
      })
      const client = new GatewayClient({ origin: 'https://a.tailnet.ts.net', fetch: request })
      const session = new RemoteSession({ client, keyring: keyring() })
      await session.connect()
      const pending =
        operation === 'query'
          ? session.query('session.list')
          : session.send({ op: 'session.prompt', sessionId: 'same', text: 'one' }, 'receipt_same')
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
    },
  )

  it('cannot install a late lease or publish state after disconnect', async () => {
    const late = deferred<string>()
    let leases = 0
    const lease: LeaseAdapter = {
      token: async () => (++leases === 1 ? 'initial_lease' : late.promise),
    }
    const request = vi.fn<typeof fetch>(async (input) => {
      if (String(input).endsWith('/info')) return success(info)
      if (String(input).endsWith('/device/challenge')) return success({ nonce: 'fixture_nonce' })
      if (String(input).endsWith('/device/authorize')) return success(authorized)
      return success([])
    })
    const client = new GatewayClient({ origin: 'https://a.tailnet.ts.net', fetch: request })
    const states: string[] = []
    const session = new RemoteSession({
      client,
      keyring: keyring(),
      lease,
      onState: (state) => states.push(state),
    })
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
    expect(new Headers(request.mock.calls.at(-1)?.[1]?.headers).has('x-ari-connect-lease')).toBe(
      false,
    )
  })

  it('closes owned streams and cancels delayed stream lease renewal', async () => {
    const late = deferred<string>()
    let leases = 0
    const lease: LeaseAdapter = {
      token: async () => (++leases === 1 ? 'initial_lease' : late.promise),
    }
    const request: typeof fetch = async (input) => {
      if (String(input).endsWith('/info')) return success(info)
      if (String(input).endsWith('/device/challenge')) return success({ nonce: 'fixture_nonce' })
      return success(authorized)
    }
    const socket = Object.assign(new EventTarget(), { send: vi.fn(), close: vi.fn() })
    const open = vi.fn(() => socket as unknown as WebSocket)
    const session = new RemoteSession({
      client: new GatewayClient({
        origin: 'https://a.tailnet.ts.net',
        fetch: request,
        webSocket: open,
      }),
      keyring: keyring(),
      lease,
    })
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
    socket.dispatchEvent(
      Object.assign(new Event('message'), {
        data: JSON.stringify({ type: 'events.frame', sessionId: 'same', events: [] }),
      }),
    )
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
      if (path.endsWith('/pair/request'))
        return success({ nonce: 'nonce', confirmationCode: 'AAAA-BBBB' })
      if (path.endsWith('/pair/status')) return success({ status: 'approved' })
      if (path.endsWith('/pair/redeem')) {
        redeeming = true
        return late.promise
      }
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

describe('RemoteSession uncertain mutation receipts', () => {
  it.each([
    'not_found',
    'conflict',
    'internal_error',
    'unreachable',
    'access_revoked',
    'unsupported_capability',
    'authentication_expired',
    'unsupported_version',
  ] as const)('never resends a mutation when receipt lookup returns %s', async (code) => {
    let mutations = 0
    const keys: string[] = []
    const request: typeof fetch = async (input, init) => {
      const path = String(input)
      if (path.endsWith('/info')) return success(info)
      if (path.endsWith('/device/challenge')) return success({ nonce: 'fixture_nonce' })
      if (path.endsWith('/device/authorize')) return success(authorized)
      const body = JSON.parse(String(init?.body)) as { idempotencyKey: string }
      keys.push(body.idempotencyKey)
      if (path.endsWith('/command')) {
        mutations++
        throw new TypeError('answer lost after execution')
      }
      return Response.json(
        { ok: false, error: { code, message: 'receipt history unavailable' } },
        { status: code === 'not_found' ? 404 : 409 },
      )
    }
    const session = new RemoteSession({
      client: new GatewayClient({ origin: 'https://a.tailnet.ts.net', fetch: request }),
      keyring: keyring(),
    })
    await session.connect()
    await expect(
      session.send({ op: 'session.prompt', sessionId: 'same', text: 'one' }, 'original_receipt'),
    ).rejects.toMatchObject({
      code: 'unreachable',
      idempotencyKey: 'original_receipt',
      retryable: false,
      message: expect.stringMatching(/may have executed/),
    })
    expect(mutations).toBe(1)
    expect(keys).toEqual(['original_receipt', 'original_receipt'])
  })
  it.each([null, {}, { ok: true }, { ok: false, error: { code: 'not_found' } }])(
    'keeps a malformed or nonauthoritative receipt uncertain: %j',
    async (receipt) => {
      let mutations = 0
      const request: typeof fetch = async (input) => {
        const path = String(input)
        if (path.endsWith('/info')) return success(info)
        if (path.endsWith('/device/challenge')) return success({ nonce: 'fixture_nonce' })
        if (path.endsWith('/device/authorize')) return success(authorized)
        if (path.endsWith('/command')) {
          mutations++
          throw new TypeError('answer lost after execution')
        }
        return success(receipt)
      }
      const session = new RemoteSession({
        client: new GatewayClient({ origin: 'https://a.tailnet.ts.net', fetch: request }),
        keyring: keyring(),
      })
      await session.connect()
      await expect(
        session.send({ op: 'session.prompt', sessionId: 'same', text: 'one' }, 'original_receipt'),
      ).rejects.toMatchObject({
        code: 'unreachable',
        idempotencyKey: 'original_receipt',
        retryable: false,
      })
      expect(mutations).toBe(1)
    },
  )
  it('preserves authentication renewal only after an explicit refusal before dispatch', async () => {
    let mutations = 0
    let authorizations = 0
    const keys: string[] = []
    const request: typeof fetch = async (input, init) => {
      const path = String(input)
      if (path.endsWith('/info')) return success(info)
      if (path.endsWith('/device/challenge')) return success({ nonce: 'fixture_nonce' })
      if (path.endsWith('/device/authorize')) {
        authorizations++
        return success(authorized)
      }
      keys.push((JSON.parse(String(init?.body)) as { idempotencyKey: string }).idempotencyKey)
      return ++mutations === 1
        ? Response.json(
            {
              ok: false,
              error: { code: 'authentication_expired', message: 'refused before dispatch' },
            },
            { status: 401 },
          )
        : success({ accepted: true })
    }
    const session = new RemoteSession({
      client: new GatewayClient({ origin: 'https://a.tailnet.ts.net', fetch: request }),
      keyring: keyring(),
    })
    await session.connect()
    await expect(
      session.send({ op: 'session.prompt', sessionId: 'same', text: 'one' }, 'original_receipt'),
    ).resolves.toEqual({ accepted: true })
    expect(keys).toEqual(['original_receipt', 'original_receipt'])
    expect(authorizations).toBe(2)
  })
})
