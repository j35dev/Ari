import { generateKeyPairSync, sign } from 'node:crypto'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RemoteState } from '@ari/contracts/rpc'
import type { DriverKind } from '@ari/contracts/common'
import type { Engine } from './engine'
import type { SessionStore } from '@ari/engine/session-store'
import { RemoteService, type RemoteServiceDeps } from './remote'

/**
 * The desktop end of remote access: the gateway's lifetime, the two decisions
 * the user makes in-process, and the records that outlive the process.
 *
 * These drive a real listener over real HTTP, because the parts worth testing
 * — that a device stays paired across a restart, that an invitation is single
 * use, that approval is what grants a project — are properties of the whole
 * path, not of a function.
 */

const ALLOWED = 'http://127.0.0.1:5173'

function deviceKey(): {
  jwk: { kty: 'EC'; crv: 'P-256'; x: string; y: string }
  sign: (n: string) => string
} {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const jwk = publicKey.export({ format: 'jwk' }) as {
    kty: 'EC'
    crv: 'P-256'
    x: string
    y: string
  }
  return {
    jwk,
    sign: (nonce) =>
      sign('sha256', Buffer.from(nonce), { key: privateKey, dsaEncoding: 'der' }).toString(
        'base64',
      ),
  }
}

function fakeEngine(): Engine {
  return {
    dispatch: async () => ({ accepted: true }),
    createSession: async () => undefined,
    replaySession: async () => [],
  } as unknown as Engine
}

function fakeStore(): SessionStore {
  return {
    load: async () => ({ session: null, messages: [], lastSeq: -1 }),
    listSessions: async () => [],
    subscribe: () => () => {},
  } as unknown as SessionStore
}

interface Harness {
  service: RemoteService
  dir: string
  states: RemoteState[]
}

const live: RemoteService[] = []
let counter = 0

function makeService(overrides: Partial<RemoteServiceDeps> = {}, port = 0): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'ari-remote-'))
  const states: RemoteState[] = []
  const service = new RemoteService(
    {
      engine: fakeEngine(),
      store: fakeStore(),
      dir,
      driverKinds: () => ['claude'],
      defaultPermissionMode: () => 'ask',
      defaultDriverKind: () => 'claude',
      hasProject: async () => true,
      listProjects: async () => [{ id: 'proj_1', name: 'Ari' }],
      listModels: async () => [],
      // Distinct per service so a restart is a different gateway identity.
      mintSessionId: () => `sess_${++counter}`,
      clientOrigin: () => null,
      allowedOrigins: () => [ALLOWED],
      onChange: (state) => states.push(state),
      ...overrides,
    },
    { port },
  )
  live.push(service)
  return { service, dir, states }
}

afterEach(async () => {
  await Promise.all(live.splice(0).map((service) => service.stop()))
})

async function call(
  origin: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ALLOWED, ...headers },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

/** Walks a device through the pairing handshake the phone performs. */
async function pair(
  service: RemoteService,
  key: ReturnType<typeof deviceKey>,
  projectIds: string[] = ['proj_1'],
): Promise<string> {
  const invited = service.invite()
  const invitationId = invited.invitation?.invitationId
  if (invitationId === undefined) throw new Error('expected an invitation')
  const origin = invited.origin
  if (origin === null) throw new Error('expected a running gateway')

  const registered = await call(origin, '/pair/request', {
    invitationId,
    displayName: 'Pixel',
    publicKey: key.jwk,
  })
  const nonce = (registered.body['result'] as Record<string, unknown>)['nonce'] as string
  service.approve(invitationId, projectIds)
  const redeemed = await call(origin, '/pair/redeem', {
    invitationId,
    nonce,
    signature: key.sign(nonce),
  })
  const token = (redeemed.body['result'] as Record<string, unknown>)['token']
  if (typeof token !== 'string')
    throw new Error(`expected a token, got ${JSON.stringify(redeemed.body)}`)
  return token
}

describe('remote service lifecycle', () => {
  it('is off until it is started, and says where it listens once it is', async () => {
    const { service } = makeService()
    expect(service.state().enabled).toBe(false)
    expect(service.state().origin).toBeNull()

    const state = await service.start()
    expect(state.enabled).toBe(true)
    expect(state.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
  })

  it('reports why it could not start rather than claiming to be on', async () => {
    const first = makeService()
    await first.service.start()
    const taken = first.service.state().origin
    if (taken === null) throw new Error('expected an origin')
    const port = Number(new URL(taken).port)

    // A second desktop on the same port: the user is told, and the panel does
    // not show a QR code for a listener that is not there.
    const second = makeService({}, port)
    const state = await second.service.start()
    expect(state.enabled).toBe(false)
    expect(state.error).toBeTruthy()
  })

  it('closes the listener when remote access is turned off', async () => {
    const { service } = makeService()
    const started = await service.start()
    const origin = started.origin
    if (origin === null) throw new Error('expected an origin')

    await service.stop()
    expect(service.state().enabled).toBe(false)
    await expect(call(origin, '/info', {})).rejects.toThrow()
  })

  it('announces every state change it makes', async () => {
    const { service, states } = makeService()
    await service.start()
    service.invite()
    expect(states.length).toBeGreaterThanOrEqual(2)
    expect(states[states.length - 1]?.invitation).not.toBeNull()
  })

  it('withdraws the approval prompt and the used code once a phone pairs', async () => {
    const key = deviceKey()
    const { service } = makeService()
    await service.start()
    await pair(service, key)

    // The prompt answered itself: leaving it up invites Approve clicks that
    // can only fail as conflicts, and the code must not be scanned twice.
    expect(service.state().pending).toBeNull()
    expect(service.state().invitation).toBeNull()
    expect(service.state().devices).toHaveLength(1)
  })

  it('keeps a phone that paired before a restart', async () => {
    const key = deviceKey()
    const first = makeService()
    await first.service.start()
    await pair(first.service, key)
    const deviceId = first.service.state().devices[0]?.deviceId
    await first.service.stop()

    // A restart: same records directory, a new process's worth of state.
    const second = new RemoteService(
      {
        engine: fakeEngine(),
        store: fakeStore(),
        dir: first.dir,
        driverKinds: () => ['claude'],
        defaultPermissionMode: () => 'ask',
        defaultDriverKind: () => 'claude',
        hasProject: async () => true,
        listProjects: async () => [{ id: 'proj_1', name: 'Ari' }],
        listModels: async () => [],
        mintSessionId: () => `sess_${++counter}`,
        clientOrigin: () => null,
        allowedOrigins: () => [ALLOWED],
      },
      { port: 0 },
    )
    live.push(second)

    expect(second.state().devices.map((device) => device.deviceId)).toEqual([deviceId])
    expect(second.state().devices[0]?.projectIds).toEqual(['proj_1'])
  })

  it('writes no token to disk', async () => {
    const key = deviceKey()
    const { service, dir } = makeService()
    await service.start()
    const token = await pair(service, key)

    const written = readdirSync(dir)
      .map((name) => readFileSync(join(dir, name), 'utf8'))
      .join('')
    // The durable credential is the device key the phone holds. A copy of the
    // desktop's directory must not be a working credential of its own.
    expect(written).not.toContain(token)
    expect(written).toContain('dev_')
  })

  it('survives a corrupt device file by forgetting, not by failing to start', async () => {
    const { service, dir } = makeService()
    await service.start()
    await service.stop()
    writeFileSync(join(dir, 'devices.json'), '{ not json', 'utf8')

    const state = await service.start()
    expect(state.enabled).toBe(true)
    expect(state.devices).toEqual([])
  })
})

describe('remote service pairing decisions', () => {
  it('holds an invitation single-use and lets the user deny one', async () => {
    const { service } = makeService()
    await service.start()
    const key = deviceKey()
    const invited = service.invite()
    const invitationId = invited.invitation?.invitationId
    const origin = invited.origin
    if (invitationId === undefined || origin === null) throw new Error('expected an invitation')

    const registered = await call(origin, '/pair/request', {
      invitationId,
      displayName: 'Pixel',
      publicKey: key.jwk,
    })
    const nonce = (registered.body['result'] as Record<string, unknown>)['nonce'] as string

    service.deny(invitationId)
    const redeemed = await call(origin, '/pair/redeem', {
      invitationId,
      nonce,
      signature: key.sign(nonce),
    })
    expect(redeemed.status).toBe(409)
    expect(service.state().devices).toEqual([])
  })

  it('shows the pending device and the code both screens display', async () => {
    const { service } = makeService()
    await service.start()
    const invited = service.invite()
    const invitationId = invited.invitation?.invitationId
    const origin = invited.origin
    if (invitationId === undefined || origin === null) throw new Error('expected an invitation')

    await call(origin, '/pair/request', {
      invitationId,
      displayName: 'Pixel 9',
      publicKey: deviceKey().jwk,
    })

    // The prompt appears because a device asked, not because a timer looked.
    const pending = service.state().pending
    expect(pending?.displayName).toBe('Pixel 9')
    expect(pending?.confirmationCode).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/)
  })

  it('grants only the projects the user picked, and revokes on request', async () => {
    const { service } = makeService()
    await service.start()
    const key = deviceKey()
    const token = await pair(service, key, ['proj_alpha'])

    const origin = service.state().origin
    if (origin === null) throw new Error('expected a running gateway')
    const listing = await call(
      origin,
      '/query',
      { op: 'session.list' },
      { authorization: `Bearer ${token}` },
    )
    expect(listing.status).toBe(200)

    const deviceId = service.state().devices[0]?.deviceId
    if (deviceId === undefined) throw new Error('expected a paired device')
    service.revokeDevice(deviceId)
    expect(service.state().devices).toEqual([])

    // The credential the phone holds stops working the moment the user says so.
    const afterRevoke = await call(
      origin,
      '/query',
      { op: 'session.list' },
      { authorization: `Bearer ${token}` },
    )
    expect(afterRevoke.status).toBe(401)
  })

  it('reports a revoked device as revoked when it comes back', async () => {
    const { service } = makeService()
    await service.start()
    const key = deviceKey()
    await pair(service, key)
    const deviceId = service.state().devices[0]?.deviceId
    if (deviceId === undefined) throw new Error('expected a paired device')
    service.revokeDevice(deviceId)

    const origin = service.state().origin
    if (origin === null) throw new Error('expected a running gateway')
    const challenge = await call(origin, '/device/challenge', { deviceId })
    const nonce = (challenge.body['result'] as Record<string, unknown>)['nonce'] as string
    const authorized = await call(origin, '/device/authorize', {
      deviceId,
      nonce,
      signature: key.sign(nonce),
    })
    // "Your access was withdrawn" is a different sentence on the phone from
    // "this desktop does not know you", and only one of them invites a re-pair.
    expect(authorized.status).toBe(403)
    expect((authorized.body['error'] as Record<string, unknown>)['code']).toBe('access_revoked')
  })

  it('does nothing when asked to invite while the gateway is off', () => {
    const { service } = makeService()
    // No listener means no address for the QR code to name, and handing out an
    // invitation that can never be redeemed would be a lie on screen.
    expect(service.invite().invitation).toBeNull()
  })
})

describe('remote service addressing', () => {
  it('offers no QR code until an address a phone can reach exists', async () => {
    const { service } = makeService()
    const state = await service.start()
    // Loopback is the phone's own loopback, so there is nothing to show yet.
    expect(state.clientUrl).toBeNull()
  })

  it('encodes the reachable address and keeps the invitation in the fragment', async () => {
    const { service } = makeService({ clientOrigin: () => 'https://ari.tailnet.ts.net' })
    await service.start()
    const state = service.invite()
    expect(state.clientUrl).toBe('https://ari.tailnet.ts.net')
    expect(state.invitation?.url).toMatch(/^https:\/\/ari\.tailnet\.ts\.net\/#pair=inv_/)
  })

  it('lets the allowed origins grow without restarting the listener', async () => {
    const origins: string[] = [ALLOWED]
    const { service } = makeService({ allowedOrigins: () => [...origins] })
    const state = await service.start()
    const origin = state.origin
    if (origin === null) throw new Error('expected a running gateway')
    const token = await pair(service, deviceKey())

    // Enabling Tailscale adds its origin to a gateway that is already serving;
    // restarting it would drop every phone's token mid-session.
    const before = await call(
      origin,
      '/info',
      {},
      { origin: 'https://ari.tailnet.ts.net', authorization: `Bearer ${token}` },
    )
    expect(before.status).toBe(403)
    origins.push('https://ari.tailnet.ts.net')
    const after = await call(
      origin,
      '/info',
      {},
      { origin: 'https://ari.tailnet.ts.net', authorization: `Bearer ${token}` },
    )
    expect(after.status).toBe(200)
  })
})

describe('remote service host wiring', () => {
  it('accepts OpenCode after hydration without restarting the running gateway', async () => {
    let kinds: DriverKind[] = ['ari-core']
    const engine = fakeEngine()
    const created = vi.spyOn(engine, 'createSession')
    const { service } = makeService({
      engine,
      driverKinds: () => kinds,
      listModels: async () => [
        { driverKind: 'opencode', models: [{ id: 'default', label: 'CLI default' }] },
      ],
    })
    const origin = (await service.start()).origin
    if (origin === null) throw new Error('Gateway did not start')
    const token = await pair(service, deviceKey())
    const create = {
      op: 'session.create',
      projectId: 'proj_1',
      driverKind: 'opencode',
      modelId: 'default',
      clientCommandId: 'c-1',
      idempotencyKey: 'before-hydration-key',
    }
    expect(
      (await call(origin, '/command', create, { authorization: `Bearer ${token}` })).status,
    ).toBe(400)
    kinds = ['ari-core', 'opencode']
    expect(
      (
        await call(
          origin,
          '/command',
          { ...create, idempotencyKey: 'after-hydration-key' },
          { authorization: `Bearer ${token}` },
        )
      ).status,
    ).toBe(200)
    expect(created).toHaveBeenCalledWith(
      expect.objectContaining({ driverKind: 'opencode', modelId: null }),
    )
    expect(service.state().origin).toBe(origin)
  })
  it('master disable closes both listeners while managed origins cannot use the Tailscale listener', async () => {
    const { service } = makeService()
    const local = (await service.start()).origin
    const port = await service.startManaged({
      port: 0,
      issuer: 'https://connect.example',
      hostname: 'computer.tunnel.example',
      computerId: 'computer',
      verifier: () => null,
    })
    if (local === null || port === null) throw new Error('Listeners did not start')
    const managed = `http://127.0.0.1:${port}`
    expect(
      (await fetch(`${managed}/info`, { headers: { origin: 'https://connect.example' } })).status,
    ).toBe(200)
    expect(
      (await fetch(`${local}/info`, { headers: { origin: 'https://connect.example' } })).status,
    ).toBe(403)
    expect(service.invite('connect').invitation?.url).toContain(
      'https://connect.example/?computer=computer#pair=',
    )
    await service.stop()
    await expect(fetch(`${local}/info`)).rejects.toThrow()
    await expect(fetch(`${managed}/info`)).rejects.toThrow()
    expect(service.running).toBe(false)
  })
  it('serves the built PWA from the gateway, same-origin with the API', async () => {
    const build = mkdtempSync(join(tmpdir(), 'ari-pwa-'))
    writeFileSync(join(build, 'index.html'), '<!doctype html><title>Ari Remote</title>', 'utf8')
    const { service } = makeService({ webRoot: () => build })
    const started = await service.start()
    const origin = started.origin
    if (origin === null) throw new Error('expected a running gateway')

    // A phone under Tailscale opens the tailnet address, which proxies to this
    // listener; the shell it gets is the app that then calls the API beside it.
    const page = await fetch(`${origin}/`)
    expect(page.status).toBe(200)
    expect(await page.text()).toContain('Ari Remote')
  })

  it('refuses a command for a session outside the device grant', async () => {
    const engine = fakeEngine()
    const dispatch = vi.spyOn(engine, 'dispatch')
    const { service } = makeService({ engine })
    await service.start()
    const token = await pair(service, deviceKey(), [])

    const origin = service.state().origin
    if (origin === null) throw new Error('expected a running gateway')
    const refused = await call(
      origin,
      '/command',
      {
        op: 'session.prompt',
        sessionId: 'sess_someone_elses',
        text: 'hello',
        clientCommandId: 'c-1',
        idempotencyKey: 'key-0123456789',
      },
      { authorization: `Bearer ${token}` },
    )

    // Empty grants reach nothing, and a session the device was not granted is
    // reported exactly as a session that does not exist.
    expect(refused.status).toBe(404)
    expect(dispatch).not.toHaveBeenCalled()
  })
})
