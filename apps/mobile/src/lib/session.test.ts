import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRemoteGateway, type RemoteGateway } from '@ari/remote-gateway/gateway'
import { PairingService } from '@ari/remote-gateway/pairing'
import type { RemoteCaller, RemoteHost } from '@ari/remote-gateway/host'
import type { JournalEvent } from '@ari/contracts/events'
import { remoteModelCatalogSchema, type RemoteOperation } from '@ari/contracts/remote'
import { sessionIdOf } from './command-result'
import { DeviceKeyring, MemoryDeviceStore } from './device-key'
import { GatewayClient } from './gateway-client'
import { MobileSession } from './session'
import { RawWebSocket } from '../../../../packages/remote-gateway/src/testing/ws-client'

/**
 * The mobile client against the real gateway, over real sockets.
 *
 * Not a mock: the wire format, the origin check, the nonce binding and the DER
 * signature encoding are all exercised together, which is the only way a
 * mismatch between the two ends shows up as a failing test instead of as a
 * phone that will not pair.
 */

const ALLOWED = 'https://ari.tailnet.ts.net'

const running: RemoteGateway[] = []
afterEach(async () => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  await Promise.all(running.splice(0).map((gateway) => gateway.close()))
})

type RecordingHost = RemoteHost & {
  executed: { op: string }[]
  callers: RemoteCaller[]
}

/** A host that records what it was asked to do, and as whom. */
function fakeHost(options: { withChanges?: boolean } = {}): RecordingHost {
  const executed: { op: string }[] = []
  const callers: RemoteCaller[] = []
  const capabilities: RemoteOperation[] = [
    'session.list',
    'session.create',
    'session.prompt',
    'models.list',
    'events.subscribe',
  ]
  if (options.withChanges === true) capabilities.push('changes.files', 'changes.diff')
  return {
    executed,
    callers,
    capabilities: () => capabilities,
    listSessions: async (caller) => {
      callers.push(caller)
      return []
    },
    listProjects: async () => [],
    getSession: async (caller, id) =>
      caller.projectIds.includes('proj_1') && ['sess_1', 'sess_new'].includes(id)
        ? {
            session: {
              id,
              projectId: 'proj_1',
              title: 'Test',
              driverKind: 'claude',
              permissionMode: 'ask',
              modelId: null,
              status: 'idle',
              createdAt: 1,
              updatedAt: 1,
            },
            summary: {
              id,
              projectId: 'proj_1',
              title: 'Test',
              status: 'idle',
              updatedAt: 1,
              messageCount: 0,
            },
            seq: 0,
            messages: [],
            pendingApprovals: [],
            pendingInputs: [],
          }
        : undefined,
    replay: async () => [],
    query: async (caller, op, params) => {
      callers.push(caller)
      if (op === 'models.list') {
        return {
          providers: [{ driverKind: 'claude', models: [{ id: 'model-a', label: 'Model A' }] }],
        }
      }
      if (op === 'changes.files') {
        return { files: [{ path: 'a.txt' }], base: 'workspace-head', error: null }
      }
      if (op === 'changes.diff') {
        const path = (params as { path?: string }).path
        return {
          file:
            path === 'a.txt'
              ? {
                  path: 'a.txt',
                  hunks: [{ header: '@@ -1 +1 @@', lines: [{ type: 'del', content: 'old' }] }],
                }
              : null,
          error: null,
        }
      }
      return { op, sessions: [] }
    },
    subscribe: () => () => {},
    execute: async (caller, command) => {
      callers.push(caller)
      executed.push({ op: command.op })
      if (command.op === 'session.create') {
        return { ok: true, result: { sessionId: 'sess_new' } }
      }
      return { ok: true, result: { accepted: true } }
    },
  }
}

/**
 * Node's fetch sends no `Origin` and a browser will not let script set one, so
 * the test supplies what the browser would and nothing else.
 */
function browserFetch(options: { loseFirstMutation?: boolean } = {}): typeof fetch {
  let lost = false
  return async (input, init) => {
    const headers = new Headers(init?.headers)
    headers.set('origin', ALLOWED)
    const response = await fetch(input, { ...init, headers })
    if (options.loseFirstMutation === true && !lost && response.url.includes('/command')) {
      // The mutation reaches the desktop and its answer is lost on the way
      // back — the exact case that makes a naive client prompt an agent twice.
      lost = true
      await response.text()
      throw new TypeError('network connection lost')
    }
    return response
  }
}

async function startGateway(
  host: RemoteHost = fakeHost(),
  pairing?: PairingService,
): Promise<RemoteGateway> {
  const gateway = await createRemoteGateway({
    host,
    allowedOrigins: [ALLOWED],
    port: 0,
    ...(pairing === undefined ? {} : { pairing }),
  })
  running.push(gateway)
  return gateway
}

/** A session whose client reaches the loopback listener the phone cannot see. */
function sessionFor(
  gateway: RemoteGateway,
  keyring: DeviceKeyring,
  fetchImpl: typeof fetch = browserFetch(),
): MobileSession {
  return new MobileSession({
    client: new GatewayClient({ origin: gateway.origin, fetch: fetchImpl }),
    keyring,
    // The real flow waits for a person to tap Approve on the desktop; these
    // tests tap it in the statement after the next one.
    decisionPollMs: 2,
    decisionTimeoutMs: 2000,
    connectRetryMs: 1,
  })
}

/** Walks a phone through pairing against a gateway, as the user would. */
/** The code the desktop is showing for the device asking now, which an approval must name. */
function shownCode(gateway: RemoteGateway, invitationId: string): string {
  return gateway.pairing.pending(invitationId)?.confirmationCode ?? ''
}

async function pairPhone(gateway: RemoteGateway, keyring: DeviceKeyring): Promise<MobileSession> {
  const session = sessionFor(gateway, keyring)
  const invitation = gateway.pairing.begin(gateway.origin)
  const pairing = session.pair(invitation.invitationId, 'Pixel 9')
  // The desktop's approval is what completes a pairing, so the phone waits
  // for it rather than redeeming the moment it has registered a key.
  await vi.waitFor(() => expect(gateway.pairing.pending(invitation.invitationId)).toBeDefined())
  expect(
    gateway.pairing.approve(invitation.invitationId, shownCode(gateway, invitation.invitationId), [
      'proj_1',
    ]),
  ).toEqual({ ok: true })
  await pairing
  return session
}

describe('mobile pairing', () => {
  it('pairs from the short code an installed app cannot scan', async () => {
    const gateway = await startGateway()
    const session = sessionFor(gateway, new DeviceKeyring(new MemoryDeviceStore()))
    const invitation = gateway.pairing.begin(gateway.origin)

    const invitationId = await session.resolvePairingCode(invitation.code.toLowerCase())
    expect(invitationId).toBe(invitation.invitationId)

    const pairing = session.pair(invitationId, 'iPhone app')
    await vi.waitFor(() => expect(gateway.pairing.pending(invitationId)).toBeDefined())
    gateway.pairing.approve(invitationId, shownCode(gateway, invitationId), ['proj_1'])
    await pairing
    expect(session.state).toBe('connected')
  })

  it('reports a wrong short code as not found', async () => {
    const gateway = await startGateway()
    const session = sessionFor(gateway, new DeviceKeyring(new MemoryDeviceStore()))
    gateway.pairing.begin(gateway.origin)

    await expect(session.resolvePairingCode('0000-0000')).rejects.toMatchObject({
      code: 'not_found',
    })
  })

  it('pairs with an invitation the desktop approved, and talks from then on', async () => {
    const host = fakeHost()
    const gateway = await startGateway(host)
    const keyring = new DeviceKeyring(new MemoryDeviceStore())

    const session = await pairPhone(gateway, keyring)

    expect(session.state).toBe('connected')
    expect(keyring.deviceId).toMatch(/^dev_/)
    // The user's approval is what carried the project grant, and it reached
    // the host with the call.
    await session.query('session.list')
    expect(host.callers[0]?.projectIds).toEqual(['proj_1'])
  })

  it('refuses an invitation the desktop denied', async () => {
    const gateway = await startGateway()
    const keyring = new DeviceKeyring(new MemoryDeviceStore())
    const session = sessionFor(gateway, keyring)

    const invitation = gateway.pairing.begin(gateway.origin)
    const pairing = session.pair(invitation.invitationId, 'Pixel 9')
    await vi.waitFor(() => expect(gateway.pairing.pending(invitation.invitationId)).toBeDefined())
    gateway.pairing.deny(invitation.invitationId)

    await expect(pairing).rejects.toMatchObject({ code: 'pairing_denied' })
    expect(keyring.deviceId).toBeNull()
  })
})

describe('mobile reconnection', () => {
  it('reconnects and resumes one event stream through the real gateway after a TCP drop', async () => {
    const host = fakeHost()
    let highWater = 0
    const getSession = host.getSession.bind(host)
    host.getSession = async (caller, id) => {
      const snapshot = await getSession(caller, id)
      if (snapshot !== undefined) snapshot.seq = highWater
      return snapshot
    }
    const listeners = new Set<(event: JournalEvent) => void>()
    const subscribe = vi.fn<RemoteHost['subscribe']>((_caller, _id, listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    })
    host.subscribe = subscribe
    const replay = vi.spyOn(host, 'replay')
    const gateway = await startGateway(host)
    const keyring = new DeviceKeyring(new MemoryDeviceStore())
    await pairPhone(gateway, keyring)
    const sockets: RawWebSocket[] = []
    const offered: string[][] = []
    // Adapt the existing raw socket fixture to browser events. Only the browser
    // surface is adapted; handshake, bearer, event frames and TCP loss are real.
    const webSocket = (url: string, protocols: string[]): WebSocket => {
      const events = new EventTarget()
      let raw: RawWebSocket | null = null
      let disposed = false
      offered.push(protocols)
      void RawWebSocket.open(Number(new URL(url).port), '/events', { origin: ALLOWED, protocols })
        .then(async (socket) => {
          raw = socket
          sockets.push(socket)
          socket.socket.once('close', () => {
            events.dispatchEvent(Object.assign(new Event('close'), { code: 1006, reason: '' }))
          })
          if (disposed) {
            socket.close()
            return
          }
          events.dispatchEvent(new Event('open'))
          while (!disposed) {
            const data = await socket.nextMessage()
            if (!disposed) events.dispatchEvent(Object.assign(new Event('message'), { data }))
          }
        })
        .catch(() =>
          events.dispatchEvent(Object.assign(new Event('close'), { code: 1006, reason: '' })),
        )
      return {
        addEventListener: events.addEventListener.bind(events),
        send: (data: string) => raw?.send(data),
        close: () => {
          disposed = true
          raw?.close()
        },
      } as unknown as WebSocket
    }
    const session = new MobileSession({
      keyring,
      client: new GatewayClient({ origin: gateway.origin, fetch: browserFetch(), webSocket }),
      connectRetryMs: 1,
    })
    await expect(session.connect()).resolves.toBe('connected')
    const frames: unknown[] = []
    const onFrame = (frame: unknown): void => {
      frames.push(frame)
    }
    const onClose = vi.fn(() => expect(session.state).toBe('reconnecting'))
    const dispose = session.subscribe('sess_1', { fromSeq: 0, onFrame, onClose })
    await vi.waitFor(() => expect(listeners.size).toBe(1))
    const emit = (seq: number): void => {
      highWater = seq
      for (const listener of listeners)
        listener({ type: 'turn.started', seq, at: 1, sessionId: 'sess_1', turnId: `turn_${seq}` })
    }
    emit(1)
    await vi.waitFor(() => expect(frames).toHaveLength(1))
    sockets[0]!.socket.destroy()
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    dispose()
    await vi.waitFor(() => expect(listeners.size).toBe(0))
    await expect(session.connect()).resolves.toBe('connected')
    const resumed = session.subscribe('sess_1', { fromSeq: 1, onFrame, onClose })
    await vi.waitFor(() => expect(listeners.size).toBe(1))
    expect(replay.mock.calls.map((call) => call[2])).toEqual([0, 1])
    emit(2)
    await vi.waitFor(() => expect(frames).toHaveLength(2))
    expect(frames).toMatchObject([
      { type: 'events.frame', events: [{ seq: 1 }] },
      { type: 'events.frame', events: [{ seq: 2 }] },
    ])
    expect(offered[1]).not.toEqual(offered[0])
    expect(subscribe).toHaveBeenCalledTimes(2)
    expect(host.executed).toEqual([])
    expect(session.allowTerminal).toBe(false)
    resumed()
    await vi.waitFor(() => expect(listeners.size).toBe(0))
  })

  it('bounds a failed connection cycle at three spaced attempts', async () => {
    const gateway = await startGateway()
    const keyring = new DeviceKeyring(new MemoryDeviceStore())
    await pairPhone(gateway, keyring)
    const failing = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('network lost'))
    const session = new MobileSession({
      keyring,
      client: new GatewayClient({ origin: gateway.origin, fetch: failing }),
    })
    vi.useFakeTimers()
    const connection = session.connect()
    await vi.advanceTimersByTimeAsync(0)
    expect(failing).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(899)
    expect(failing).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(failing).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1799)
    expect(failing).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    await expect(connection).resolves.toBe('unreachable')
    await vi.advanceTimersByTimeAsync(120000)
    expect(failing).toHaveBeenCalledTimes(3)
    expect(session.usable).toBe(false)
  })

  it('cancels connection backoff without making another transport attempt', async () => {
    const gateway = await startGateway()
    const keyring = new DeviceKeyring(new MemoryDeviceStore())
    await pairPhone(gateway, keyring)
    const failing = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('network lost'))
    const session = new MobileSession({
      keyring,
      client: new GatewayClient({ origin: gateway.origin, fetch: failing }),
    })
    const controller = new AbortController()
    vi.useFakeTimers()
    const connection = session.connect(controller.signal)
    const cancelled = expect(connection).rejects.toMatchObject({ name: 'AbortError' })
    await vi.advanceTimersByTimeAsync(0)
    expect(failing).toHaveBeenCalledTimes(1)
    controller.abort()
    await cancelled
    await vi.advanceTimersByTimeAsync(120000)
    expect(failing).toHaveBeenCalledTimes(1)
    expect(session.usable).toBe(false)
  })

  it('does not install a late authorization response after cancellation', async () => {
    const gateway = await startGateway()
    const keyring = new DeviceKeyring(new MemoryDeviceStore())
    await pairPhone(gateway, keyring)
    let release: (() => void) | undefined
    const browser = browserFetch()
    const delayed: typeof fetch = async (input, init) => {
      const response = await browser(input, init)
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.endsWith('/device/authorize'))
        await new Promise<void>((resolve) => {
          release = resolve
        })
      return response
    }
    const states: string[] = []
    const client = new GatewayClient({ origin: gateway.origin, fetch: delayed })
    const session = new MobileSession({
      keyring,
      client,
      onState: (state) => {
        states.push(state)
      },
    })
    const controller = new AbortController()
    const connection = session.connect(controller.signal)
    const cancelled = expect(connection).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(release).toBeDefined())
    controller.abort()
    release!()
    await cancelled
    expect(states).toEqual(['connecting'])
    expect(session.usable).toBe(false)
    await expect(client.query('session.list')).rejects.toMatchObject({ code: 'unauthenticated' })
  })

  it.each([
    [1000, 'connected'],
    [1001, 'reconnecting'],
    [1006, 'reconnecting'],
    [1008, 'revoked'],
    [1013, 'reconnecting'],
  ] as const)('reports stream close %s as %s before forwarding it', async (code, state) => {
    const gateway = await startGateway()
    const keyring = new DeviceKeyring(new MemoryDeviceStore())
    await pairPhone(gateway, keyring)
    const socket = Object.assign(new EventTarget(), { send: vi.fn(), close: vi.fn() })
    const session = new MobileSession({
      keyring,
      client: new GatewayClient({
        origin: gateway.origin,
        fetch: browserFetch(),
        webSocket: () => socket as unknown as WebSocket,
      }),
    })
    await expect(session.connect()).resolves.toBe('connected')
    const frames = vi.fn()
    const closed = vi.fn(() => expect(session.state).toBe(state))
    const dispose = session.subscribe('sess_1', { onFrame: frames, onClose: closed })
    socket.dispatchEvent(Object.assign(new Event('close'), { code, reason: 'test close' }))
    expect(session.state).toBe(state)
    expect(closed).toHaveBeenCalledExactlyOnceWith({ code, reason: 'test close' })
    dispose()
    socket.dispatchEvent(Object.assign(new Event('close'), { code: 1006, reason: '' }))
    socket.dispatchEvent(
      Object.assign(new Event('message'), {
        data: JSON.stringify({ type: 'events.frame', events: [{ seq: 7 }] }),
      }),
    )
    expect(session.state).toBe(state)
    expect(closed).toHaveBeenCalledTimes(1)
    expect(frames).not.toHaveBeenCalled()
  })

  it('treats a managed policy close as reconnecting and cancels the closed stream renewal', async () => {
    const gateway = await startGateway()
    const keyring = new DeviceKeyring(new MemoryDeviceStore())
    await pairPhone(gateway, keyring)
    const nativeFetch = fetch
    const request = vi.fn<typeof fetch>(async (input, init) => {
      if (input === '/me') return Response.json({ csrfToken: 'test-csrf' })
      if (input === '/leases/renew')
        return Response.json({
          lease: {
            token: 'test-membership',
            expiresAt: new Date(Date.now() + 120000).toISOString(),
          },
        })
      return nativeFetch(input, init)
    })
    vi.stubGlobal('fetch', request)
    const socket = Object.assign(new EventTarget(), { send: vi.fn(), close: vi.fn() })
    const session = new MobileSession({
      keyring,
      managedComputerId: 'computer_1',
      client: new GatewayClient({
        origin: gateway.origin,
        fetch: browserFetch(),
        webSocket: () => socket as unknown as WebSocket,
      }),
    })
    await expect(session.connect()).resolves.toBe('connected')
    request.mockClear()
    vi.useFakeTimers()
    const closed = vi.fn()
    const dispose = session.subscribe('sess_1', { onFrame: vi.fn(), onClose: closed })
    socket.dispatchEvent(Object.assign(new Event('close'), { code: 1008, reason: 'lease expired' }))
    expect(session.state).toBe('reconnecting')
    expect(closed).toHaveBeenCalledExactlyOnceWith({ code: 1008, reason: 'lease expired' })
    await vi.advanceTimersByTimeAsync(45000)
    expect(request).not.toHaveBeenCalled()
    dispose()
    socket.dispatchEvent(Object.assign(new Event('close'), { code: 1006, reason: '' }))
    expect(closed).toHaveBeenCalledTimes(1)
  })

  it('ignores a disposed stream membership renewal that fails after a foreground reconnect', async () => {
    const gateway = await startGateway()
    const keyring = new DeviceKeyring(new MemoryDeviceStore())
    await pairPhone(gateway, keyring)
    const nativeFetch = fetch
    let renewals = 0
    let release: (() => void) | undefined
    vi.stubGlobal('fetch', async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (input === '/me') return Response.json({ csrfToken: 'test-csrf' })
      if (input !== '/leases/renew') return nativeFetch(input, init)
      if (++renewals === 1)
        return Response.json({
          lease: {
            token: 'test-membership',
            expiresAt: new Date(Date.now() + 120000).toISOString(),
          },
        })
      return new Promise<Response>((resolve) => {
        release = () =>
          resolve(
            Response.json(
              { error: { message: 'Membership service unavailable.' } },
              { status: 503 },
            ),
          )
      })
    })
    const socket = Object.assign(new EventTarget(), { send: vi.fn(), close: vi.fn() })
    const session = new MobileSession({
      keyring,
      managedComputerId: 'computer_1',
      client: new GatewayClient({
        origin: gateway.origin,
        fetch: browserFetch(),
        webSocket: () => socket as unknown as WebSocket,
      }),
    })
    await expect(session.connect()).resolves.toBe('connected')
    vi.useFakeTimers()
    const closed = vi.fn()
    const dispose = session.subscribe('sess_1', { onFrame: vi.fn(), onClose: closed })
    await vi.advanceTimersByTimeAsync(45000)
    vi.useRealTimers()
    await vi.waitFor(() => expect(release).toBeDefined())
    dispose()
    // The current lease is still valid, so foreground authorization can finish
    // while the disposed stream's forced renewal remains in flight.
    await expect(session.connect()).resolves.toBe('connected')
    release!()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(session.state).toBe('connected')
    expect(session.usable).toBe(true)
    expect(closed).not.toHaveBeenCalled()
    expect(socket.close).toHaveBeenCalledTimes(1)
  })

  it('re-pairs a revoked phone only after fresh approval and keeps its old identity revoked', async () => {
    const gateway = await startGateway()
    const keyring = new DeviceKeyring(new MemoryDeviceStore())
    const session = await pairPhone(gateway, keyring)
    const oldId = keyring.deviceId
    if (oldId === null) throw new Error('expected a paired device')
    gateway.pairing.revoke(oldId)
    await expect(session.connect()).resolves.toBe('revoked')

    const invitation = gateway.pairing.begin(gateway.origin)
    const pairing = session.pair(invitation.invitationId, 'Pixel 9 again')
    await vi.waitFor(() => expect(gateway.pairing.pending(invitation.invitationId)).toBeDefined())
    expect(session.usable).toBe(false)
    expect(gateway.pairing.devices()).toHaveLength(0)
    expect(
      gateway.pairing.approve(
        invitation.invitationId,
        shownCode(gateway, invitation.invitationId),
        ['proj_1'],
      ),
    ).toEqual({ ok: true })
    await pairing

    expect(session.state).toBe('connected')
    expect(keyring.deviceId).not.toBe(oldId)
    expect(session.projectIds).toEqual(['proj_1'])
    expect(gateway.pairing.authorize(oldId, { nonce: 'unused', signature: 'unused' })).toEqual({
      ok: false,
      code: 'access_revoked',
    })
    await expect(session.query('session.list')).resolves.toBeDefined()
  })

  it('comes back with a signature after the desktop restarts', async () => {
    const first = await startGateway()
    const store = new MemoryDeviceStore()
    await pairPhone(first, new DeviceKeyring(store))

    // A restart: the device records were written down, the tokens were not.
    const restarted = await startGateway(
      fakeHost(),
      new PairingService({ restored: first.pairing.toPersisted() }),
    )
    const session = sessionFor(restarted, new DeviceKeyring(store))

    await expect(session.connect()).resolves.toBe('connected')
    expect(restarted.pairing.devices()).toHaveLength(1)
  })

  it('rides out a cold tailnet instead of stranding the launch', async () => {
    const gateway = await startGateway()
    const store = new MemoryDeviceStore()
    await pairPhone(gateway, new DeviceKeyring(store))

    // The phone's network is up before the tailnet is: the first attempt
    // fails, and the launch must survive it rather than land on "not
    // connected" with no way back.
    let attempts = 0
    const flaky = (async (input: unknown, init?: unknown) => {
      attempts++
      if (attempts === 1) throw new TypeError('network connection lost')
      return browserFetch()(input as never, init as never)
    }) as unknown as typeof fetch
    const session = sessionFor(gateway, new DeviceKeyring(store), flaky)

    await expect(session.connect()).resolves.toBe('connected')
    expect(attempts).toBeGreaterThan(1)
  })

  it('does not retry a refusal the desktop made on purpose', async () => {
    const gateway = await startGateway()
    const store = new MemoryDeviceStore()
    await pairPhone(gateway, new DeviceKeyring(store))
    const deviceId = gateway.pairing.devices()[0]?.deviceId
    if (deviceId === undefined) throw new Error('expected a paired device')
    gateway.pairing.revoke(deviceId)

    let attempts = 0
    const counting = (async (input: unknown, init?: unknown) => {
      attempts++
      return browserFetch()(input as never, init as never)
    }) as unknown as typeof fetch
    const session = sessionFor(gateway, new DeviceKeyring(store), counting)

    await expect(session.connect()).resolves.toBe('revoked')
    // info, challenge, then the authorization that reports the revocation:
    // nothing after the refusal.
    expect(attempts).toBe(3)
  })

  it('reports a revoked device as revoked rather than as unpaired', async () => {
    const gateway = await startGateway()
    const store = new MemoryDeviceStore()
    await pairPhone(gateway, new DeviceKeyring(store))
    const deviceId = gateway.pairing.devices()[0]?.deviceId
    if (deviceId === undefined) throw new Error('expected a paired device')
    gateway.pairing.revoke(deviceId)

    const session = sessionFor(gateway, new DeviceKeyring(store))
    // "Your access was withdrawn" and "this desktop has never seen you" need
    // different words on a phone, because only one invites pairing again.
    await expect(session.connect()).resolves.toBe('revoked')
  })

  it('reports a device the desktop no longer knows', async () => {
    const first = await startGateway()
    const store = new MemoryDeviceStore()
    await pairPhone(first, new DeviceKeyring(store))

    // A desktop whose device records are gone: the phone holds a key nothing
    // has a record of, and re-pairing is the only way forward.
    const fresh = await startGateway()
    const session = sessionFor(fresh, new DeviceKeyring(store))
    await expect(session.connect()).resolves.toBe('unknown-device')
  })

  it('says the version is wrong instead of failing a command later', async () => {
    const gateway = await startGateway()
    const keyring = new DeviceKeyring(new MemoryDeviceStore())
    await keyring.remember({ deviceId: 'dev_1', displayName: 'Pixel', projectIds: [] })

    const stub = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ ok: true, result: { protocolVersion: 99, capabilities: [] } }),
          {
            headers: { 'content-type': 'application/json' },
          },
        ),
    ) as unknown as typeof fetch
    const session = new MobileSession({
      client: new GatewayClient({ origin: gateway.origin, fetch: stub }),
      keyring,
    })
    await expect(session.connect()).resolves.toBe('version-mismatch')
  })

  it('reports an unreachable desktop without claiming anything else', async () => {
    const keyring = new DeviceKeyring(new MemoryDeviceStore())
    await keyring.remember({ deviceId: 'dev_1', displayName: 'Pixel', projectIds: [] })
    const session = new MobileSession({
      client: new GatewayClient({ origin: 'http://127.0.0.1:9' }),
      keyring,
    })
    // Nothing answered, so that is all the client may say. It does not know
    // whether the desktop is off, asleep, or behind a bad connection.
    await expect(session.connect()).resolves.toBe('unreachable')
  })

  it('is unpaired when this browser has no device key at all', async () => {
    const gateway = await startGateway()
    const session = sessionFor(gateway, new DeviceKeyring(new MemoryDeviceStore()))
    await expect(session.connect()).resolves.toBe('unpaired')
  })
})

describe('mobile commands', () => {
  it('does not run a prompt twice when the answer is lost', async () => {
    const host = fakeHost()
    const gateway = await startGateway(host)
    const store = new MemoryDeviceStore()
    // Paired over a working connection first, so what this test exercises is
    // the lost answer and nothing else.
    await pairPhone(gateway, new DeviceKeyring(store))

    const lossy = sessionFor(
      gateway,
      new DeviceKeyring(store),
      browserFetch({ loseFirstMutation: true }),
    )
    await expect(lossy.connect()).resolves.toBe('connected')

    const outcome = await lossy.send({
      op: 'session.prompt',
      sessionId: 'sess_1',
      text: 'summarize the failing test',
    })

    // The desktop ran it once: the retry asked what became of the key instead
    // of sending the prompt again.
    expect(host.executed.filter((entry) => entry.op === 'session.prompt')).toHaveLength(1)
    expect(outcome).toEqual({ ok: true, result: { accepted: true } })
  })

  it('keeps a lost prompt uncertain when its receipt is absent instead of resending it', async () => {
    const host = fakeHost()
    const gateway = await startGateway(host)
    const store = new MemoryDeviceStore()
    await pairPhone(gateway, new DeviceKeyring(store))
    const browser = browserFetch({ loseFirstMutation: true })
    const missingReceipt: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (
        url.endsWith('/query') &&
        typeof init?.body === 'string' &&
        init.body.includes('command.status')
      )
        return Response.json(
          { ok: false, error: { code: 'not_found', message: 'receipt history was evicted' } },
          { status: 404 },
        )
      return browser(input, init)
    }
    const session = sessionFor(gateway, new DeviceKeyring(store), missingReceipt)
    await session.connect()
    const sending = session.send(
      { op: 'session.prompt', sessionId: 'sess_1', text: 'only once' },
      'lost_prompt_receipt',
    )
    await expect(sending).rejects.toMatchObject({
      code: 'unreachable',
      idempotencyKey: 'lost_prompt_receipt',
      retryable: false,
    })
    await expect(sending).rejects.toThrow(/may have executed/)
    expect(host.executed.filter((entry) => entry.op === 'session.prompt')).toHaveLength(1)
  })

  it('reads the change list and one diff from a desktop that serves them', async () => {
    const gateway = await startGateway(fakeHost({ withChanges: true }))
    const session = await pairPhone(gateway, new DeviceKeyring(new MemoryDeviceStore()))
    // Capabilities arrive on connect, the way every app launch fetches them.
    await expect(session.connect()).resolves.toBe('connected')

    expect(session.supports('changes.files')).toBe(true)
    const files = await session.query<{
      files: { path: string }[]
      base: string
      error: string | null
    }>('changes.files', { sessionId: 'sess_1' })
    expect(files).toEqual({
      files: [{ path: 'a.txt' }],
      base: 'workspace-head',
      error: null,
    })

    const one = await session.query<{
      file: { path: string; hunks: { header: string }[] } | null
      error: string | null
    }>('changes.diff', { sessionId: 'sess_1', path: 'a.txt' })
    expect(one.file?.hunks[0]?.header).toBe('@@ -1 +1 @@')

    const missing = await session.query<{ file: null; error: string | null }>('changes.diff', {
      sessionId: 'sess_1',
      path: 'nope.txt',
    })
    expect(missing.file).toBeNull()
  })

  it('hides the changes tab when the desktop serves no change list', async () => {
    const gateway = await startGateway(fakeHost())
    const session = await pairPhone(gateway, new DeviceKeyring(new MemoryDeviceStore()))
    await expect(session.connect()).resolves.toBe('connected')

    // Capabilities come from the desktop's own discovery answer, so an older
    // desktop simply has no Changes tab rather than a failing one.
    expect(session.supports('changes.files')).toBe(false)
  })

  it('names the created session inside the gateway envelope', async () => {
    const host = fakeHost()
    const gateway = await startGateway(host)
    const session = await pairPhone(gateway, new DeviceKeyring(new MemoryDeviceStore()))
    await expect(session.connect()).resolves.toBe('connected')

    // The host's answer travels inside the gateway's own envelope. A client
    // that reads the outer layer reports a failure for a session that exists,
    // and the retry creates a duplicate.
    const created = await session.send({ op: 'session.create', projectId: 'proj_1' })
    expect(sessionIdOf(created)).toBe('sess_new')
  })

  it('lists the desktop catalog for the new-session picker', async () => {
    const gateway = await startGateway(fakeHost())
    const session = await pairPhone(gateway, new DeviceKeyring(new MemoryDeviceStore()))
    await expect(session.connect()).resolves.toBe('connected')

    expect(session.supports('models.list')).toBe(true)
    const catalog = await session.query<{
      providers: { driverKind: string; models: { id: string; label: string }[] }[]
    }>('models.list')
    expect(remoteModelCatalogSchema.safeParse(catalog).success).toBe(true)
    expect(catalog.providers[0]).toEqual({
      driverKind: 'claude',
      models: [{ id: 'model-a', label: 'Model A' }],
    })
  })

  it('mints a key per command, so two prompts are two prompts', async () => {
    const host = fakeHost()
    const gateway = await startGateway(host)
    const session = await pairPhone(gateway, new DeviceKeyring(new MemoryDeviceStore()))

    await session.send({ op: 'session.prompt', sessionId: 'sess_1', text: 'first' })
    await session.send({ op: 'session.prompt', sessionId: 'sess_1', text: 'first' })
    // Same text, different keys: a user who sends the same thing twice means
    // it twice.
    expect(host.executed).toHaveLength(2)
  })
})
