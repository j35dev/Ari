import { afterEach, describe, expect, it } from 'vitest'
import type { RemoteCommand, RemoteOperation } from '@ari/contracts/remote'
import { REMOTE_PROTOCOL_VERSION } from '@ari/contracts/remote'
import type { RemoteHost } from './host'
import { deviceKey } from './testing/device-key'
import { RawWebSocket, handshake } from './testing/ws-client'
import { createRemoteGateway, type RemoteGateway } from './gateway'

const ALLOWED = 'http://127.0.0.1:5173'

const OPERATIONS: RemoteOperation[] = [
  'gateway.info',
  'session.list',
  'session.prompt',
  'events.subscribe',
]

/** A host that records what it was asked to do, so tests can prove it wasn't. */
function fakeHost(overrides: Partial<RemoteHost> = {}): RemoteHost & { executed: RemoteCommand[] } {
  const executed: RemoteCommand[] = []
  const accept: RemoteHost['execute'] = async () => ({ ok: true, result: { accepted: true } })
  return {
    executed,
    capabilities: () => OPERATIONS,
    listSessions: async () => [],
    getSession: async () => undefined,
    replay: async () => [],
    query: async () => ({ sessions: [] }),
    subscribe: () => () => {},
    ...overrides,
    // Recording wraps whatever the test supplied, so overriding `execute`
    // cannot accidentally hide a call the assertions are counting.
    execute: async (command) => {
      executed.push(command)
      return (overrides.execute ?? accept)(command)
    },
  }
}

const running: RemoteGateway[] = []

afterEach(async () => {
  await Promise.all(running.splice(0).map((gateway) => gateway.close()))
})

async function start(host: RemoteHost, origins: readonly string[] = [ALLOWED]): Promise<RemoteGateway> {
  const gateway = await createRemoteGateway({ host, allowedOrigins: origins, port: 0 })
  running.push(gateway)
  return gateway
}

interface CallOptions {
  origin?: string | null
  token?: string
  headers?: Record<string, string>
}

async function call(
  gateway: RemoteGateway,
  path: string,
  body: unknown,
  options: CallOptions = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  // `null` omits the header entirely, which is what a non-browser client sends.
  if (options.origin !== null) headers['origin'] = options.origin ?? ALLOWED
  if (options.token !== undefined) headers['authorization'] = `Bearer ${options.token}`
  const response = await fetch(`${gateway.origin}${path}`, {
    method: 'POST',
    headers: { ...headers, ...options.headers },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

function errorCode(body: Record<string, unknown>): unknown {
  return (body['error'] as Record<string, unknown> | undefined)?.['code']
}

/** Pairs a device end to end and returns the token it holds. */
async function paired(gateway: RemoteGateway, key: {
  jwk: { kty: 'EC'; crv: 'P-256'; x: string; y: string }
  sign: (nonce: string) => string
}): Promise<string> {
  const invitation = gateway.pairing.begin(gateway.origin)
  await call(gateway, '/pair/request', {
    invitationId: invitation.invitationId,
    displayName: 'Pixel',
    publicKey: key.jwk,
  })
  gateway.pairing.approve(invitation.invitationId, ['proj_1'])
  const redeemed = await call(gateway, '/pair/redeem', {
    invitationId: invitation.invitationId,
    nonce: 'nonce',
    signature: key.sign('nonce'),
  })
  const result = redeemed.body['result'] as Record<string, unknown> | undefined
  const token = result?.['token']
  if (typeof token !== 'string') {
    throw new Error(`expected a device token, got ${JSON.stringify(redeemed.body)}`)
  }
  return token
}

const COMMAND = {
  op: 'session.prompt',
  sessionId: 'sess_1',
  text: 'hello',
  clientCommandId: 'c-1',
  idempotencyKey: 'key-0123456789',
}

describe('remote gateway discovery', () => {
  it('answers an anonymous client with a version and its capabilities', async () => {
    const gateway = await start(fakeHost())
    const { status, body } = await call(gateway, '/info', { op: 'gateway.info' })
    expect(status).toBe(200)
    expect(body['protocolVersion']).toBe(REMOTE_PROTOCOL_VERSION)
    expect(body['capabilities']).toEqual(OPERATIONS)
  })

  it('keeps discovery content-free', async () => {
    const gateway = await start(
      fakeHost({ capabilities: () => ['gateway.info', 'session.list'] as RemoteOperation[] }),
    )
    const { body } = await call(gateway, '/info', { op: 'gateway.info' })
    // Answers before anyone has authenticated, so it must not name a project,
    // a path or a provider — those leak what the desktop is working on.
    expect(Object.keys(body).sort()).toEqual(['capabilities', 'protocolVersion'])
  })
})

describe('remote gateway origin policy', () => {
  it('refuses a request from an origin it was not told to trust', async () => {
    const host = fakeHost()
    const gateway = await start(host)
    const { status, body } = await call(gateway, '/command', COMMAND, {
      origin: 'https://evil.example',
      token: 'anything',
    })
    expect(status).toBe(403)
    expect(errorCode(body)).toBe('origin_not_allowed')
    expect(host.executed).toEqual([])
  })

  it('refuses a request that carries no origin at all', async () => {
    const host = fakeHost()
    const gateway = await start(host)
    const { status, body } = await call(gateway, '/command', COMMAND, { origin: null })
    expect(status).toBe(403)
    expect(errorCode(body)).toBe('origin_not_allowed')
    expect(host.executed).toEqual([])
  })

  it('refuses a wildcard even when an operator configures one', async () => {
    const host = fakeHost()
    // A gateway configured with `*` must fail closed rather than match all.
    const gateway = await start(host, ['*'])
    const { status } = await call(gateway, '/command', COMMAND, { origin: 'https://evil.example' })
    expect(status).toBe(403)
    expect(host.executed).toEqual([])
  })
})

describe('remote gateway command authentication', () => {
  it('refuses a command with no credential', async () => {
    const host = fakeHost()
    const gateway = await start(host)
    const { status, body } = await call(gateway, '/command', COMMAND)
    expect(status).toBe(401)
    expect(errorCode(body)).toBe('unauthenticated')
    expect(host.executed).toEqual([])
  })

  it('refuses a token that was never issued', async () => {
    const host = fakeHost()
    const gateway = await start(host)
    const { status, body } = await call(gateway, '/command', COMMAND, { token: 'forged-token' })
    expect(status).toBe(401)
    expect(errorCode(body)).toBe('unauthenticated')
    expect(host.executed).toEqual([])
  })

  it('runs a command from a paired device', async () => {
    const host = fakeHost()
    const gateway = await start(host)
    const key = deviceKey()
    const token = await paired(gateway, key)
    const { status, body } = await call(gateway, '/command', COMMAND, { token })
    expect(status).toBe(200)
    expect(body['ok']).toBe(true)
    expect(host.executed).toHaveLength(1)
    expect(host.executed[0]).toMatchObject({ op: 'session.prompt', text: 'hello' })
  })

  it('stops accepting a command once the device is revoked', async () => {
    const host = fakeHost()
    const gateway = await start(host)
    const token = await paired(gateway, deviceKey())
    const device = gateway.pairing.devices()[0]
    if (device === undefined) throw new Error('expected a paired device')
    gateway.pairing.revoke(device.deviceId)
    const { status } = await call(gateway, '/command', COMMAND, { token })
    expect(status).toBe(401)
    expect(host.executed).toEqual([])
  })
})

describe('remote gateway command allowlist', () => {
  it('has no route for an operation the design defers, and does not reach the host', async () => {
    const host = fakeHost()
    const gateway = await start(host)
    const token = await paired(gateway, deviceKey())
    for (const op of ['terminal.open', 'shell.exec', 'fs.writeTextFile', 'settings.setApiKey']) {
      const { status, body } = await call(
        gateway,
        '/command',
        { ...COMMAND, op, sessionId: 'sess_1' },
        { token },
      )
      expect(status).toBe(400)
      expect(errorCode(body)).toBe('unsupported_capability')
    }
    expect(host.executed).toEqual([])
  })

  it('refuses a field the envelope does not declare', async () => {
    const host = fakeHost()
    const gateway = await start(host)
    const token = await paired(gateway, deviceKey())
    // A remote client asking to raise the permission ceiling must be refused,
    // not handed a session quietly missing what it asked for.
    const { status } = await call(
      gateway,
      '/command',
      { op: 'session.create', projectId: 'p1', permissionMode: 'full', clientCommandId: 'c', idempotencyKey: 'key-0123456789' },
      { token },
    )
    expect(status).toBe(400)
    expect(host.executed).toEqual([])
  })

  it('refuses an operation the host does not advertise', async () => {
    const host = fakeHost({ capabilities: () => ['gateway.info', 'session.list'] as RemoteOperation[] })
    const gateway = await start(host)
    const token = await paired(gateway, deviceKey())
    const { status, body } = await call(gateway, '/command', COMMAND, { token })
    expect(status).toBe(400)
    expect(errorCode(body)).toBe('unsupported_capability')
    expect(host.executed).toEqual([])
  })

  it('refuses a command whose operation is not a command at all', async () => {
    const host = fakeHost()
    const gateway = await start(host)
    const token = await paired(gateway, deviceKey())
    // `session.list` is a read; sending it as a command must not create one.
    const { status } = await call(gateway, '/command', { ...COMMAND, op: 'session.list' }, { token })
    expect(status).toBe(400)
    expect(host.executed).toEqual([])
  })
})

describe('remote gateway idempotency', () => {
  it('replays the recorded outcome instead of running a command twice', async () => {
    const host = fakeHost()
    const gateway = await start(host)
    const token = await paired(gateway, deviceKey())
    const first = await call(gateway, '/command', COMMAND, { token })
    // A phone that retries after a dropped response must not prompt twice.
    const second = await call(gateway, '/command', COMMAND, { token })
    expect(second.status).toBe(200)
    expect(second.body).toEqual(first.body)
    expect(host.executed).toHaveLength(1)
  })

  it('refuses a key reused with a different payload', async () => {
    const host = fakeHost()
    const gateway = await start(host)
    const token = await paired(gateway, deviceKey())
    await call(gateway, '/command', COMMAND, { token })
    const { status, body } = await call(
      gateway,
      '/command',
      { ...COMMAND, text: 'something else entirely' },
      { token },
    )
    expect(status).toBe(409)
    expect(errorCode(body)).toBe('idempotency_conflict')
    expect(host.executed).toHaveLength(1)
  })

  it('answers a status lookup for a key it has seen', async () => {
    const gateway = await start(fakeHost())
    const token = await paired(gateway, deviceKey())
    await call(gateway, '/command', COMMAND, { token })
    const { status, body } = await call(
      gateway,
      '/query',
      { op: 'command.status', idempotencyKey: COMMAND.idempotencyKey },
      { token },
    )
    expect(status).toBe(200)
    expect(body['result']).toEqual({ ok: true, result: { accepted: true } })
  })

  it('replays a failed command as a failure rather than an empty success', async () => {
    const host = fakeHost({
      execute: async () => ({ ok: false, code: 'conflict', message: 'the session is busy' }),
    })
    const gateway = await start(host)
    const token = await paired(gateway, deviceKey())
    const first = await call(gateway, '/command', COMMAND, { token })
    expect(first.status).toBe(409)
    // The retry must carry the same refusal. A bodyless 200 here would parse
    // as a crash on the client and read as success to anyone skimming.
    const second = await call(gateway, '/command', COMMAND, { token })
    expect(second.status).toBe(409)
    expect(errorCode(second.body)).toBe('conflict')
    expect(host.executed).toHaveLength(1)
  })

  it('reports a failed command as failed in a status lookup', async () => {
    const host = fakeHost({
      execute: async () => ({ ok: false, code: 'conflict', message: 'the session is busy' }),
    })
    const gateway = await start(host)
    const token = await paired(gateway, deviceKey())
    await call(gateway, '/command', COMMAND, { token })
    const { status, body } = await call(
      gateway,
      '/query',
      { op: 'command.status', idempotencyKey: COMMAND.idempotencyKey },
      { token },
    )
    expect(status).toBe(409)
    expect(errorCode(body)).toBe('conflict')
  })

  it('reports a key whose command is still running as unfinished', async () => {
    let release = (): void => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const host = fakeHost({
      execute: async () => {
        await held
        return { ok: true, result: { accepted: true } }
      },
    })
    const gateway = await start(host)
    const token = await paired(gateway, deviceKey())
    const inFlight = call(gateway, '/command', COMMAND, { token })
    // Let the first request reach the host before asking about it.
    await new Promise((resolve) => setTimeout(resolve, 20))
    const { status, body } = await call(
      gateway,
      '/query',
      { op: 'command.status', idempotencyKey: COMMAND.idempotencyKey },
      { token },
    )
    expect(status).toBe(409)
    expect(errorCode(body)).toBe('conflict')
    release()
    await inFlight
  })
})

describe('remote gateway queries', () => {
  it('serves a read to a paired device', async () => {
    const host = fakeHost({ listSessions: async () => [] })
    const gateway = await start(host)
    const token = await paired(gateway, deviceKey())
    const { status } = await call(gateway, '/query', { op: 'session.list' }, { token })
    expect(status).toBe(200)
  })

  it('refuses a read to a client with no credential', async () => {
    const gateway = await start(fakeHost())
    const { status, body } = await call(gateway, '/query', { op: 'session.list' })
    expect(status).toBe(401)
    expect(errorCode(body)).toBe('unauthenticated')
  })
})

describe('remote gateway event stream', () => {
  it('streams a subscribed session to a paired device', async () => {
    let emit: ((event: unknown) => void) | null = null
    const host = fakeHost({
      subscribe: (_sessionId, onEvent) => {
        emit = onEvent as (event: unknown) => void
        return () => {
          emit = null
        }
      },
    })
    const gateway = await start(host)
    const token = await paired(gateway, deviceKey())
    const client = await RawWebSocket.open(gateway.port, '/events', {
      origin: ALLOWED,
      protocols: ['ari-remote.v1', `bearer.${token}`],
    })

    client.send(JSON.stringify({ type: 'events.subscribe', sessionId: 'sess_1', fromSeq: 0 }))
    // Give the subscribe a turn to reach the host before emitting.
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(emit).not.toBeNull()
    emit!({ seq: 7, sessionId: 'sess_1', at: 1_000, type: 'message.completed' })

    const frame = JSON.parse(await client.nextMessage()) as Record<string, unknown>
    expect(frame['type']).toBe('events.frame')
    expect(frame['sessionId']).toBe('sess_1')
    expect(frame['events']).toEqual([
      { seq: 7, event: { seq: 7, sessionId: 'sess_1', at: 1_000, type: 'message.completed' } },
    ])
    client.close()
  })

  it('refuses an upgrade from an origin it was not told to trust', async () => {
    const gateway = await start(fakeHost())
    const token = await paired(gateway, deviceKey())
    // A browser always sends Origin on a WebSocket handshake, which is what
    // makes this check meaningful against a hostile page.
    const result = await handshake(gateway.port, '/events', {
      origin: 'https://evil.example',
      protocols: ['ari-remote.v1', `bearer.${token}`],
    })
    expect(result.statusLine).toContain('403')
    result.socket.destroy()
  })

  it('refuses an upgrade with no credential', async () => {
    const gateway = await start(fakeHost())
    const result = await handshake(gateway.port, '/events', { origin: ALLOWED })
    expect(result.statusLine).toContain('401')
    result.socket.destroy()
  })

  it('refuses an upgrade whose token was never issued', async () => {
    const gateway = await start(fakeHost())
    const result = await handshake(gateway.port, '/events', {
      origin: ALLOWED,
      protocols: ['ari-remote.v1', 'bearer.forged-token'],
    })
    expect(result.statusLine).toContain('401')
    result.socket.destroy()
  })

  it('stops streaming to a device that is revoked mid-session', async () => {
    let emit: ((event: unknown) => void) | null = null
    const host = fakeHost({
      subscribe: (_sessionId, onEvent) => {
        emit = onEvent as (event: unknown) => void
        return () => {
          emit = null
        }
      },
    })
    const gateway = await start(host)
    const token = await paired(gateway, deviceKey())
    const client = await RawWebSocket.open(gateway.port, '/events', {
      origin: ALLOWED,
      protocols: ['ari-remote.v1', `bearer.${token}`],
    })
    client.send(JSON.stringify({ type: 'events.subscribe', sessionId: 'sess_1' }))
    await new Promise((resolve) => setTimeout(resolve, 20))

    const device = gateway.pairing.devices()[0]
    if (device === undefined) throw new Error('expected a paired device')
    gateway.pairing.revoke(device.deviceId)

    // The subscription lives in a socket that was authenticated once. A
    // revoked device must not keep receiving the user's transcript.
    emit!({ seq: 8, sessionId: 'sess_1', at: 1_000, type: 'message.completed' })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(emit).toBeNull()
    client.close()
  })

  it('does not accept a subscription for a session it was not asked about', async () => {
    const subscribed: string[] = []
    const host = fakeHost({
      subscribe: (sessionId) => {
        subscribed.push(sessionId)
        return () => {}
      },
    })
    const gateway = await start(host)
    const token = await paired(gateway, deviceKey())
    const client = await RawWebSocket.open(gateway.port, '/events', {
      origin: ALLOWED,
      protocols: ['ari-remote.v1', `bearer.${token}`],
    })
    client.send(JSON.stringify({ type: 'events.subscribe' }))
    client.send(JSON.stringify({ type: 'command', op: 'shell.exec' }))
    await new Promise((resolve) => setTimeout(resolve, 20))
    // Neither message is a well-formed subscribe, so the host is never asked
    // to hand over a session.
    expect(subscribed).toEqual([])
    client.close()
  })
})
