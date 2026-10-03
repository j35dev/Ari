import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { aesGcmSecretBox } from './secret-box'
import { RemoteConnectService } from './remote-connect'

const roots: string[] = []
const services: RemoteConnectService[] = []
afterEach(async () => {
  for (const service of services.splice(0)) await service.stop()
  vi.useRealTimers()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function harness() {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
  })
  const dir = await mkdtemp(join(tmpdir(), 'ari-connect-controller-'))
  roots.push(dir)
  const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const jwks = {
    keys: [
      { ...publicKey.export({ format: 'jwk' }), alg: 'ES256', use: 'sig', kid: 'ari-connect-v1' },
    ],
  }
  const calls: { url: string; method: string; body: unknown; authorization: string | null }[] = []
  const remote = {
    running: true,
    startManaged: vi.fn(async (options: { port: number }) => options.port),
    stopManaged: vi.fn(async () => undefined),
    pairedRecords: vi.fn(() => ({ devices: [], revoked: [] })),
  }
  const broker = {
    available: true,
    deleteFails: false,
    pending: false,
    computerState: 'ready',
    foreignApproval: false,
  }
  const callbacks: { onReady(): void; onExit(): void }[] = []
  const stop = vi.fn(async () => undefined)
  const openExternal = vi.fn(async () => undefined)
  const box = aesGcmSecretBox(randomBytes(32))
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const path = new URL(url).pathname
    calls.push({
      url,
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
      authorization: new Headers(init?.headers).get('authorization'),
    })
    if (!broker.available || (init?.method === 'DELETE' && broker.deleteFails))
      return new Response('{}', { status: 503 })
    let body: unknown = { ok: true }
    if (path === '/desktop/authorize/start')
      body = {
        transactionId: 'auth_12345678',
        pollToken: 'poll_1234567890123456',
        browserUrl: broker.foreignApproval
          ? 'https://evil.example/authorize/auth_12345678'
          : 'https://connect.example/authorize/auth_12345678',
        intervalSeconds: 5,
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
      }
    if (path === '/desktop/authorize/poll')
      body = broker.pending
        ? { status: 'pending' }
        : {
            status: 'approved',
            computer: {
              computerId: 'ari_comp_12345',
              name: 'Workstation',
              credential: 'ari_c_secret_0123456789',
            },
          }
    if (path === '/computers/ari_comp_12345')
      body = {
        computer: {
          computerId: 'ari_comp_12345',
          name: 'Workstation',
          hostname: 'computer.tunnel.example',
          state: broker.computerState,
          provision: { attempts: 1, lastError: null, nextAttemptAt: null },
        },
      }
    if (path === '/.well-known/jwks.json') body = jwks
    if (path === '/computers/ari_comp_12345/connector')
      body = {
        computerId: 'ari_comp_12345',
        hostname: 'computer.tunnel.example',
        token: 'cloudflare_secret_0123456789',
      }
    return new Response(JSON.stringify(body), { status: 200 })
  })
  const deps = {
    dir,
    version: '0.3.3',
    remote,
    secretBox: () => box,
    openExternal,
    fetch: fetcher as typeof fetch,
    probeConnector: vi.fn(async () => true),
    runConnector: vi.fn(async (_token: string, handlers: { onReady(): void; onExit(): void }) => {
      callbacks.push(handlers)
      return { stop }
    }),
  }
  const service = new RemoteConnectService(deps)
  services.push(service)
  async function approved() {
    await service.configure('https://connect.example')
    await service.signIn('Workstation')
    await vi.advanceTimersByTimeAsync(5000)
  }
  async function ready() {
    await approved()
    callbacks[0]?.onReady()
    await vi.advanceTimersByTimeAsync(0)
  }
  return { service, deps, broker, calls, callbacks, stop, approved, ready, dir, jwks, openExternal }
}

describe('desktop Ari Connect lifecycle', () => {
  it('deduplicates concurrent browser authorization and ignores a late response after disconnect', async () => {
    const h = await harness()
    await h.service.configure('https://connect.example')
    let release!: () => void
    const waiting = new Promise<void>((resolve) => {
      release = resolve
    })
    const original = h.deps.fetch
    h.deps.fetch = async (input, init) => {
      await waiting
      return original(input, init)
    }
    const first = h.service.signIn('Workstation')
    await vi.advanceTimersByTimeAsync(0)
    await h.service.signIn('Workstation')
    await h.service.signOut()
    release()
    await first
    expect(h.calls.filter((call) => call.url.endsWith('/desktop/authorize/start'))).toHaveLength(1)
    expect(h.openExternal).not.toHaveBeenCalled()
    expect(h.service.state().phase).toBe('signed-out')
  })

  it('bounds provisioning polls and leaves a clear retry state', async () => {
    const h = await harness()
    h.broker.computerState = 'provisioning'
    await h.approved()
    await vi.advanceTimersByTimeAsync(100_000)
    expect(h.service.state()).toMatchObject({ phase: 'error', clientUrl: null })
    expect(h.service.state().error).toContain('still provisioning')
    const count = h.calls.length
    await vi.advanceTimersByTimeAsync(100_000)
    expect(h.calls).toHaveLength(count)
    expect(h.deps.runConnector).not.toHaveBeenCalled()
  })
  it('authorizes in the browser, persists OS-boxed secrets, and waits for real connector readiness', async () => {
    const h = await harness()
    await h.approved()
    expect(h.openExternal).toHaveBeenCalledWith('https://connect.example/authorize/auth_12345678')
    expect(h.service.state()).toMatchObject({
      phase: 'connecting',
      clientUrl: null,
      computerId: 'ari_comp_12345',
    })
    expect(h.calls[0]?.body).toMatchObject({
      gatewayPort: 8788,
      protocolVersion: '1',
      publicKey: { kty: 'EC', crv: 'P-256' },
    })
    const stored = await readFile(join(h.dir, 'connect.json'), 'utf8')
    expect(stored).not.toContain('ari_c_secret_0123456789')
    expect(stored).not.toContain('PRIVATE KEY')
    h.callbacks[0]?.onReady()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.service.state()).toMatchObject({
      phase: 'ready',
      clientUrl: 'https://connect.example/?computer=ari_comp_12345',
    })
    expect(h.deps.remote.startManaged).toHaveBeenCalledWith(
      expect.objectContaining({
        port: 8788,
        issuer: 'https://connect.example',
        hostname: 'computer.tunnel.example',
      }),
    )
  })

  it('does not poll faster than the broker interval or open foreign approval URLs', async () => {
    const h = await harness()
    await h.service.configure('https://connect.example')
    await h.service.signIn('Workstation')
    await vi.advanceTimersByTimeAsync(4999)
    expect(h.calls.filter((call) => call.url.endsWith('/desktop/authorize/poll'))).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(h.calls.filter((call) => call.url.endsWith('/desktop/authorize/poll'))).toHaveLength(1)
    await h.service.signOut()
    h.broker.foreignApproval = true
    await h.service.signIn('Workstation')
    expect(h.service.state().phase).toBe('error')
    expect(h.openExternal).toHaveBeenCalledTimes(1)
  })

  it('fails closed when credential storage is unavailable and refuses insecure broker URLs', async () => {
    const h = await harness()
    const service = new RemoteConnectService({ ...h.deps, secretBox: () => null })
    services.push(service)
    for (const origin of [
      'http://connect.example',
      'https://u:p@connect.example',
      'https://connect.example/path',
      'https://connect.example?return=evil',
    ]) {
      expect((await service.configure(origin)).phase).toBe('error')
    }
    await service.configure('https://connect.example')
    expect((await service.signIn('Workstation')).error).toContain('OS-protected')
    expect(h.openExternal).not.toHaveBeenCalled()
  })

  it('resumes a missing connector after installation and cancels pending browser polling', async () => {
    const h = await harness()
    h.deps.probeConnector.mockResolvedValue(false)
    await h.approved()
    expect(h.service.state().phase).toBe('missing-cloudflared')
    h.deps.probeConnector.mockResolvedValue(true)
    await h.service.status()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.service.state().phase).toBe('connecting')
    await h.service.signOut()
    h.broker.pending = true
    await h.service.signIn('Workstation')
    await h.service.stop()
    const count = h.calls.length
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.calls).toHaveLength(count)
    expect(h.deps.remote.running).toBe(true)
  })

  it('stops the isolated listener and connector when membership heartbeat fails', async () => {
    const h = await harness()
    await h.ready()
    h.broker.available = false
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.service.state()).toMatchObject({ phase: 'error', clientUrl: null })
    expect(h.stop).toHaveBeenCalled()
    expect(h.deps.remote.stopManaged).toHaveBeenCalled()
    expect(h.deps.remote.running).toBe(true)
  })

  it('cannot resurrect an explicitly disconnected computer after failed cleanup or restart', async () => {
    const h = await harness()
    await h.ready()
    h.broker.deleteFails = true
    expect((await h.service.signOut()).error).toContain('stopped locally')
    const starts = h.deps.runConnector.mock.calls.length
    await h.service.status()
    await h.service.signIn('Workstation')
    await vi.advanceTimersByTimeAsync(0)
    const restored = new RemoteConnectService(h.deps)
    services.push(restored)
    await restored.status()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.deps.runConnector).toHaveBeenCalledTimes(starts)
    h.broker.deleteFails = false
    expect((await restored.signOut()).phase).toBe('signed-out')
  })

  it('pins broker signing keys and refuses silently changed keys on reconnect', async () => {
    const h = await harness()
    await h.ready()
    await h.service.stop()
    const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    h.jwks.keys[0] = {
      ...publicKey.export({ format: 'jwk' }),
      alg: 'ES256',
      use: 'sig',
      kid: 'ari-connect-v1',
    }
    await h.service.status()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.service.state().error).toContain('signing key changed')
    expect(h.deps.runConnector).toHaveBeenCalledTimes(1)
  })
})
