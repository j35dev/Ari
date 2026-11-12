// @vitest-environment node
import { execFileSync } from 'node:child_process'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Session } from '@ari/contracts/session'
import type { JournalEvent } from '@ari/contracts/events'
import type { Project } from '@ari/contracts/project'
import {
  remoteDesktopFrameSchema,
  remoteOperationSchema,
  remoteProjectCatalogSchema,
  remoteHostResourcesSchema,
} from '@ari/contracts/remote'
import { SessionStore } from '@ari/engine/session-store'
import { Journal } from '@ari/engine/journal'
import { DriverRegistry } from '@ari/providers/registry'
import { PairingService } from '@ari/remote-gateway/pairing'
import { createRemoteGateway, type RemoteGateway } from '@ari/remote-gateway/gateway'
import { ConnectLeaseVerifier } from '../../../../packages/remote-gateway/src/connect-lease'
import { deviceKey } from '../../../../packages/remote-gateway/src/testing/device-key'
import { RawWebSocket } from '../../../../packages/remote-gateway/src/testing/ws-client'
import { Engine } from './engine'
import { createRemoteHost, type RemoteHostDeps } from './remote-host'
import { normalizeRepositoryRemote, repositoryIdentityFromRemotes } from './remote-host-metadata'
import { remotePathIsSafe } from './remote-files'

let root: string
let store: SessionStore
let engine: Engine
const gateways: RemoteGateway[] = []
const extraEngines: Engine[] = []
const extraStores: SessionStore[] = []
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ari-desktop-wire-'))
  store = new SessionStore({ rootDir: join(root, 'sessions') })
  engine = new Engine({
    store,
    registry: new DriverRegistry(),
    publish: () => undefined,
    resolveWorkspace: async () => root,
    git: { captureCheckpoint: async () => ({ ok: true, value: null }) },
  })
})
afterEach(async () => {
  vi.restoreAllMocks()
  for (const gateway of gateways.splice(0)) await gateway.close()
  await engine.shutdown()
  for (const extra of extraEngines.splice(0)) await extra.shutdown()
  for (const extra of extraStores.splice(0))
    for (const session of await extra.listSessions()) await extra.closeJournal(session.id)
  for (const session of await store.listSessions()) await store.closeJournal(session.id)
  await rm(root, { recursive: true, force: true, maxRetries: 6, retryDelay: 50 })
})
const fixture = (id = 's'): Session => ({
  id,
  projectId: 'p',
  title: id,
  driverKind: 'codex',
  modelId: 'fixture',
  permissionMode: 'full',
  status: 'idle',
  createdAt: 1,
  updatedAt: 1,
})
const resources = {
  status: 'available' as const,
  sampledAt: 1,
  cpuUtilization: 0.25,
  cpuCount: 4,
  availableMemoryBytes: 4 * 1024 ** 3,
  totalMemoryBytes: 8 * 1024 ** 3,
  reason: null,
}
const version = {
  ariVersion: 'fixture',
  protocolVersion: 1,
  hostingMode: 'desktop' as const,
  update: {
    supported: false as const,
    reason: 'Manual only.',
    availableVersion: null,
    stagedVersion: null,
    guidance: 'Update Ari on this machine.',
  },
}
function makeHost(overrides: Partial<RemoteHostDeps> = {}) {
  return createRemoteHost({
    engine,
    store,
    driverKinds: ['codex'],
    defaultPermissionMode: () => 'full',
    defaultDriverKind: () => 'codex',
    hasProject: async (id) => id === 'p',
    listProjects: async () => [{ id: 'p', name: 'Project' }],
    listModels: async () => [
      {
        driverKind: 'codex',
        available: true,
        defaultModelId: 'fixture',
        models: [{ id: 'fixture', label: 'Fixture' }],
        efforts: [{ id: 'high', label: 'High' }],
      },
    ],
    pairing: new PairingService(),
    mintSessionId: () => 'new',
    ...overrides,
  })
}
async function start(
  host = makeHost(),
  options: Partial<Parameters<typeof createRemoteGateway>[0]> = {},
) {
  const gateway = await createRemoteGateway({
    host,
    port: 0,
    allowedOrigins: ['http://127.0.0.1:5173'],
    ...options,
  })
  gateways.push(gateway)
  return gateway
}
async function call(
  gateway: RemoteGateway,
  path: string,
  body: unknown,
  token?: string,
  lease?: string,
) {
  const response = await fetch(gateway.origin + path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'http://127.0.0.1:5173',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(lease ? { 'x-ari-connect-lease': lease } : {}),
    },
    body: JSON.stringify(body),
  })
  return {
    status: response.status,
    body: (await response.json()) as { ok: boolean; result?: unknown; error?: { code: string } },
  }
}
async function pair(gateway: RemoteGateway, projects = ['p']) {
  const key = deviceKey()
  const invitation = gateway.pairing.begin(gateway.origin)
  const requested = await call(gateway, '/pair/request', {
    invitationId: invitation.invitationId,
    displayName: 'Fixture',
    publicKey: key.jwk,
  })
  const nonce = (requested.body.result as { nonce: string }).nonce
  gateway.pairing.approve(
    invitation.invitationId,
    gateway.pairing.pending(invitation.invitationId)!.confirmationCode,
    projects,
  )
  const redeemed = await call(gateway, '/pair/redeem', {
    invitationId: invitation.invitationId,
    nonce,
    signature: key.sign(nonce),
  })
  return (redeemed.body.result as { token: string }).token
}
async function stream(gateway: RemoteGateway, token: string, fromSeq?: number, lease?: string) {
  const socket = await RawWebSocket.open(gateway.port, '/events', {
    origin: 'http://127.0.0.1:5173',
    protocols: ['ari-remote.v1', `bearer.${token}`, ...(lease ? [`lease.${lease}`] : [])],
  })
  socket.send(
    JSON.stringify({
      type: 'events.desktop.subscribe',
      sessionId: 's',
      ...(fromSeq === undefined ? {} : { fromSeq }),
    }),
  )
  const frames = []
  for (;;) {
    const message = remoteDesktopFrameSchema.parse(JSON.parse(await socket.nextMessage()))
    frames.push(message.frame)
    if (message.frame.kind === 'terminal') break
  }
  return { socket, frames }
}
const project = (path: string, id = 'p'): Project => ({
  id,
  name: 'Project',
  path,
  status: 'ok',
  defaultAgent: null,
  colorIndex: 0,
  createdAt: 1,
  lastOpenedAt: 0,
  open: true,
})
function desktop(projects: Project[] = [project(root)]): NonNullable<RemoteHostDeps['desktop']> {
  return {
    projects: async () => projects,
    resources: () => resources,
    version: () => version,
    createSession: async () => ({ sessionId: 'unused' }),
    stopChildren: async () => ({ stopped: 0 }),
    resume: {
      get: async () => ({ at: null }),
      schedule: async (_id, at) => ({ at }),
      cancel: async () => ({ cancelled: false }),
    },
    scm: {
      summary: async () => ({ ok: false, error: { code: 'unsupported', message: 'Fixture' } }),
      status: async () => ({ ok: false, error: { code: 'unsupported', message: 'Fixture' } }),
      review: async () => ({ ok: false, error: { code: 'unsupported', message: 'Fixture' } }),
      diff: async () => ({ ok: false, error: { code: 'unsupported', message: 'Fixture' } }),
    },
  }
}
async function managed(host = makeHost()) {
  let now = 100_000
  const keys = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const jwk = keys.publicKey.export({ format: 'jwk' }) as {
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
  const gateway = await start(host, { managedAccess: { verifier: () => verifier }, now: () => now })
  const token = await pair(gateway)
  const device = gateway.pairing.toPersisted().devices[0]!
  const key = device.publicKey
  const fingerprint = createHash('sha256')
    .update(JSON.stringify({ crv: key.crv, kty: key.kty, x: key.x, y: key.y }))
    .digest('hex')
  const header = Buffer.from(JSON.stringify({ alg: 'ES256', kid: 'trusted' })).toString('base64url')
  const payload = Buffer.from(
    JSON.stringify({
      iss: 'https://connect.example',
      aud: 'ari-gateway:comp_12345678',
      sub: 'member',
      computerId: 'comp_12345678',
      deviceId: device.deviceId,
      deviceKeyFingerprint: fingerprint,
      projectIds: ['p'],
      iat: 100,
      exp: 160,
      jti: 'fixture',
    }),
  ).toString('base64url')
  const lease = `${header}.${payload}.${sign('sha256', Buffer.from(`${header}.${payload}`), {
    key: keys.privateKey,
    dsaEncoding: 'ieee-p1363',
  }).toString('base64url')}`
  return {
    gateway,
    token,
    lease,
    expire: () => {
      now = 161_000
    },
  }
}
async function journal(events: JournalEvent[]) {
  const dir = join(root, 'sessions', 's')
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'journal.0000.jsonl'),
    events.map((event) => JSON.stringify(event)).join('\n') + '\n',
  )
}

describe('desktop host wire', () => {
  it('retains the legacy enum and authenticates catalog/resources with effective project scope', async () => {
    const repo = join(root, 'repository')
    await mkdir(repo)
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, windowsHide: true })
    git('init', '-q')
    git(
      'remote',
      'add',
      'origin',
      'https://username:private-token@github.com/Me/App.git?secret=yes',
    )
    git('remote', 'add', 'upstream', 'git@github.com:Acme/App.git')
    const desktop = {
      projects: async () => [
        {
          id: 'p',
          name: 'Project',
          path: repo,
          status: 'ok' as const,
          defaultAgent: null,
          colorIndex: 0,
          createdAt: 1,
          lastOpenedAt: 0,
          open: true,
        },
        {
          id: 'private',
          name: 'Secret project',
          path: repo,
          status: 'ok' as const,
          defaultAgent: null,
          colorIndex: 0,
          createdAt: 1,
          lastOpenedAt: 0,
          open: true,
        },
      ],
      resources: () => resources,
      version: () => version,
      createSession: async () => ({ sessionId: 'unused' }),
      stopChildren: async () => ({ stopped: 0 }),
      resume: {
        get: async () => ({ at: null }),
        schedule: async (_id: string, at: number) => ({ at }),
        cancel: async () => ({ cancelled: false }),
      },
      scm: {
        summary: async () => ({
          ok: false as const,
          error: { code: 'unsupported' as const, message: 'Fixture' },
        }),
        status: async () => ({
          ok: false as const,
          error: { code: 'unsupported' as const, message: 'Fixture' },
        }),
        review: async () => ({
          ok: false as const,
          error: { code: 'unsupported' as const, message: 'Fixture' },
        }),
        diff: async () => ({
          ok: false as const,
          error: { code: 'unsupported' as const, message: 'Fixture' },
        }),
      },
    }
    const { gateway, token, lease } = await managed(makeHost({ desktop }))
    const info = (await call(gateway, '/info', {})).body.result as {
      capabilities: string[]
      machinesExtensions: { version: number; operations: string[] }
    }
    expect(info.capabilities.every((op) => remoteOperationSchema.safeParse(op).success)).toBe(true)
    expect(info.capabilities).not.toContain('project.catalog')
    expect(info.machinesExtensions.operations).toContain('project.catalog')
    expect((await call(gateway, '/query', { op: 'project.catalog' })).status).toBe(401)
    expect((await call(gateway, '/query', { op: 'host.resources' })).status).toBe(401)
    expect((await call(gateway, '/query', { op: 'project.catalog' }, token)).status).toBe(403)
    const catalog = remoteProjectCatalogSchema.parse(
      (await call(gateway, '/query', { op: 'project.catalog' }, token, lease)).body.result,
    )
    expect(catalog.projects).toHaveLength(1)
    expect(catalog.projects[0]!.repositoryIdentity).toMatchObject({
      canonicalKey: 'github.com/acme/app',
      origin: { canonicalKey: 'github.com/me/app' },
    })
    expect(JSON.stringify(catalog)).not.toContain('private-token')
    expect(JSON.stringify(catalog)).not.toContain(repo)
    expect(
      remoteHostResourcesSchema.parse(
        (await call(gateway, '/query', { op: 'host.resources' }, token, lease)).body.result,
      ),
    ).toEqual(resources)
    const permission = (await call(gateway, '/query', { op: 'host.permissions' }, token, lease))
      .body.result
    expect(permission).toMatchObject({
      projectScope: { kind: 'ids', projectIds: ['p'] },
      allowTerminal: false,
      managedLeaseExpiresAt: 160_000,
    })
    expect(
      (
        await call(
          gateway,
          '/query',
          { op: 'project.workspaces', projectId: 'private' },
          token,
          lease,
        )
      ).status,
    ).toBe(404)
  })

  it('streams every seq including zero and more than 2,000 events without readAll', async () => {
    const events: JournalEvent[] = [
      { type: 'session.created', session: fixture(), sessionId: 's', seq: 0, at: 1 },
    ]
    for (let seq = 1; seq <= 2405; seq++)
      events.push({
        type: 'session.updated',
        title: `Title ${seq}`,
        sessionId: 's',
        seq,
        at: seq + 1,
      })
    await journal(events)
    const forbidden = vi.spyOn(Journal.prototype, 'readAll').mockImplementation(async () => {
      throw new Error('whole-journal materialization')
    })
    const gateway = await start()
    const token = await pair(gateway)
    const { socket, frames } = await stream(gateway, token)
    socket.close()
    const received = frames.flatMap((frame) => (frame.kind === 'chunk' ? frame.events : []))
    expect(received.map((event) => event.seq)).toEqual(events.map((event) => event.seq))
    expect(frames[0]).toEqual({
      kind: 'start',
      replayMode: 'full',
      fromSeq: null,
      throughSeq: 2405,
    })
    expect(frames.at(-1)).toEqual({
      kind: 'terminal',
      replayOutcome: 'complete',
      seq: 2405,
      liveTurnId: null,
      reason: null,
    })
    expect(forbidden).not.toHaveBeenCalled()
  })

  it('terminates zero-new-event resumes and marks corrupt/gapped history incomplete', async () => {
    await journal([{ type: 'session.created', session: fixture(), sessionId: 's', seq: 0, at: 1 }])
    const gateway = await start()
    const token = await pair(gateway)
    const resumed = await stream(gateway, token, 0)
    resumed.socket.close()
    expect(resumed.frames.map((frame) => frame.kind)).toEqual(['start', 'terminal'])
    expect(resumed.frames.at(-1)).toMatchObject({
      replayOutcome: 'complete',
      seq: 0,
      liveTurnId: null,
    })
    const gap = await engine.replaySessionRangeChunks('s', { throughSeq: 2 }, async () => undefined)
    expect(gap).toMatchObject({ outcome: 'incomplete', seq: 0 })
    await store.closeJournal('s')
    await writeFile(
      join(root, 'sessions', 's', 'journal.0000.jsonl'),
      JSON.stringify({
        type: 'session.created',
        session: fixture(),
        sessionId: 's',
        seq: 0,
        at: 1,
      }) +
        '\ninvalid\n' +
        JSON.stringify({ type: 'session.updated', title: 'Gap', sessionId: 's', seq: 2, at: 3 }) +
        '\n',
    )
    const corrupted = await stream(gateway, token)
    corrupted.socket.close()
    expect(corrupted.frames.at(-1)).toMatchObject({ replayOutcome: 'incomplete', liveTurnId: null })
  })

  it('awaits consumer backpressure and cancels a range without sending later chunks', async () => {
    const events: JournalEvent[] = [
      { type: 'session.created', session: fixture(), sessionId: 's', seq: 0, at: 1 },
    ]
    for (let seq = 1; seq < 300; seq++)
      events.push({ type: 'session.updated', title: 'T', sessionId: 's', seq, at: seq + 1 })
    await journal(events)
    const controller = new AbortController()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const calls = vi.fn(async () => gate)
    const reading = engine.replaySessionRangeChunks(
      's',
      { throughSeq: 299, signal: controller.signal },
      calls,
    )
    await vi.waitFor(() => expect(calls).toHaveBeenCalledTimes(1))
    controller.abort()
    release()
    expect(await reading).toMatchObject({ outcome: 'incomplete', reason: 'replay cancelled' })
    expect(calls).toHaveBeenCalledTimes(1)
  })

  it('refuses secret and symlink paths for snapshot projections', async () => {
    await writeFile(join(root, '.env'), 'PRIVATE=1')
    await writeFile(join(root, 'safe.txt'), 'safe')
    expect(await remotePathIsSafe(root, '.env')).toBe(false)
    expect(await remotePathIsSafe(root, 'safe.txt')).toBe(true)
    const outside = join(root, 'outside')
    await mkdir(outside)
    try {
      await symlink(outside, join(root, 'link'), 'junction')
      expect(await remotePathIsSafe(root, 'link/safe.txt')).toBe(false)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error
    }
  })

  it('keeps two real engines and gateways one-way and preserves session ownership after restart', async () => {
    await engine.createSession({ ...fixture(), title: 'Host A' })
    const otherStore = new SessionStore({ rootDir: join(root, 'other-sessions') })
    const otherEngine = new Engine({
      store: otherStore,
      registry: new DriverRegistry(),
      publish: () => undefined,
      resolveWorkspace: async () => root,
      git: { captureCheckpoint: async () => ({ ok: true, value: null }) },
    })
    extraStores.push(otherStore)
    extraEngines.push(otherEngine)
    await otherEngine.createSession({ ...fixture(), title: 'Host B' })
    const first = await start(makeHost({ desktop: desktop() }), {
      identity: { machineId: 'host-a', name: 'A', ariVersion: '1' },
    })
    const second = await start(
      makeHost({ engine: otherEngine, store: otherStore, desktop: desktop() }),
      { identity: { machineId: 'host-b', name: 'B', ariVersion: '2' } },
    )
    const firstToken = await pair(first)
    expect(second.pairing.devices()).toEqual([])
    expect(
      (await call(second, '/query', { op: 'session.desktop.get', sessionId: 's' }, firstToken))
        .status,
    ).toBe(401)
    const secondToken = await pair(second)
    const command = {
      op: 'session.update',
      sessionId: 's',
      title: 'Only on A',
      clientCommandId: 'owner-update',
      idempotencyKey: 'owner-original-update',
    }
    expect((await call(first, '/command', command, firstToken)).status).toBe(200)
    expect((await store.load('s')).session?.title).toBe('Only on A')
    expect((await otherStore.load('s')).session?.title).toBe('Host B')
    const a = await stream(first, firstToken)
    a.socket.close()
    const b = await stream(second, secondToken)
    b.socket.close()
    expect(
      a.frames.flatMap((frame) => (frame.kind === 'chunk' ? frame.events : [])).at(-1),
    ).toMatchObject({ type: 'session.updated', title: 'Only on A' })
    expect(b.frames.flatMap((frame) => (frame.kind === 'chunk' ? frame.events : []))).toHaveLength(
      1,
    )
    await first.close()
    gateways.splice(gateways.indexOf(first), 1)
    await engine.shutdown()
    for (const row of await store.listSessions()) await store.closeJournal(row.id)
    store = new SessionStore({ rootDir: join(root, 'sessions') })
    engine = new Engine({
      store,
      registry: new DriverRegistry(),
      publish: () => undefined,
      resolveWorkspace: async () => root,
      git: { captureCheckpoint: async () => ({ ok: true, value: null }) },
    })
    const restarted = await start(makeHost({ desktop: desktop() }), {
      identity: { machineId: 'host-a', name: 'A', ariVersion: '3' },
      pairing: first.pairing,
    })
    const resumed = await stream(restarted, firstToken, 0)
    resumed.socket.close()
    expect(resumed.frames[0]).toMatchObject({ replayMode: 'resume', throughSeq: 1 })
    expect(resumed.frames.at(-1)).toMatchObject({
      replayOutcome: 'complete',
      seq: 1,
      liveTurnId: null,
    })
    expect(
      (await call(restarted, '/query', { op: 'session.desktop.get', sessionId: 's' }, firstToken))
        .body.result,
    ).toMatchObject({ session: { title: 'Only on A' } })
    const deviceId = restarted.pairing.toPersisted().devices[0]!.deviceId
    restarted.pairing.revoke(deviceId)
    expect((await call(restarted, '/query', { op: 'host.resources' }, firstToken)).status).toBe(401)
    expect(
      (await call(second, '/query', { op: 'session.desktop.get', sessionId: 's' }, secondToken))
        .status,
    ).toBe(200)
  })

  it('buffers appends during replay, then sends one ordered live event with actual runtime metadata', async () => {
    await engine.createSession(fixture())
    const original = engine.replaySessionRangeChunks.bind(engine)
    vi.spyOn(engine, 'replaySessionRangeChunks').mockImplementation(
      async (id, options, onChunk) => {
        const result = await original(id, options, onChunk)
        await engine.dispatch({ type: 'session.update', sessionId: id, title: 'During replay' })
        return result
      },
    )
    vi.spyOn(engine, 'liveTurnId').mockReturnValue('actual-running-turn')
    const gateway = await start()
    const token = await pair(gateway)
    const { socket, frames } = await stream(gateway, token)
    expect(frames.at(-1)).toMatchObject({
      replayOutcome: 'complete',
      seq: 0,
      liveTurnId: 'actual-running-turn',
    })
    const live = remoteDesktopFrameSchema.parse(JSON.parse(await socket.nextMessage()))
    expect(live.frame).toMatchObject({ kind: 'live', event: { seq: 1, title: 'During replay' } })
    socket.close()
  })

  it('sends an explicit empty terminal and bounds live overflow as incomplete', async () => {
    vi.spyOn(store, 'readReplayState').mockResolvedValue({
      session: fixture(),
      seq: -1,
      liveTurnId: null,
      incomplete: false,
    })
    const empty = await start()
    const emptyToken = await pair(empty)
    const initial = await stream(empty, emptyToken)
    initial.socket.close()
    expect(initial.frames).toEqual([
      { kind: 'start', replayMode: 'full', fromSeq: null, throughSeq: -1 },
      { kind: 'terminal', replayOutcome: 'complete', seq: -1, liveTurnId: null, reason: null },
    ])
    vi.restoreAllMocks()
    await engine.createSession(fixture())
    const host = makeHost()
    const original = host.replayRange!
    let appended: ((event: JournalEvent) => void) | undefined
    const subscribe = host.subscribe
    host.subscribe = (caller, id, listener) => {
      appended = listener
      return subscribe(caller, id, listener)
    }
    host.replayRange = async (...args) => {
      const result = await original(...args)
      for (let seq = 1; seq <= 2001; seq++)
        appended!({ type: 'session.updated', title: 'Backlog', sessionId: 's', seq, at: seq })
      return result
    }
    const gateway = await start(host)
    const token = await pair(gateway)
    const { socket, frames } = await stream(gateway, token)
    socket.close()
    expect(frames.at(-1)).toMatchObject({
      replayOutcome: 'incomplete',
      reason: 'Live buffer exceeded its bound; resync history.',
    })
    expect(frames.filter((frame) => frame.kind === 'live')).toHaveLength(0)
  })

  it('fences private replay at revoke and rejects expired managed resources', async () => {
    await engine.createSession(fixture())
    const h = await managed(makeHost({ desktop: desktop() }))
    const original = engine.replaySessionRangeChunks.bind(engine)
    vi.spyOn(engine, 'replaySessionRangeChunks').mockImplementation(async (...args) => {
      const result = await original(...args)
      h.gateway.pairing.revoke(h.gateway.pairing.toPersisted().devices[0]!.deviceId)
      return result
    })
    const socket = await RawWebSocket.open(h.gateway.port, '/events', {
      origin: 'http://127.0.0.1:5173',
      protocols: ['ari-remote.v1', `bearer.${h.token}`, `lease.${h.lease}`],
    })
    socket.send(JSON.stringify({ type: 'events.desktop.subscribe', sessionId: 's' }))
    const startFrame = remoteDesktopFrameSchema.parse(JSON.parse(await socket.nextMessage()))
    const chunk = remoteDesktopFrameSchema.parse(JSON.parse(await socket.nextMessage()))
    expect(startFrame.frame.kind).toBe('start')
    expect(chunk.frame.kind).toBe('chunk')
    await vi.waitFor(() => expect(socket.socket.destroyed).toBe(true), { timeout: 5000 })
    socket.close()
    expect(
      (await call(h.gateway, '/query', { op: 'host.permissions' }, h.token, h.lease)).status,
    ).toBe(401)
    const fresh = await managed(makeHost({ desktop: desktop() }))
    expect(
      (await call(fresh.gateway, '/query', { op: 'host.version' }, fresh.token, fresh.lease))
        .status,
    ).toBe(200)
    fresh.expire()
    expect(
      (await call(fresh.gateway, '/query', { op: 'host.resources' }, fresh.token, fresh.lease))
        .status,
    ).toBe(403)
  })

  it('never repeats desktop creation after an invalid post-effect result', async () => {
    const deps = desktop()
    const create = vi.fn(async () => {
      await engine.createSession({ ...fixture('created-once'), title: 'Effect survived' })
      return { sessionId: '' }
    })
    deps.createSession = create
    const gateway = await start(makeHost({ desktop: deps }))
    const token = await pair(gateway)
    const command = {
      op: 'session.desktop.create',
      projectId: 'p',
      title: 'Effect survived',
      driverKind: 'codex',
      modelId: 'fixture',
      effort: null,
      permissionMode: 'full',
      workspaceMode: 'auto',
      clientCommandId: 'uncertain-create',
      idempotencyKey: 'uncertain-original-create',
    }
    expect((await call(gateway, '/command', command, token)).status).toBe(500)
    expect((await call(gateway, '/command', command, token)).status).toBe(409)
    const status = await call(
      gateway,
      '/query',
      { op: 'command.status', idempotencyKey: command.idempotencyKey },
      token,
    )
    expect(status.status).toBe(409)
    expect(status.body.error?.code).toBe('conflict')
    expect(create).toHaveBeenCalledTimes(1)
    expect((await store.load('created-once')).session?.title).toBe('Effect survived')
  })
})

describe('repository correlation', () => {
  it.each(['file:///repo', '../repo', '/repo', 'C:/repo', '\\\\server\\repo', 'repo'])(
    'does not group local remote %s',
    (url) => {
      expect(normalizeRepositoryRemote(url)).toBeNull()
    },
  )
  it('groups fetch upstream canonically while retaining differing origin as fork group', () => {
    expect(
      repositoryIdentityFromRemotes([
        { name: 'origin', url: 'ssh://git@GitHub.com/Me/App.git/' },
        { name: 'upstream', url: 'https://user:secret@github.com/Acme/App.git?key=secret' },
      ]),
    ).toMatchObject({
      canonicalKey: 'github.com/acme/app',
      origin: { canonicalKey: 'github.com/me/app' },
    })
    expect(normalizeRepositoryRemote('git@ssh.dev.azure.com:v3/Org/Project/Repo')).toBe(
      'dev.azure.com/org/project/_git/repo',
    )
    expect(normalizeRepositoryRemote('https://forge.internal.example/Team/App.git')).toBe(
      'forge.internal.example/team/app',
    )
  })
})
