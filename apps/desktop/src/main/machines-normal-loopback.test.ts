// @vitest-environment node
import { execFileSync } from 'node:child_process'
import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { Session } from '@ari/contracts/session'
import type { JournalEvent } from '@ari/contracts/events'
import { journalEventSchema } from '@ari/contracts/events'
import type { Project } from '@ari/contracts/project'
import type { MachineRoute } from '@ari/contracts/machines'
import type { SessionEventFrame, StreamFrame } from '@ari/contracts/rpc'
import { remoteHostResourcesSchema, remoteProjectCatalogSchema } from '@ari/contracts/remote'
import { SessionStore } from '@ari/engine/session-store'
import { DriverRegistry } from '@ari/providers/registry'
import { UNKNOWN_PROVIDER_CAPABILITIES } from '@ari/providers/driver'
import type { GatewayClientOptions } from '@ari/remote-client'
import { PairingService } from '@ari/remote-gateway/pairing'
import { createRemoteGateway, type RemoteGateway } from '@ari/remote-gateway/gateway'
import { createHostRouteSigner } from '@ari/remote-gateway/route-auth'
import { Engine } from './engine'
import { MachinesService } from './machines'
import { DesktopMachineCredential, MachinesRegistry } from './machines-registry'
import { MachineNetwork } from './machines-network'
import { createRemoteHost, type RemoteDesktopDeps } from './remote-host'
import { HostResourceSampler } from './remote-host-metadata'
import { RpcRegistry } from './rpc-registry'
import { registerMachinesRpc, subscribeMachineStream } from './machines-rpc'
import { aesGcmSecretBox } from './secret-box'
import { createSessionClient } from '../renderer/src/features/session/session-client'
import {
  observeMachineInventory,
  refreshMachineInventory,
} from '../renderer/src/features/session/session-machine-access'
import { transcriptStore } from '../renderer/src/features/session/transcript-store'
import { historyJournal } from '../renderer/src/features/session/history-journal'
import {
  groupRepositories,
  type ProjectCheckout,
} from '../renderer/src/features/machines/repository-groups'
import {
  selectAutoHost,
  type SelectionHost,
} from '../renderer/src/features/machines/machine-policy'

const cleanup: (() => Promise<unknown> | unknown)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
const wireId = 'sess_same'
type NormalFrame = SessionEventFrame & {
  replayStart?: boolean
  replayMode?: 'full' | 'resume'
  seq?: number
}
const session = (title: string): Session => ({
  id: wireId,
  projectId: 'p',
  title,
  driverKind: 'codex',
  modelId: 'fixture',
  permissionMode: 'full',
  status: 'idle',
  createdAt: 1,
  updatedAt: 1,
})

/** Only network reachability is controlled; every response/proof/frame uses real HTTP/WS. */
class LoopbackNetwork extends MachineNetwork {
  readonly unavailable = new Set<string>()
  readonly calls: { origin: string; path: string; authorization: string | null }[] = []
  constructor() {
    super({ allowLoopback: true, timeoutMs: 1000 })
  }
  override async clientOptions(route: MachineRoute): Promise<GatewayClientOptions> {
    const options = await super.clientOptions(route)
    return {
      ...options,
      fetch: async (input, init) => {
        const url = new URL(
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
        )
        this.calls.push({
          origin: url.origin,
          path: url.pathname,
          authorization: new Headers(init?.headers).get('authorization'),
        })
        if (this.unavailable.has(url.origin)) throw new Error('Fixture route unreachable.')
        return options.fetch!(input, init)
      },
    }
  }
}

async function hostFixture(root: string, name: string, utilization: number, messages: number) {
  let protocolVersion = 1
  const repo = join(root, name, 'repo')
  await mkdir(repo, { recursive: true })
  execFileSync('git', ['init', '-q'], { cwd: repo, windowsHide: true })
  execFileSync(
    'git',
    ['remote', 'add', 'origin', 'https://user:fixture-secret@github.com/Acme/Shared.git'],
    { cwd: repo, windowsHide: true },
  )
  const store = new SessionStore({ rootDir: join(root, name, 'sessions') })
  const directory = join(root, name, 'sessions', wireId)
  await mkdir(directory, { recursive: true })
  const events: JournalEvent[] = [
    { type: 'session.created', sessionId: wireId, seq: 0, at: 1, session: session(name) },
  ]
  for (let seq = 1; seq <= messages; seq++)
    events.push({
      type: 'user.message.added',
      sessionId: wireId,
      seq,
      at: seq + 1,
      message: {
        id: `${name}-${seq}`,
        sessionId: wireId,
        turnId: null,
        role: 'user',
        createdAt: seq + 1,
        parts: [{ type: 'text', text: `${name} history ${seq}` }],
      },
    })
  await writeFile(
    join(directory, 'journal.0000.jsonl'),
    events.map((event) => JSON.stringify(event)).join('\n') + '\n',
  )
  const drivers = new DriverRegistry()
  drivers.register({
    kind: 'codex',
    create: async () => {
      let release!: () => void
      const waiting = new Promise<void>((done) => {
        release = done
      })
      return {
        capabilities: () => ({ ...UNKNOWN_PROVIDER_CAPABILITIES, steering: 'live' }),
        steer: async () => true,
        interrupt: () => release(),
        dispose: async () => release(),
        start: () => ({
          async *[Symbol.asyncIterator]() {
            await waiting
            yield { type: 'done' as const }
          },
        }),
      }
    },
  })
  const engine = new Engine({
    store,
    registry: drivers,
    publish: () => undefined,
    resolveWorkspace: async () => repo,
    git: { captureCheckpoint: async () => ({ ok: true, value: null }) },
  })
  cleanup.push(async () => {
    await engine.shutdown()
    for (const row of await store.listSessions()) await store.closeJournal(row.id)
  })
  let counter = 0
  const sampler = new HostResourceSampler({
    now: Date.now,
    pause: async () => undefined,
    cpus: () => [
      {
        times: {
          user: ++counter * utilization * 100,
          idle: counter * (1 - utilization) * 100,
          sys: 0,
          nice: 0,
          irq: 0,
        },
      },
    ],
    memory: async () => ({ available: 6 * 1024 ** 3, total: 8 * 1024 ** 3 }),
  })
  const project: Project = {
    id: 'p',
    name: 'Shared repository',
    path: repo,
    status: 'ok',
    colorIndex: 0,
    createdAt: 1,
    lastOpenedAt: 0,
    open: true,
    defaultAgent: { driverKind: 'codex', modelId: 'fixture', effort: null, permissionMode: 'full' },
  }
  const desktop: RemoteDesktopDeps = {
    projects: async () => [project],
    resources: () => sampler.read(),
    createSession: async () => {
      throw new Error('This proof uses existing sessions.')
    },
    version: () => ({
      ariVersion: 'fixture',
      protocolVersion,
      hostingMode: 'desktop',
      update: {
        supported: false,
        reason: 'Manual update.',
        availableVersion: null,
        stagedVersion: null,
        guidance: 'Update on host.',
      },
    }),
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
  const pairing = new PairingService({ projectIds: () => ['p'] })
  const host = createRemoteHost({
    engine,
    store,
    pairing,
    desktop,
    driverKinds: ['codex'],
    defaultDriverKind: () => 'codex',
    defaultPermissionMode: () => 'full',
    mintSessionId: () => 'unused',
    hasProject: async (id) => id === 'p',
    listProjects: async () => [{ id: 'p', name: project.name }],
    listModels: async () => [
      {
        driverKind: 'codex',
        available: true,
        defaultModelId: 'fixture',
        models: [{ id: 'fixture', label: 'Fixture' }],
        efforts: [{ id: 'high', label: 'High' }],
      },
    ],
  })
  const originalSigner = createHostRouteSigner(
    `host-${name}`,
    generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey,
  )
  const signer: typeof originalSigner = {
    ...originalSigner,
    sign: (payload) => {
      // Simulate a host upgrade using the real pinned key and HTTP listener.
      if (payload.kind === 'ari.route-proof.v1') payload.protocolVersion = protocolVersion
      return originalSigner.sign(payload)
    },
  }
  const origins: string[] = []
  const listeners: RemoteGateway[] = []
  cleanup.push(async () => {
    for (const listener of listeners) await listener.close()
  })
  async function listen(port = 0) {
    let audience: string | null = null
    const gateway = await createRemoteGateway({
      host,
      pairing,
      port,
      allowedOrigins: () => origins,
      identity: { machineId: signer.hostId, name, ariVersion: 'fixture' },
      routeAuthority: { signer, audience: () => audience, servedOrigins: () => origins },
    })
    audience = gateway.origin
    if (!origins.includes(gateway.origin)) origins.push(gateway.origin)
    listeners.push(gateway)
    return gateway
  }
  return {
    store, engine, pairing, listen, listeners, signer, origins,
    setProtocolVersion: (version: number) => { protocolVersion = version },
  }
}

it('keeps normal session history and execution on the signed host across fallback, move-back, version mismatch and revoke', async () => {
  const parent = resolve(tmpdir())
  const root = await mkdtemp(join(parent, 'ari-normal-machines-'))
  cleanup.push(async () => {
    if (!resolve(root).startsWith(parent + sep))
      throw new Error('Fixture cleanup escaped its parent.')
    await rm(root, { recursive: true, force: true, maxRetries: 6, retryDelay: 50 })
  })
  const a = await hostFixture(root, 'A', 0.65, 1)
  const b = await hostFixture(root, 'B', 0.15, 2405)
  const aRoute = await a.listen()
  const primary = await b.listen()
  const backup = await b.listen()
  const network = new LoopbackNetwork()
  const box = aesGcmSecretBox(randomBytes(32))
  let now = Date.now()
  const callbacks = new Map<string, (frame: StreamFrame) => void>()
  const registry = new RpcRegistry({ send: (frame) => callbacks.get(frame.id)?.(frame) })
  const machines = new MachinesService({
    dir: join(root, 'client'),
    secretBox: () => box,
    network,
    allowLoopback: true,
    decisionPollMs: 2,
    decisionTimeoutMs: 5000,
    now: () => now,
    moveBackCooldownMs: 60_000,
    onChange: (views) => registry.publish('machines.updates', views),
  })
  cleanup.push(() => machines.dispose())
  registerMachinesRpc(registry, machines)
  registry.register('stream.subscribe', (params) => {
    subscribeMachineStream(registry, machines, params)
    return { subscribed: true }
  })
  registry.register('stream.unsubscribe', ({ id }) => {
    machines.unsubscribe(id)
    registry.unsubscribe(id)
    return { unsubscribed: true }
  })
  const ipcCalls: { method: string; params: unknown }[] = []
  vi.stubGlobal('window', {
    ari: {
      invoke: async (method: string, params?: unknown) => {
        ipcCalls.push({ method, params })
        return registry.invoke(method, params)
      },
      subscribe: (id: string, callback: (frame: StreamFrame) => void) => {
        callbacks.set(id, callback)
        return () => callbacks.delete(id)
      },
    },
  })
  const saved = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => saved.set(key, value),
    removeItem: (key: string) => saved.delete(key),
  })
  const observe = observeMachineInventory(() => undefined)
  cleanup.push(observe)
  async function pair(target: typeof a, gateway: RemoteGateway) {
    const invite = target.pairing.begin(gateway.origin)
    const machine = await machines.add(`${gateway.origin}/#pair=${invite.invitationId}`)
    await machines.pair({ machineId: machine.id, displayName: 'Normal desktop fixture' })
    await vi.waitFor(() => expect(target.pairing.pending(invite.invitationId)).toBeDefined())
    expect(
      target.pairing.approve(
        invite.invitationId,
        target.pairing.pending(invite.invitationId)!.confirmationCode,
        ['p'],
      ).ok,
    ).toBe(true)
    await vi.waitFor(
      () => expect(machines.list().find((row) => row.id === machine.id)?.status).toBe('connected'),
      { timeout: 5000 },
    )
    return machine
  }
  const savedA = await pair(a, aRoute)
  expect(a.pairing.devices()).toHaveLength(1)
  expect(b.pairing.devices()).toEqual([])
  const aDevice = a.pairing.devices()[0]!.deviceId
  const reverse = await fetch(primary.origin + '/device/challenge', {
    method: 'POST',
    headers: { origin: primary.origin, 'content-type': 'application/json' },
    body: JSON.stringify({ deviceId: aDevice }),
  })
  expect(reverse.status).toBe(200)
  const nonce = ((await reverse.json()) as { result: { nonce: string } }).result.nonce
  const credentialA = new DesktopMachineCredential(
    savedA.id,
    new MachinesRegistry(join(root, 'client', 'machines.json')),
    () => box,
  )
  const reverseAuthorization = await fetch(primary.origin + '/device/authorize', {
    method: 'POST',
    headers: { origin: primary.origin, 'content-type': 'application/json' },
    body: JSON.stringify({ deviceId: aDevice, nonce, signature: await credentialA.sign(nonce) }),
  })
  expect(reverseAuthorization.status).toBe(404)
  const savedB = await pair(b, primary)
  await vi.waitFor(() =>
    expect(machines.list().find((row) => row.id === savedB.id)?.routes).toHaveLength(2),
  )
  await refreshMachineInventory()
  const clientA = createSessionClient({ kind: 'remote', machineId: savedA.id, sessionId: wireId })
  const clientB = createSessionClient({ kind: 'remote', machineId: savedB.id, sessionId: wireId })
  expect(clientA.viewKey).not.toBe(clientB.viewKey)
  const transcript = transcriptStore(clientB.viewKey)
  const history = historyJournal(transcript)
  history.begin()
  const watched = transcript.subscribe(() => undefined)
  cleanup.push(watched)
  const frames: NormalFrame[] = []
  const received: JournalEvent[] = []
  const stop = clientB.subscribe('session.events', { sessionId: wireId }, (raw) => {
    const frame = raw as NormalFrame
    frames.push(frame)
    if (frame.replayStart) history.begin()
    for (const rawEvent of frame.events ?? (frame.event ? [frame.event] : [])) {
      const event = journalEventSchema.parse(rawEvent)
      received.push(event)
      history.add(event)
    }
    if (frame.replayDone) history.finish(frame.replayOutcome === 'complete', frame.replayMode)
    history.publish()
  })
  cleanup.push(stop)
  const terminals = () => frames.filter((frame) => frame.replayDone)
  await vi.waitFor(() => expect(terminals()).toHaveLength(1), { timeout: 10_000 })
  expect(terminals()[0]).toMatchObject({
    replayOutcome: 'complete',
    replayMode: 'full',
    seq: 2405,
    liveTurnId: null,
  })
  expect(received.map((event) => event.seq)).toEqual(Array.from({ length: 2406 }, (_, seq) => seq))
  expect(transcript.getSnapshot()).toHaveLength(2405)
  expect(transcriptStore(clientA.viewKey).getSnapshot()).toHaveLength(0)
  const dispatchA = vi.spyOn(a.engine, 'dispatch')
  const dispatchB = vi.spyOn(b.engine, 'dispatch')
  await clientB.invoke('command.dispatch', {
    command: {
      type: 'turn.start',
      sessionId: wireId,
      text: 'Exactly one host-owned turn',
      attachments: [],
    },
  })
  await vi.waitFor(() => expect(b.engine.hasLiveTurn(wireId)).toBe(true))
  await vi.waitFor(() => expect(transcript.getSnapshot()).toHaveLength(2406))
  const liveTurn = b.engine.liveTurnId(wireId)
  expect(liveTurn).not.toBeNull()
  expect(a.engine.liveTurnId(wireId)).toBeNull()
  network.unavailable.add(primary.origin)
  await clientB.reconnect()
  expect(machines.list().find((row) => row.id === savedB.id)?.effectiveRoute).toBe(backup.origin)
  await vi.waitFor(() => expect(terminals()).toHaveLength(2), { timeout: 10_000 })
  expect(terminals()[1]).toMatchObject({
    replayMode: 'resume',
    replayOutcome: 'complete',
    liveTurnId: liveTurn,
  })
  expect(transcript.getSnapshot()).toHaveLength(2406)
  await clientB.invoke('command.dispatch', {
    command: { type: 'session.update', sessionId: wireId, title: 'B through backup' },
  })
  await vi.waitFor(() => expect(history.controls().model.session?.title).toBe('B through backup'))
  await primary.close()
  b.listeners.splice(b.listeners.indexOf(primary), 1)
  const restored = await b.listen(primary.port)
  expect(restored.origin).toBe(primary.origin)
  network.unavailable.delete(primary.origin)
  now += 60_001
  await window.ari.invoke('machines.precheck', { machineId: savedB.id })
  await vi.waitFor(() =>
    expect(machines.list().find((row) => row.id === savedB.id)?.effectiveRoute).toBe(
      primary.origin,
    ),
  )
  await vi.waitFor(() => expect(terminals()).toHaveLength(3), { timeout: 10_000 })
  expect(terminals()[2]).toMatchObject({
    replayMode: 'resume',
    replayOutcome: 'complete',
    liveTurnId: liveTurn,
  })
  await clientB.invoke('command.dispatch', {
    command: { type: 'session.update', sessionId: wireId, title: 'B after move-back' },
  })
  await vi.waitFor(() => expect(history.controls().model.session?.title).toBe('B after move-back'))
  expect(transcript.getSnapshot()).toHaveLength(2406)
  expect(new Set(received.map((event) => event.seq)).size).toBe(received.length)
  expect(dispatchB.mock.calls.filter(([command]) => command.type === 'turn.start')).toHaveLength(1)
  expect(dispatchA).not.toHaveBeenCalled()
  expect((await a.store.load(wireId)).session?.title).toBe('A')
  expect(clientB.scope).toEqual({ kind: 'remote', machineId: savedB.id, sessionId: wireId })
  const originalBearer = network.calls.find(
    (call) => call.origin === primary.origin && call.path === '/routes/manifest',
  )!.authorization
  const backupAuth = network.calls.filter(
    (call) => call.origin === backup.origin && call.authorization !== null,
  )
  expect(backupAuth.length).toBeGreaterThan(0)
  expect(backupAuth.every((call) => call.authorization !== originalBearer)).toBe(true)
  expect(
    network.calls
      .filter((call) => call.origin === backup.origin)
      .some((call) => call.path === '/device/authorize'),
  ).toBe(false)

  const checkouts: ProjectCheckout[] = []
  const selections: SelectionHost[] = []
  for (const machine of [savedA, savedB]) {
    const catalog = remoteProjectCatalogSchema.parse(
      await machines.query(machine.id, { op: 'project.catalog' }),
    )
    const resources = remoteHostResourcesSchema.parse(
      await machines.query(machine.id, { op: 'host.resources' }),
    )
    expect(JSON.stringify(catalog)).not.toContain('fixture-secret')
    const project = catalog.projects[0]!
    const identity = project.repositoryIdentity!
    checkouts.push({
      hostId: machine.id,
      hostName: machine.name,
      projectId: project.id,
      name: project.name,
      checkoutLabel: project.name,
      local: false,
      repository: { canonicalKey: identity.canonicalKey },
    })
    selections.push({
      id: machine.id,
      name: machine.name,
      connected: true,
      compatible: true,
      hasProject: true,
      usableCatalog: project.defaultAgent?.modelId === 'fixture',
      preference: 'normal',
      resources: resources.status === 'available' ? { ...resources, available: true } : null,
    })
  }
  expect(groupRepositories(checkouts)).toHaveLength(1)
  expect(groupRepositories(checkouts)[0]!.checkouts).toHaveLength(2)
  expect(selectAutoHost(selections).hostId).toBe(savedB.id)
  expect(
    selectAutoHost(
      selections.map((row) =>
        row.id === savedB.id ? { ...row, preference: 'manual-only' as const } : row,
      ),
    ).hostId,
  ).toBe(savedA.id)
  const versionCheckStart = network.calls.length
  b.setProtocolVersion(2)
  expect(await machines.connect(savedB.id)).toMatchObject({
    status: 'incompatible', permissionsReady: false,
  })
  const versionChecks = network.calls.slice(versionCheckStart)
  expect(versionChecks.length).toBeGreaterThan(0)
  expect(versionChecks.every((call) =>
    call.origin === primary.origin && call.path === '/routes/proof' && call.authorization === null,
  )).toBe(true)
  await refreshMachineInventory()
  expect(clientB.readOnly).toBe(true)
  await expect(clientB.invoke('session.load', { sessionId: wireId })).rejects.toThrow()
  expect(clientA.readOnly).toBe(false)
  expect((await a.store.load(wireId)).session?.title).toBe('A')
  b.setProtocolVersion(1)
  expect(await machines.connect(savedB.id)).toMatchObject({ status: 'connected' })
  await refreshMachineInventory()
  await vi.waitFor(() => expect(terminals()).toHaveLength(4), { timeout: 10_000 })
  expect(terminals()[3]).toMatchObject({
    replayMode: 'resume', replayOutcome: 'complete', liveTurnId: liveTurn,
  })
  expect(transcript.getSnapshot()).toHaveLength(2406)
  expect(dispatchB.mock.calls.filter(([command]) => command.type === 'turn.start')).toHaveLength(1)
  expect(dispatchA).not.toHaveBeenCalled()
  b.pairing.revoke(b.pairing.devices()[0]!.deviceId)
  await machines.connect(savedB.id)
  await refreshMachineInventory()
  expect(clientB.readOnly).toBe(true)
  expect(transcript.getSnapshot()).toHaveLength(0)
  await expect(clientB.invoke('session.load', { sessionId: wireId })).rejects.toThrow()
  expect(clientA.readOnly).toBe(false)
  expect(a.pairing.devices()).toHaveLength(1)
  const aMetadata = (await clientA.invoke('session.load', { sessionId: wireId })) as {
    session: Session
  }
  expect(aMetadata.session.title).toBe('A')
  expect(ipcCalls.filter((call) => call.method === 'machines.command')).toHaveLength(3)
  expect(
    ipcCalls.every(
      (call) => call.method.startsWith('machines.') || call.method.startsWith('stream.'),
    ),
  ).toBe(true)
}, 60_000)
