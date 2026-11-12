// @vitest-environment node
import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  GatewayClient,
  authorizeRoute,
  verifyRoute,
  type GatewayClientOptions,
  type PinnedRouteIdentity,
} from '@ari/remote-client'
import { createRemoteGateway, type RemoteGateway } from '@ari/remote-gateway/gateway'
import { createHostRouteSigner } from '@ari/remote-gateway/route-auth'
import { PairingService } from '@ari/remote-gateway/pairing'
import type { RemoteHost } from '@ari/remote-gateway/host'
import type { MachineRoute, MachineEventsFrame } from '@ari/contracts/machines'
import { journalEventSchema } from '@ari/contracts/events'
import { MachinesService } from './machines'
import { DesktopMachineCredential, MachinesRegistry } from './machines-registry'
import { MachineNetwork } from './machines-network'
import { loadHostSigningIdentity } from './host-signing-identity'
import { aesGcmSecretBox } from './secret-box'

const cleanups: (() => Promise<unknown> | unknown)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
function temporary(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ari-route-proof-'))
  cleanups.push(() => {
    if (!resolve(dir).startsWith(resolve(tmpdir()) + sep))
      throw new Error('Invalid fixture cleanup path.')
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })
  return dir
}
const host: RemoteHost = {
  capabilities: () => ['project.list', 'gateway.info'],
  listProjects: async () => [{ id: 'project', name: 'Host checkout', sessionCount: 0 }],
  listSessions: async () => [],
  getSession: async () => undefined,
  replay: async () => [],
  subscribe: () => () => undefined,
  query: async () => ({ projects: [{ id: 'project', name: 'Host checkout', sessionCount: 0 }] }),
  execute: async () => ({ ok: true, result: { accepted: true } }),
}
class ControlledNetwork extends MachineNetwork {
  readonly offline = new Set<string>()
  readonly responses = new Map<string, typeof fetch>()
  readonly calls: { origin: string; path: string; authorization: string | null; body: unknown }[] =
    []
  constructor() {
    super({ allowLoopback: true, timeoutMs: 500 })
  }
  override async clientOptions(route: MachineRoute): Promise<GatewayClientOptions> {
    const options = await super.clientOptions(route)
    return {
      ...options,
      fetch: async (input, init) => {
        const target = new URL(
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
        )
        this.calls.push({
          origin: target.origin,
          path: target.pathname,
          authorization: new Headers(init?.headers).get('authorization'),
          body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : null,
        })
        if (this.offline.has(target.origin)) throw new Error('Fixture route is offline.')
        const override = this.responses.get(target.origin)
        if (override !== undefined) return override(input, init)
        return options.fetch!(input, init)
      },
    }
  }
}
async function fixture(overrides: Partial<RemoteHost> = {}) {
  const box = aesGcmSecretBox(randomBytes(32))
  const signer = createHostRouteSigner(
    'host_stable',
    generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey,
  )
  const projects = ['project']
  const pairing = new PairingService({ projectIds: () => projects })
  const origins: string[] = []
  const start = async (): Promise<RemoteGateway> => {
    let audience: string | null = null
    const gateway = await createRemoteGateway({
      host: { ...host, ...overrides },
      pairing,
      port: 0,
      allowedOrigins: () => origins,
      identity: { machineId: signer.hostId, name: 'Host', ariVersion: '1' },
      routeAuthority: { signer, servedOrigins: () => origins, audience: () => audience },
    })
    audience = gateway.origin
    origins.push(gateway.origin)
    cleanups.push(() => gateway.close())
    return gateway
  }
  const a = await start()
  const b = await start()
  const network = new ControlledNetwork()
  let now = Date.now()
  const dir = temporary()
  const machines = new MachinesService({
    dir,
    secretBox: () => box,
    allowLoopback: true,
    network,
    decisionPollMs: 2,
    decisionTimeoutMs: 2000,
    now: () => now,
    moveBackCooldownMs: 60_000,
  })
  cleanups.push(() => machines.dispose())
  const invitation = pairing.begin(a.origin)
  const saved = await machines.add(`${a.origin}/#pair=${invitation.invitationId}`)
  await machines.pair({ machineId: saved.id, displayName: 'Client' })
  await vi.waitFor(() => expect(pairing.pending(invitation.invitationId)).toBeDefined())
  expect(
    pairing.approve(
      invitation.invitationId,
      pairing.pending(invitation.invitationId)!.confirmationCode,
      ['project'],
      true,
    ).ok,
  ).toBe(true)
  await vi.waitFor(() => expect(machines.list()[0]?.routes.length).toBe(2))
  const registry = new MachinesRegistry(join(dir, 'machines.json'))
  const credential = new DesktopMachineCredential(saved.id, registry, () => box)
  await credential.load()
  const record = registry.get(saved.id)
  const pin: PinnedRouteIdentity = { ...record.hostKey!, credentialOrigin: record.credentialOrigin }
  return {
    a,
    b,
    origins,
    start,
    machines,
    network,
    pairing,
    saved,
    dir,
    box,
    credential,
    pin,
    signer,
    projects,
    advance: () => {
      now += 60_001
    },
  }
}

describe('verified ordered Machines routes', () => {
  it('falls back across two real listeners, keeps the ID and moves back after cooldown', async () => {
    const f = await fixture()
    f.network.offline.add(f.a.origin)
    const fallback = await f.machines.connect(f.saved.id)
    expect(fallback).toMatchObject({
      id: f.saved.id,
      status: 'connected',
      effectiveRoute: f.b.origin,
      versionReady: true,
      permissionsReady: true,
      projectIds: ['project'],
    })
    expect(f.pairing.devices()).toHaveLength(1)
    const bAuth = f.network.calls.filter(
      (call) => call.origin === f.b.origin && call.authorization !== null,
    )
    expect(bAuth.length).toBeGreaterThan(0)
    const originalBearer = f.network.calls.find(
      (call) => call.origin === f.a.origin && call.path === '/routes/manifest',
    )!.authorization
    expect(bAuth.every((call) => call.authorization !== originalBearer)).toBe(true)
    expect(
      f.network.calls
        .filter((call) => call.origin === f.b.origin)
        .some((call) => call.path === '/device/authorize'),
    ).toBe(false)
    await expect(f.machines.query(f.saved.id, { op: 'project.list' })).resolves.toMatchObject({
      projects: [{ id: 'project' }],
    })
    f.network.offline.delete(f.a.origin)
    f.advance()
    await f.machines.precheck(f.saved.id)
    expect(f.machines.list()[0]?.effectiveRoute).toBe(f.a.origin)
  })

  it('keeps a later live route during cooldown, then authorizes an earlier route before replacing it', async () => {
    const f = await fixture()
    f.network.offline.add(f.a.origin)
    await f.machines.connect(f.saved.id)
    f.network.offline.delete(f.a.origin)
    await f.machines.precheck(f.saved.id)
    expect(f.machines.list()[0]?.effectiveRoute).toBe(f.b.origin)
    f.advance()
    await f.machines.precheck(f.saved.id)
    expect(f.machines.list()[0]).toMatchObject({
      id: f.saved.id,
      effectiveRoute: f.a.origin,
      status: 'connected',
    })
  })

  it('rejects a copied public host ID before sending any device proof, and continues fallback', async () => {
    const f = await fixture()
    const attackerSigner = createHostRouteSigner(
      f.pin.hostId,
      generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey,
    )
    const attacker = new GatewayClient({
      origin: f.a.origin,
      fetch: async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as { nonce: string }
        const payload = {
          kind: 'ari.route-proof.v1' as const,
          hostId: f.pin.hostId,
          audience: f.a.origin,
          nonce: body.nonce,
          issuedAt: Date.now(),
          expiresAt: Date.now() + 30_000,
          protocolVersion: 99,
        }
        return Response.json({
          ok: true,
          result: { payload, signature: attackerSigner.sign(payload) },
        })
      },
    })
    await expect(verifyRoute(attacker, f.pin)).rejects.toMatchObject({ code: 'invalid_signature' })
    f.network.offline.add(f.a.origin)
    expect((await f.machines.connect(f.saved.id)).effectiveRoute).toBe(f.b.origin)
  })

  it('mints a route-specific token that is refused on the other listener and consumes challenges', async () => {
    const f = await fixture()
    const b = new GatewayClient(
      await f.network.clientOptions({ kind: 'loopback', origin: f.b.origin }),
    )
    const authorization = await authorizeRoute(b, f.pin, f.credential, f.credential.deviceId!)
    expect(authorization.allProjects).toBe(true)
    b.token = authorization.token
    await expect(b.query('project.list')).resolves.toMatchObject({ projects: [{ id: 'project' }] })
    const a = new GatewayClient(
      await f.network.clientOptions({ kind: 'loopback', origin: f.a.origin }),
    )
    a.token = authorization.token
    await expect(a.query('project.list')).rejects.toMatchObject({ code: 'unauthenticated' })
    const lastProof = f.network.calls.findLast((call) => call.path === '/routes/authorize')!
      .body as { deviceId: string; nonce: string; signature: string }
    await expect(
      b.routeAuthorize(lastProof.deviceId, lastProof.nonce, lastProof.signature),
    ).rejects.toMatchObject({ code: 'invalid_signature' })
  })

  it('preserves all-project grants and refreshes their current IDs on a learned route', async () => {
    const f = await fixture()
    f.projects.push('new_project')
    f.network.offline.add(f.a.origin)
    expect(await f.machines.connect(f.saved.id)).toMatchObject({
      effectiveRoute: f.b.origin,
      allProjects: true,
      projectIds: ['project', 'new_project'],
      permissionsReady: true,
    })
  })

  it.each(['nonce', 'audience', 'expired'] as const)(
    'rejects a correctly signed %s mismatch before sending device identity or proof',
    async (failure) => {
      const f = await fixture()
      const calls: unknown[] = []
      const request: typeof fetch = async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as { nonce: string; audience: string }
        calls.push(body)
        const payload = {
          kind: 'ari.route-proof.v1' as const,
          hostId: f.pin.hostId,
          audience: failure === 'audience' ? f.a.origin : f.b.origin,
          nonce:
            failure === 'nonce' ? 'different-nonce-that-is-at-least-32-characters' : body.nonce,
          issuedAt: failure === 'expired' ? Date.now() - 40_000 : Date.now(),
          expiresAt: failure === 'expired' ? Date.now() - 10_000 : Date.now() + 30_000,
          protocolVersion: 1,
        }
        return Response.json({ ok: true, result: { payload, signature: f.signer.sign(payload) } })
      }
      const sign = vi.spyOn(f.credential, 'sign')
      await expect(
        authorizeRoute(
          new GatewayClient({ origin: f.b.origin, fetch: request }),
          f.pin,
          f.credential,
          f.credential.deviceId!,
        ),
      ).rejects.toMatchObject({ code: 'invalid_signature' })
      expect(sign).not.toHaveBeenCalled()
      expect(calls).toHaveLength(1)
      expect(calls[0]).not.toHaveProperty('deviceId')
      expect(calls[0]).not.toHaveProperty('signature')
    },
  )

  it('continues the route walk after an attacker copies the ID and claims an incompatible version', async () => {
    const f = await fixture()
    const attacker = createHostRouteSigner(
      f.pin.hostId,
      generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey,
    )
    f.network.responses.set(f.a.origin, async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { nonce: string }
      const payload = {
        kind: 'ari.route-proof.v1' as const,
        hostId: f.pin.hostId,
        audience: f.a.origin,
        nonce: body.nonce,
        issuedAt: Date.now(),
        expiresAt: Date.now() + 30_000,
        protocolVersion: 99,
      }
      return Response.json({ ok: true, result: { payload, signature: attacker.sign(payload) } })
    })
    f.network.calls.length = 0
    expect((await f.machines.connect(f.saved.id)).effectiveRoute).toBe(f.b.origin)
    expect(
      f.network.calls
        .filter((call) => call.origin === f.a.origin)
        .every((call) => call.path === '/routes/proof' && call.authorization === null),
    ).toBe(true)
  })

  it('keeps anonymous descriptor/proof content minimal and requires authentication for the manifest', async () => {
    const f = await fixture()
    const a = new GatewayClient(
      await f.network.clientOptions({ kind: 'loopback', origin: f.a.origin }),
    )
    const info = await a.info()
    expect(info).not.toHaveProperty('routes')
    expect(info).not.toHaveProperty('resources')
    expect(info).not.toHaveProperty('projects')
    const proof = await a.routeProof(crypto.randomUUID() + crypto.randomUUID())
    expect(Object.keys(proof.payload).sort()).toEqual([
      'audience',
      'expiresAt',
      'hostId',
      'issuedAt',
      'kind',
      'nonce',
      'protocolVersion',
    ])
    await expect(a.routeManifest()).rejects.toMatchObject({ code: 'unauthenticated' })
    const response = await (
      await f.network.clientOptions({ kind: 'loopback', origin: f.a.origin })
    ).fetch!(`${f.a.origin}/routes/manifest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    expect(response.status).toBe(401)
  })

  it('forwards desktop frames in one immutable scope and resumes the stream when moving back', async () => {
    const event = journalEventSchema.parse({
      seq: 0,
      at: 1,
      sessionId: 'session_scope',
      type: 'session.updated',
      title: 'Host session',
    })
    const f = await fixture({
      capabilities: () => ['project.list', 'gateway.info', 'events.desktop.subscribe'],
      desktopReplayState: async () => ({ projectId: 'project', seq: 0, liveTurnId: null }),
      replayRange: async (_caller, _sessionId, options, onChunk) => {
        if (options.afterSeq === undefined) await onChunk([event])
        return { outcome: 'complete', seq: 0, reason: null }
      },
    })
    f.network.offline.add(f.a.origin)
    await f.machines.connect(f.saved.id)
    const frames: MachineEventsFrame[] = []
    await f.machines.subscribe(
      'desktop_stream',
      { machineId: f.saved.id, sessionId: 'session_scope', desktop: true },
      (frame) => frames.push(frame),
    )
    await vi.waitFor(() =>
      expect(
        frames.some(
          (frame) =>
            frame.message.type === 'events.desktop.frame' &&
            frame.message.frame.kind === 'terminal',
        ),
      ).toBe(true),
    )
    f.network.offline.delete(f.a.origin)
    f.advance()
    await f.machines.precheck(f.saved.id)
    await vi.waitFor(() =>
      expect(
        frames.filter(
          (frame) =>
            frame.message.type === 'events.desktop.frame' &&
            frame.message.frame.kind === 'terminal',
        ),
      ).toHaveLength(2),
    )
    expect(
      frames.every(
        (frame) =>
          frame.machineId === f.saved.id &&
          frame.message.type === 'events.desktop.frame' &&
          frame.message.sessionId === 'session_scope',
      ),
    ).toBe(true)
    const starts = frames.flatMap((frame) =>
      frame.message.type === 'events.desktop.frame' && frame.message.frame.kind === 'start'
        ? [frame.message.frame]
        : [],
    )
    expect(starts).toMatchObject([
      { replayMode: 'full', fromSeq: null },
      { replayMode: 'resume', fromSeq: 0 },
    ])
    f.machines.unsubscribe('desktop_stream')
  })

  it('learns only signed reported routes, preserves manual routes and enforces complete reorder', async () => {
    const f = await fixture()
    expect(f.machines.list()[0]?.routes[1]?.source).toBe('learned')
    expect(() => f.machines.removeRoute(f.saved.id, f.b.origin)).toThrow(/Learned routes/)
    expect(() => f.machines.reorderRoutes(f.saved.id, [f.b.origin])).toThrow(/every saved route/)
    f.machines.reorderRoutes(f.saved.id, [f.b.origin, f.a.origin])
    expect(f.machines.list()[0]?.routes[0]?.origin).toBe(f.b.origin)
    f.origins.splice(f.origins.indexOf(f.b.origin), 1)
    f.network.offline.add(f.b.origin)
    expect((await f.machines.connect(f.saved.id)).routes).toEqual([
      { kind: 'loopback', origin: f.a.origin, source: 'manual' },
    ])
  })

  it('refuses unknown-address pairing links for pinned machines and permits a proved manual route', async () => {
    const f = await fixture()
    const c = await f.start()
    const invitation = f.pairing.begin(c.origin)
    await expect(f.machines.add(`${c.origin}/#pair=${invitation.invitationId}`)).rejects.toThrow(
      /Add route/,
    )
    const added = await f.machines.addRoute(f.saved.id, c.origin)
    expect(added.routes.find((route) => route.origin === c.origin)).toMatchObject({
      source: 'manual',
      credentialOrigin: f.a.origin,
    })
    f.machines.removeRoute(f.saved.id, c.origin)
    expect(f.machines.list()[0]?.routes).toHaveLength(2)
  })
})

describe('client-local preferences and signing identity', () => {
  it('migrates v1 IDs and the original origin, persists all four tiers including This PC, and cleans removals', () => {
    const dir = temporary()
    const path = join(dir, 'machines.json')
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        machines: [
          {
            id: 'saved',
            name: 'Host',
            routes: [{ kind: 'loopback', origin: 'http://127.0.0.1:8123' }],
            identity: null,
            lastSeenAt: null,
            credentialCipher: null,
          },
        ],
      }),
    )
    const registry = new MachinesRegistry(path)
    expect(registry.get('saved')).toMatchObject({
      id: 'saved',
      credentialOrigin: 'http://127.0.0.1:8123',
      hostKey: null,
    })
    expect(registry.preferences().autoEnabled).toBe(false)
    registry.setAuto(true)
    for (const tier of ['prefer', 'normal', 'less-often', 'manual-only'] as const) {
      registry.setPreference('local', tier)
      expect(new MachinesRegistry(path).preferences().hostTiers['local']).toBe(tier)
    }
    registry.setPreference('saved', 'prefer')
    registry.rememberProjectHost('git/repository', 'saved')
    registry.remove('saved')
    expect(new MachinesRegistry(path).preferences()).toEqual({
      autoEnabled: true,
      hostTiers: { local: 'manual-only' },
      projectHosts: {},
    })
  })

  it('retains one sealed host key and fails closed on corruption or missing keyring', () => {
    const dir = temporary()
    const box = aesGcmSecretBox(randomBytes(32))
    const first = loadHostSigningIdentity(dir, 'host', () => box)
    expect(loadHostSigningIdentity(dir, 'host', () => box).publicKey).toEqual(first.publicKey)
    const path = join(dir, 'host-signing.json')
    expect(readFileSync(path, 'utf8')).not.toContain('PRIVATE KEY')
    expect(() => loadHostSigningIdentity(dir, 'other', () => box)).toThrow(/another host/)
    expect(() => loadHostSigningIdentity(dir, 'host', () => null)).toThrow(/unavailable/)
    unlinkSync(path)
    expect(() => loadHostSigningIdentity(dir, 'host', () => box)).toThrow(/missing/)
    writeFileSync(path, readFileSync(join(dir, 'host-signing-anchor.json'), 'utf8'))
    writeFileSync(path, '{corrupt')
    expect(() => loadHostSigningIdentity(dir, 'host', () => box)).toThrow()
    expect(readFileSync(path, 'utf8')).toBe('{corrupt')
  })
})
