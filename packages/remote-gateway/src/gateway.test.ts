import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { RemoteCommand, RemoteOperation } from '@ari/contracts/remote'
import { REMOTE_PROTOCOL_VERSION } from '@ari/contracts/remote'
import type { RemoteCaller, RemoteHost } from './host'
import { deviceKey } from './testing/device-key'
import { RawWebSocket, handshake } from './testing/ws-client'
import { createRemoteGateway, type RemoteGateway } from './gateway'
import { ConnectLeaseVerifier } from './connect-lease'

const ALLOWED = 'http://127.0.0.1:5173'

const OPERATIONS: RemoteOperation[] = [
  'gateway.info',
  'session.list',
  'session.prompt',
  'events.subscribe',
]

/** A host that records what it was asked to do, so tests can prove it wasn't. */
function fakeHost(overrides: Partial<RemoteHost> = {}): RemoteHost & {
  executed: RemoteCommand[]
  callers: RemoteCaller[]
} {
  const executed: RemoteCommand[] = []
  const callers: RemoteCaller[] = []
  const accept: RemoteHost['execute'] = async () => ({ ok: true, result: { accepted: true } })
  return {
    executed,
    callers,
    capabilities: () => OPERATIONS,
    listSessions: async () => [],
    listProjects: async () => [],
    getSession: async (_caller, sessionId) => ({
      session: {
        id: sessionId,
        projectId: 'proj_1',
        title: 'Session',
        driverKind: 'claude',
        modelId: null,
        permissionMode: 'ask',
        status: 'idle',
        createdAt: 1,
        updatedAt: 1,
      },
      summary: {
        id: sessionId,
        projectId: 'proj_1',
        title: 'Session',
        updatedAt: 1,
        messageCount: 0,
        archived: false,
        pinned: false,
      },
      seq: 10,
      messages: [],
      pendingApprovals: [],
      pendingInputs: [],
    }),
    replay: async () => [],
    query: async () => ({ sessions: [] }),
    subscribe: () => () => {},
    ...overrides,
    // Recording wraps whatever the test supplied, so overriding `execute`
    // cannot accidentally hide a call the assertions are counting.
    execute: async (caller, command) => {
      callers.push(caller)
      executed.push(command)
      return (overrides.execute ?? accept)(caller, command)
    },
  }
}

const running: RemoteGateway[] = []

afterEach(async () => {
  await Promise.all(running.splice(0).map((gateway) => gateway.close()))
})

async function start(
  host: RemoteHost,
  origins: readonly string[] = [ALLOWED],
): Promise<RemoteGateway> {
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
async function paired(
  gateway: RemoteGateway,
  key: {
    jwk: { kty: 'EC'; crv: 'P-256'; x: string; y: string }
    sign: (nonce: string) => string
  },
  projectIds: readonly string[] = ['proj_1'],
): Promise<string> {
  const invitation = gateway.pairing.begin(gateway.origin)
  const registered = await call(gateway, '/pair/request', {
    invitationId: invitation.invitationId,
    displayName: 'Pixel',
    publicKey: key.jwk,
  })
  const nonce = (registered.body['result'] as Record<string, unknown> | undefined)?.['nonce']
  if (typeof nonce !== 'string') {
    throw new Error(`expected a nonce, got ${JSON.stringify(registered.body)}`)
  }
  gateway.pairing.approve(invitation.invitationId, [...projectIds])
  const redeemed = await call(gateway, '/pair/redeem', {
    invitationId: invitation.invitationId,
    nonce,
    signature: key.sign(nonce),
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
    // The same envelope every route uses, so a client parses one shape.
    expect(body).toEqual({
      ok: true,
      result: { protocolVersion: REMOTE_PROTOCOL_VERSION, capabilities: OPERATIONS },
    })
  })

  it('keeps discovery content-free', async () => {
    const gateway = await start(
      fakeHost({ capabilities: () => ['gateway.info', 'session.list'] as RemoteOperation[] }),
    )
    const { body } = await call(gateway, '/info', { op: 'gateway.info' })
    // Answers before anyone has authenticated, so it must not name a project,
    // a path or a provider — those leak what the desktop is working on.
    expect(Object.keys(body).sort()).toEqual(['ok', 'result'])
    expect(Object.keys(body['result'] as object).sort()).toEqual([
      'capabilities',
      'protocolVersion',
    ])
  })

  it('answers the same question as a query, with no credential either', async () => {
    const gateway = await start(fakeHost())
    const { status, body } = await call(gateway, '/query', { op: 'gateway.info' })
    expect(status).toBe(200)
    expect(body['result']).toEqual({
      protocolVersion: REMOTE_PROTOCOL_VERSION,
      capabilities: OPERATIONS,
    })
  })
})

describe('remote gateway caller identity', () => {
  it('tells the host which device called and which projects it was granted', async () => {
    const host = fakeHost()
    const gateway = await start(host)
    const token = await paired(gateway, deviceKey(), ['proj_alpha', 'proj_beta'])

    await call(gateway, '/command', COMMAND, { token })

    // Authorization without a subject is not authorization: the host is where
    // a device's project grant becomes a decision, so it has to receive it.
    expect(host.callers).toHaveLength(1)
    expect(host.callers[0]?.projectIds).toEqual(['proj_alpha', 'proj_beta'])
    expect(host.callers[0]?.deviceId).toEqual(gateway.pairing.devices()[0]?.deviceId)
  })

  it('hands a subscriber the caller it subscribed as', async () => {
    const seen: RemoteCaller[] = []
    const host = fakeHost({
      subscribe: (caller) => {
        seen.push(caller)
        return () => {}
      },
    })
    const gateway = await start(host)
    const token = await paired(gateway, deviceKey(), ['proj_alpha'])
    const client = await RawWebSocket.open(gateway.port, '/events', {
      origin: ALLOWED,
      protocols: ['ari-remote.v1', `bearer.${token}`],
    })

    client.send(JSON.stringify({ type: 'events.subscribe', sessionId: 'sess_1' }))
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(seen[0]?.projectIds).toEqual(['proj_alpha'])
    client.close()
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

  it('accepts its own origin, because the page it serves is same-origin with it', async () => {
    const host = fakeHost()
    const gateway = await start(host)
    // A browser sends `Origin` on a same-origin POST, so the gateway has to
    // admit the address it is itself listening on or its own PWA could not
    // call it. One exact string, not a wildcard.
    const { status } = await call(gateway, '/command', COMMAND, { origin: gateway.origin })
    expect(status).toBe(401) // no credential, but the origin was not the refusal
    const withToken = await call(gateway, '/command', COMMAND, {
      origin: gateway.origin,
      token: await paired(gateway, deviceKey()),
    })
    expect(withToken.status).toBe(200)
  })

  it('reads a growing allowlist at request time', async () => {
    // The Tailscale wizard adds an origin to a gateway that is already
    // running; the wizard must not have to restart the listener, which would
    // drop every phone's token mid-session.
    const host = fakeHost()
    const origins: string[] = []
    const gateway = await createRemoteGateway({
      host,
      allowedOrigins: () => [...origins],
      port: 0,
    })
    running.push(gateway)

    expect((await call(gateway, '/info', {}, { origin: ALLOWED })).status).toBe(403)
    origins.push(ALLOWED)
    expect((await call(gateway, '/info', {}, { origin: ALLOWED })).status).toBe(200)
  })

  it('echoes the allowed origin on the response, so a browser can read it', async () => {
    const gateway = await start(fakeHost())
    const response = await fetch(`${gateway.origin}/info`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ALLOWED },
      body: JSON.stringify({}),
    })
    expect(response.headers.get('access-control-allow-origin')).toBe(ALLOWED)
    // No cookies are used anywhere, so nothing may ask a browser to send them.
    expect(response.headers.get('access-control-allow-credentials')).toBe('false')
    expect(response.headers.get('vary')?.toLowerCase()).toContain('origin')
  })

  it('does not echo an origin it refused', async () => {
    const gateway = await start(fakeHost())
    const response = await fetch(`${gateway.origin}/info`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      body: JSON.stringify({}),
    })
    expect(response.status).toBe(403)
    // A reflected ACAO would hand the page everything the allowlist exists to
    // withhold, so a refusal carries no CORS grant at all.
    expect(response.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('answers a preflight without a body and without reaching the host', async () => {
    const host = fakeHost()
    const gateway = await start(host)
    const response = await fetch(`${gateway.origin}/command`, {
      method: 'OPTIONS',
      headers: {
        origin: ALLOWED,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type, authorization',
      },
    })
    expect(response.status).toBe(204)
    expect(response.headers.get('access-control-allow-origin')).toBe(ALLOWED)
    expect(response.headers.get('access-control-allow-headers')).toContain('authorization')
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
      {
        op: 'session.create',
        projectId: 'p1',
        permissionMode: 'full',
        clientCommandId: 'c',
        idempotencyKey: 'key-0123456789',
      },
      { token },
    )
    expect(status).toBe(400)
    expect(host.executed).toEqual([])
  })

  it('refuses an operation the host does not advertise', async () => {
    const host = fakeHost({
      capabilities: () => ['gateway.info', 'session.list'] as RemoteOperation[],
    })
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
    const { status } = await call(
      gateway,
      '/command',
      { ...COMMAND, op: 'session.list' },
      { token },
    )
    expect(status).toBe(400)
    expect(host.executed).toEqual([])
  })
})

describe('remote gateway idempotency', () => {
  it('keeps high-volume terminal receipts out of durable prompt records while preserving replay and key conflicts', async () => {
    const written: string[] = []
    const host = fakeHost({ capabilities: () => [...OPERATIONS, 'terminal.write'] })
    const gateway = await createRemoteGateway({
      host,
      allowedOrigins: [ALLOWED],
      port: 0,
      idempotency: { persist: (json) => written.push(json) },
    })
    running.push(gateway)
    const token = await paired(gateway, deviceKey())
    expect((await call(gateway, '/command', COMMAND, { token })).status).toBe(200)
    const durable = written.at(-1)
    const chunk = {
      op: 'terminal.write',
      sessionId: 'sess_1',
      terminalId: 'term_1',
      data: 'pwd\r',
      clientCommandId: 'terminal',
      idempotencyKey: 'terminal-write-key-0',
    }
    for (let start = 0; start < 1001; start += 50) {
      const replies = await Promise.all(
        Array.from({ length: Math.min(50, 1001 - start) }, (_, offset) =>
          call(
            gateway,
            '/command',
            { ...chunk, idempotencyKey: `terminal-write-key-${start + offset}` },
            { token },
          ),
        ),
      )
      expect(replies.every((reply) => reply.status === 200)).toBe(true)
    }
    expect(written).toHaveLength(2)
    expect(written.at(-1)).toBe(durable)
    expect((await call(gateway, '/command', COMMAND, { token })).status).toBe(200)
    expect((await call(gateway, '/command', chunk, { token })).status).toBe(200)
    expect(
      (
        await call(
          gateway,
          '/query',
          { op: 'command.status', idempotencyKey: chunk.idempotencyKey },
          { token },
        )
      ).status,
    ).toBe(200)
    expect(
      (
        await call(
          gateway,
          '/command',
          { ...chunk, idempotencyKey: COMMAND.idempotencyKey },
          { token },
        )
      ).status,
    ).toBe(409)
    expect(
      (
        await call(
          gateway,
          '/command',
          { ...COMMAND, idempotencyKey: chunk.idempotencyKey },
          { token },
        )
      ).status,
    ).toBe(409)
    expect(host.executed).toHaveLength(1002)
  }, 30000)
  it('keeps command receipts private to the device that issued them', async () => {
    const host = fakeHost()
    const gateway = await start(host)
    const first = await paired(gateway, deviceKey())
    const second = await paired(gateway, deviceKey())
    await call(gateway, '/command', COMMAND, { token: first })
    expect(
      (
        await call(
          gateway,
          '/query',
          { op: 'command.status', idempotencyKey: COMMAND.idempotencyKey },
          { token: second },
        )
      ).status,
    ).toBe(404)
    expect((await call(gateway, '/command', COMMAND, { token: second })).status).toBe(200)
    expect(host.executed).toHaveLength(2)
  })

  it('rechecks session scope before replaying a saved receipt', async () => {
    let visible = true
    const base = fakeHost()
    const host = fakeHost({
      getSession: async (caller, id) => (visible ? base.getSession(caller, id) : undefined),
    })
    const gateway = await start(host)
    const token = await paired(gateway, deviceKey())
    await call(gateway, '/command', COMMAND, { token })
    visible = false
    expect((await call(gateway, '/command', COMMAND, { token })).status).toBe(404)
    expect(
      (
        await call(
          gateway,
          '/query',
          { op: 'command.status', idempotencyKey: COMMAND.idempotencyKey },
          { token },
        )
      ).status,
    ).toBe(404)
    expect(host.executed).toHaveLength(1)
  })

  it('accepts the bounded image body while preserving the smaller normal command ceiling', async () => {
    const host = fakeHost({ capabilities: () => [...OPERATIONS, 'attachments.stage'] })
    const gateway = await start(host)
    const token = await paired(gateway, deviceKey())
    const bytes = Buffer.alloc(1024 * 1024)
    const staged = await call(
      gateway,
      '/command',
      {
        ...COMMAND,
        op: 'attachments.stage',
        text: undefined,
        files: [{ name: 'large.png', mimeType: 'image/png', dataBase64: bytes.toString('base64') }],
      },
      { token },
    )
    expect(staged.status).toBe(200)
    expect(
      (
        await call(
          gateway,
          '/command',
          { ...COMMAND, text: 'a'.repeat(1024 * 1024 + 1), idempotencyKey: 'large-text' },
          { token },
        )
      ).status,
    ).toBe(413)
    expect(
      (
        await call(
          gateway,
          '/command',
          {
            ...COMMAND,
            op: 'attachments.stage',
            text: undefined,
            files: [
              {
                name: 'huge.png',
                mimeType: 'image/png',
                dataBase64: Buffer.alloc(1024 * 1024 + 10_000).toString('base64'),
              },
            ],
          },
          { token },
        )
      ).status,
    ).toBe(413)
  })
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

  it('replays a recorded outcome after the gateway has restarted', async () => {
    const first = fakeHost()
    let saved = ''
    const before = await createRemoteGateway({
      host: first,
      allowedOrigins: [ALLOWED],
      port: 0,
      idempotency: { persist: (json) => (saved = json) },
    })
    const token = await paired(before, deviceKey())
    const accepted = await call(before, '/command', COMMAND, { token })
    expect(accepted.status).toBe(200)
    expect(first.executed).toHaveLength(1)
    await before.close()

    // A desktop restarted between the command and the retry: the second
    // gateway has never seen this prompt, and must still not run it twice.
    // The pairing service carries over so the test is about the record, not
    // about re-authorizing — the phone does that with its device key, which
    // is covered above.
    const second = fakeHost()
    const after = await createRemoteGateway({
      host: second,
      allowedOrigins: [ALLOWED],
      port: 0,
      pairing: before.pairing,
      idempotency: { restore: saved },
    })
    running.push(after)
    const retried = await call(after, '/command', COMMAND, { token })
    expect(retried.status).toBe(200)
    expect(retried.body).toEqual(accepted.body)
    expect(second.executed).toEqual([])
  })
})

describe('isolated managed gateway', () => {
  async function managed(host = fakeHost(), startAt = 100_000) {
    let now = startAt
    const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    const jwk = publicKey.export({ format: 'jwk' }) as {
      kty: 'EC'
      crv: 'P-256'
      x: string
      y: string
    }
    const verifier = new ConnectLeaseVerifier({
      issuer: 'https://connect.example',
      computerId: 'comp_12345678',
      jwks: { keys: [{ ...jwk, alg: 'ES256', use: 'sig', kid: 'trusted' }] },
      now: () => now,
    })
    const gateway = await createRemoteGateway({
      host,
      allowedOrigins: [ALLOWED, 'https://machine.tail.ts.net'],
      port: 0,
      now: () => now,
      managedAccess: { verifier: () => verifier },
    })
    running.push(gateway)
    const token = await paired(gateway, deviceKey(), ['proj_1', 'proj_2'])
    const device = gateway.pairing.toPersisted().devices[0]
    if (device === undefined) throw new Error('expected a paired device')
    const key = device.publicKey
    const fingerprint = createHash('sha256')
      .update(JSON.stringify({ crv: key.crv, kty: key.kty, x: key.x, y: key.y }))
      .digest('hex')
    const header = Buffer.from(JSON.stringify({ alg: 'ES256', kid: 'trusted' })).toString(
      'base64url',
    )
    const payload = Buffer.from(
      JSON.stringify({
        iss: 'https://connect.example',
        aud: 'ari-gateway:comp_12345678',
        sub: 'member',
        computerId: 'comp_12345678',
        deviceId: device.deviceId,
        deviceKeyFingerprint: fingerprint,
        projectIds: ['proj_1'],
        iat: Math.floor(now / 1000),
        exp: Math.floor(now / 1000) + 1,
        jti: 'unique',
      }),
    ).toString('base64url')
    const lease = `${header}.${payload}.${sign('sha256', Buffer.from(`${header}.${payload}`), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`
    return {
      gateway,
      token,
      lease,
      advance: (milliseconds: number) => {
        now += milliseconds
      },
    }
  }

  it('requires both paired-device credentials and a scoped membership lease, even with a forged Tailscale origin', async () => {
    const host = fakeHost({ query: async (caller) => caller.projectIds })
    const h = await managed(host)
    expect(
      (await call(h.gateway, '/query', { op: 'session.list' }, { token: h.token })).status,
    ).toBe(403)
    expect(
      (
        await call(
          h.gateway,
          '/query',
          { op: 'session.list' },
          { token: h.token, origin: 'https://machine.tail.ts.net' },
        )
      ).status,
    ).toBe(403)
    expect(
      (
        await call(
          h.gateway,
          '/query',
          { op: 'session.list' },
          { headers: { 'x-ari-connect-lease': h.lease } },
        )
      ).status,
    ).toBe(401)
    const allowed = await call(
      h.gateway,
      '/query',
      { op: 'session.list' },
      { token: h.token, headers: { 'x-ari-connect-lease': h.lease } },
    )
    expect(allowed).toMatchObject({ status: 200, body: { result: ['proj_1'] } })
    h.advance(1000)
    expect(
      (
        await call(h.gateway, '/command', COMMAND, {
          token: h.token,
          headers: { 'x-ari-connect-lease': h.lease },
        })
      ).status,
    ).toBe(403)
    expect(host.executed).toHaveLength(0)
  })

  it('closes an already open managed stream when its lease expires', async () => {
    let stopped = false
    const host = fakeHost({
      subscribe: () => () => {
        stopped = true
      },
    })
    const h = await managed(host, 100_850)
    const client = await RawWebSocket.open(h.gateway.port, '/events', {
      origin: ALLOWED,
      protocols: ['ari-remote.v1', `bearer.${h.token}`, `lease.${h.lease}`],
    })
    client.send(JSON.stringify({ type: 'events.subscribe', sessionId: 'sess_1' }))
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(stopped).toBe(true)
    client.close()
    expect(
      (
        await handshake(h.gateway.port, '/events', {
          origin: ALLOWED,
          protocols: ['ari-remote.v1', `bearer.${h.token}`],
        })
      ).statusLine,
    ).toContain('403')
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
  it('does not send buffered content for an unauthorized session', async () => {
    let stopped = false
    const host = fakeHost({
      getSession: async () => undefined,
      subscribe: (_caller, sessionId, onEvent) => {
        queueMicrotask(() =>
          onEvent({ type: 'turn.started', seq: 1, at: 1, sessionId, turnId: 'secret' }),
        )
        return () => {
          stopped = true
        }
      },
    })
    const gateway = await start(host)
    const token = await paired(gateway, deviceKey())
    const client = await RawWebSocket.open(gateway.port, '/events', {
      origin: ALLOWED,
      protocols: ['ari-remote.v1', `bearer.${token}`],
    })
    client.send(JSON.stringify({ type: 'events.subscribe', sessionId: 'secret', fromSeq: 0 }))
    const message = JSON.parse(await client.nextMessage()) as {
      type: string
      error: { code: string }
    }
    expect(message).toMatchObject({ type: 'error', error: { code: 'not_found' } })
    expect(stopped).toBe(true)
    client.close()
  })

  it('replays from the cursor and removes live events duplicated during replay', async () => {
    let emit: RemoteHost['subscribe'] extends (...args: infer Args) => unknown
      ? Args[2] | undefined
      : never
    const event = { type: 'turn.started' as const, seq: 3, at: 1, sessionId: 'sess_1', turnId: 't' }
    const host = fakeHost({
      subscribe: (_caller, _sessionId, onEvent) => {
        emit = onEvent
        return () => {}
      },
      replay: async (_caller, _sessionId, fromSeq) => {
        expect(fromSeq).toBe(2)
        emit?.(event)
        return [event]
      },
    })
    const gateway = await start(host)
    const token = await paired(gateway, deviceKey())
    const client = await RawWebSocket.open(gateway.port, '/events', {
      origin: ALLOWED,
      protocols: ['ari-remote.v1', `bearer.${token}`],
    })
    client.send(JSON.stringify({ type: 'events.subscribe', sessionId: 'sess_1', fromSeq: 2 }))
    expect(JSON.parse(await client.nextMessage())).toMatchObject({
      type: 'events.frame',
      events: [{ seq: 3 }],
      caughtUp: true,
    })
    emit?.({ ...event, seq: 4 })
    expect(JSON.parse(await client.nextMessage())).toMatchObject({ events: [{ seq: 4 }] })
    client.close()
  })
  it('streams a subscribed session to a paired device', async () => {
    let emit: ((event: unknown) => void) | null = null
    const host = fakeHost({
      subscribe: (_caller, _sessionId, onEvent) => {
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
      subscribe: (_caller, _sessionId, onEvent) => {
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
      subscribe: (_caller, sessionId) => {
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

describe('remote gateway remembered devices', () => {
  /** Registers and redeems a device, returning its id and the nonce it signed. */
  async function pairDevice(
    gateway: RemoteGateway,
    key: ReturnType<typeof deviceKey>,
  ): Promise<string> {
    await paired(gateway, key)
    const device = gateway.pairing.devices()[0]
    if (device === undefined) throw new Error('expected a paired device')
    return device.deviceId
  }

  it('trades a fresh proof for a working token, with no invitation involved', async () => {
    const host = fakeHost()
    const gateway = await start(host)
    const key = deviceKey()
    const deviceId = await pairDevice(gateway, key)

    const challenge = await call(gateway, '/device/challenge', { deviceId })
    const result = challenge.body['result'] as Record<string, unknown> | undefined
    const nonce = result?.['nonce']
    expect(typeof nonce).toBe('string')
    if (typeof nonce !== 'string') return

    const authorized = await call(gateway, '/device/authorize', {
      deviceId,
      nonce,
      signature: key.sign(nonce),
    })
    expect(authorized.status).toBe(200)
    const token = (authorized.body['result'] as Record<string, unknown> | undefined)?.['token']
    expect(typeof token).toBe('string')
    if (typeof token !== 'string') return

    // The point of the whole exchange: a token that reaches the host, obtained
    // without the user pairing anything again.
    const { status } = await call(gateway, '/command', COMMAND, { token })
    expect(status).toBe(200)
    expect(host.executed).toHaveLength(1)
  })

  it('refuses a signature from a key the device was not registered with', async () => {
    const gateway = await start(fakeHost())
    const key = deviceKey()
    const deviceId = await pairDevice(gateway, key)
    const impostor = deviceKey()

    const challenge = await call(gateway, '/device/challenge', { deviceId })
    const nonce = (challenge.body['result'] as Record<string, unknown>)['nonce'] as string
    const { status, body } = await call(gateway, '/device/authorize', {
      deviceId,
      nonce,
      signature: impostor.sign(nonce),
    })
    expect(status).toBe(401)
    expect(errorCode(body)).toBe('invalid_signature')
  })

  it('tells a revoked device it was revoked', async () => {
    const gateway = await start(fakeHost())
    const key = deviceKey()
    const deviceId = await pairDevice(gateway, key)
    gateway.pairing.revoke(deviceId)

    const challenge = await call(gateway, '/device/challenge', { deviceId })
    const nonce = (challenge.body['result'] as Record<string, unknown>)['nonce'] as string
    const { status, body } = await call(gateway, '/device/authorize', {
      deviceId,
      nonce,
      signature: key.sign(nonce),
    })
    // The phone has to be able to put "your access was withdrawn" on screen;
    // a bare 401 would read as a bad password and invite a pointless retry.
    expect(status).toBe(403)
    expect(errorCode(body)).toBe('access_revoked')
  })

  it('answers a challenge for an unknown device without revealing that it is unknown', async () => {
    const gateway = await start(fakeHost())
    const { status, body } = await call(gateway, '/device/challenge', { deviceId: 'dev_nobody' })
    expect(status).toBe(200)
    expect(typeof (body['result'] as Record<string, unknown>)['nonce']).toBe('string')
  })

  it('refuses a malformed authorization without reaching the host', async () => {
    const host = fakeHost()
    const gateway = await start(host)
    const { status, body } = await call(gateway, '/device/authorize', {
      deviceId: 'dev_1',
      nonce: 'n',
    })
    expect(status).toBe(400)
    expect(errorCode(body)).toBe('unsupported_capability')
    expect(host.executed).toEqual([])
  })
})

describe('remote gateway PWA hosting', () => {
  /** A directory shaped like a Vite build, with one file Ari must not serve. */
  function buildDirectory(): string {
    const dir = mkdtempSync(join(tmpdir(), 'ari-pwa-'))
    mkdirSync(join(dir, 'assets'))
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Ari</title>', 'utf8')
    writeFileSync(join(dir, 'manifest.webmanifest'), '{"name":"Ari"}', 'utf8')
    writeFileSync(join(dir, 'sw.js'), 'self.addEventListener("install", () => {})', 'utf8')
    writeFileSync(join(dir, 'icon-192.png'), 'not-really-a-png', 'utf8')
    writeFileSync(join(dir, 'assets', 'app-4f2a1b9c.js'), 'console.log(1)', 'utf8')
    writeFileSync(join(dir, 'id_rsa.pem'), 'private key', 'utf8')
    return dir
  }

  async function startWithWeb(host: RemoteHost, webRoot: string): Promise<RemoteGateway> {
    const gateway = await createRemoteGateway({
      host,
      allowedOrigins: [ALLOWED],
      port: 0,
      webRoot,
    })
    running.push(gateway)
    return gateway
  }

  async function get(gateway: RemoteGateway, path: string, origin?: string): Promise<Response> {
    return fetch(`${gateway.origin}${path}`, {
      headers: origin === undefined ? {} : { origin },
    })
  }

  it('answers a navigation with the app shell', async () => {
    const gateway = await startWithWeb(fakeHost(), buildDirectory())
    const response = await get(gateway, '/')

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')
    // A navigation carries no Origin, which is why this is served before the
    // allowlist check — and the shell must never be stale.
    expect(response.headers.get('cache-control')).toBe('no-cache')
    expect(await response.text()).toContain('<title>Ari</title>')
  })

  it('answers a client route with the same shell', async () => {
    const gateway = await startWithWeb(fakeHost(), buildDirectory())
    const response = await get(gateway, '/sessions/sess_1')

    expect(response.status).toBe(200)
    expect(await response.text()).toContain('<title>Ari</title>')
  })

  it('types the files a build emits, and keeps the worker out of caches', async () => {
    const gateway = await startWithWeb(fakeHost(), buildDirectory())

    const asset = await get(gateway, '/assets/app-4f2a1b9c.js')
    expect(asset.headers.get('content-type')).toContain('text/javascript')
    expect(asset.headers.get('cache-control')).toContain('immutable')

    const manifest = await get(gateway, '/manifest.webmanifest')
    expect(manifest.headers.get('content-type')).toContain('application/manifest+json')
    expect(manifest.headers.get('cache-control')).toBe('no-cache')

    const worker = await get(gateway, '/sw.js')
    expect(worker.headers.get('content-type')).toContain('text/javascript')
    // A cached service worker cannot be updated, which is how a phone keeps an
    // old build forever.
    expect(worker.headers.get('cache-control')).toBe('no-store')

    const icon = await get(gateway, '/icon-192.png')
    expect(icon.headers.get('content-type')).toBe('image/png')
    expect(icon.headers.get('cache-control')).toBe('no-cache')
  })

  it('refuses a path that climbs out of the build directory', async () => {
    const dir = buildDirectory()
    writeFileSync(join(dir, '..', 'ari-pwa-secret.txt'), 'not the app', 'utf8')
    const gateway = await startWithWeb(fakeHost(), dir)

    // `%2f` survives URL normalization, so the traversal reaches the server.
    const response = await get(gateway, '/..%2fari-pwa-secret.txt')
    expect(response.status).toBe(404)
    expect(await response.text()).not.toContain('not the app')
  })

  it('will not serve a file outside the app build, whatever its extension', async () => {
    const gateway = await startWithWeb(fakeHost(), buildDirectory())
    const response = await get(gateway, '/id_rsa.pem')

    expect(response.status).toBe(404)
    expect(await response.text()).not.toContain('private key')
  })

  it('keeps API routes ahead of the shell', async () => {
    const host = fakeHost()
    const gateway = await startWithWeb(host, buildDirectory())

    const info = await get(gateway, '/info', ALLOWED)
    expect(info.headers.get('cache-control')).toBe('no-store')
    expect(info.headers.get('content-type')).toContain('application/json')
    expect(((await info.json()) as Record<string, unknown>)['ok']).toBe(true)

    // A POST to a route that does not exist is a 404 in the protocol's own
    // shape, not the shell with a 200.
    const unknown = await call(gateway, '/nope', {})
    expect(unknown.status).toBe(404)
    expect(errorCode(unknown.body)).toBe('not_found')
    const known = await call(gateway, '/command', COMMAND, {
      token: await paired(gateway, deviceKey()),
    })
    expect(known.status).toBe(200)
    expect(host.executed).toHaveLength(1)
  })

  it('refuses a cross-origin fetch of the app files', async () => {
    const gateway = await startWithWeb(fakeHost(), buildDirectory())
    const response = await get(gateway, '/', 'https://evil.example')

    expect(response.status).toBe(403)
  })

  it('changes nothing when no web root is configured', async () => {
    const gateway = await start(fakeHost())
    const response = await get(gateway, '/', ALLOWED)

    // The API-only gateway keeps its old answer: this is not a page.
    expect(response.status).toBe(400)
    expect(response.headers.get('content-type')).toContain('application/json')
  })
})
