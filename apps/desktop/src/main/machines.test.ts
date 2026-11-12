// @vitest-environment node
import { randomBytes } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionStore } from '@ari/engine/session-store'
import { DriverRegistry } from '@ari/providers/registry'
import {
  UNKNOWN_PROVIDER_CAPABILITIES,
  type Driver,
  type AdapterApprovalDecision,
} from '@ari/providers/driver'
import type { AgentEvent } from '@ari/contracts/agent-event'
import {
  remoteCommandEnvelopeSchema,
  remoteSessionResultSchema,
  type RemoteCommand,
} from '@ari/contracts/remote'
import {
  machineEventsFrameSchema,
  machineOperationResultSchema,
  type MachineEventsFrame,
} from '@ari/contracts/machines'
import { RemoteError } from '@ari/remote-client'
import { PairingService, type PersistedPairing } from '@ari/remote-gateway/pairing'
import { createRemoteGateway, type RemoteGateway } from '@ari/remote-gateway/gateway'
import { Engine } from './engine'
import { createRemoteHost } from './remote-host'
import { MachinesService } from './machines'
import { MachinesRegistry, DesktopMachineCredential } from './machines-registry'
import { MachineNetwork, parseMachineAddress, tailnetPeerRoutes } from './machines-network'
import { loadMachineIdentity } from './machine-identity'
import { aesGcmSecretBox } from './secret-box'
import { RpcRegistry } from './rpc-registry'
import { registerMachinesRpc, subscribeMachineStream } from './machines-rpc'

const cleanups: (() => Promise<unknown> | unknown)[] = []
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
})
function temporary(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ari-machines-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }))
  return dir
}
function client(
  dir = temporary(),
  options: Partial<ConstructorParameters<typeof MachinesService>[0]> = {},
): MachinesService {
  const box = aesGcmSecretBox(randomBytes(32)) // OS keyring seam only; real signing and encryption.
  const machines = new MachinesService({
    dir,
    secretBox: () => box,
    allowLoopback: true,
    decisionPollMs: 2,
    decisionTimeoutMs: 2000,
    ...options,
  })
  cleanups.push(() => machines.dispose())
  return machines
}
function command(fields: Record<string, unknown>, key = crypto.randomUUID()): RemoteCommand {
  return remoteCommandEnvelopeSchema.parse({
    ...fields,
    clientCommandId: `client_${key}`,
    idempotencyKey: key,
  })
}

interface RunningHost {
  dir: string
  store: SessionStore
  engine: Engine
  gateway: RemoteGateway
  decisions: AdapterApprovalDecision[]
  prompts: string[]
  restart(): Promise<void>
}

/** Actual Engine, SessionStore, RemoteHost, gateway HTTP/WebSocket and git repository. */
async function realHost(label: string, copiedMachineId?: string): Promise<RunningHost> {
  const dir = temporary()
  const project = join(dir, 'project')
  mkdirSync(project)
  writeFileSync(join(project, 'README.md'), label)
  for (const args of [
    ['init'],
    ['config', 'user.email', 'machines@test.invalid'],
    ['config', 'user.name', 'Machines test'],
    ['add', '.'],
    ['commit', '-m', 'fixture'],
  ])
    execFileSync('git', args, { cwd: project, windowsHide: true, stdio: 'ignore' })
  const prompts: string[] = []
  const decisions: AdapterApprovalDecision[] = []
  const driver: Driver = {
    kind: 'codex',
    create: async (request) => {
      prompts.push(request.prompt)
      let release: ((value: AdapterApprovalDecision | null) => void) | undefined
      const wait = new Promise<AdapterApprovalDecision | null>((resolve) => {
        release = resolve
      })
      return {
        capabilities: () => ({
          ...UNKNOWN_PROVIDER_CAPABILITIES,
          steering: 'live',
          liveResponses: 'approvals-and-input',
        }),
        start: () => ({
          async *[Symbol.asyncIterator](): AsyncGenerator<AgentEvent> {
            if (request.prompt.includes('approval')) {
              yield {
                type: 'approval-requested',
                approvalId: 'approval_same',
                toolName: 'fixture',
                summaryJson: '{}',
                options: [{ optionId: 'accept', name: 'Allow once', kind: 'allow_once' }],
              }
              const decision = await wait
              if (decision === null) return
              yield { type: 'text-delta', text: `${label} approved` }
            } else if (request.prompt.includes('hold')) {
              yield { type: 'text-delta', text: `${label} waiting` }
              await wait
            } else yield { type: 'text-delta', text: `${label} result` }
            yield { type: 'done' }
          },
        }),
        interrupt: () => release?.(null),
        dispose: async () => {
          release?.(null)
        },
        respondApproval: (_id, decision) => {
          decisions.push(decision)
          release?.(decision)
        },
        steer: async () => true,
      }
    },
  }
  const makeEngine = (store: SessionStore): Engine => {
    const registry = new DriverRegistry()
    registry.register(driver)
    return new Engine({
      store,
      registry,
      publish: () => undefined,
      resolveWorkspace: async () => project,
    })
  }
  let store = new SessionStore({ rootDir: join(dir, 'sessions') })
  let engine = makeEngine(store)
  const profile = join(dir, 'remote')
  const identity = loadMachineIdentity(profile, 'test-1')
  const pairingPath = join(profile, 'pairing.json')
  const receiptsPath = join(profile, 'receipts.json')
  let gateway: RemoteGateway
  const start = async (port: number): Promise<RemoteGateway> => {
    const pairing = new PairingService({
      ...(existsSync(pairingPath)
        ? { restored: JSON.parse(readFileSync(pairingPath, 'utf8')) as PersistedPairing }
        : {}),
      persist: { save: (state) => writeFileSync(pairingPath, JSON.stringify(state)) },
    })
    return createRemoteGateway({
      host: createRemoteHost({
        engine,
        store,
        pairing,
        driverKinds: ['codex'],
        defaultPermissionMode: () => 'ask',
        defaultDriverKind: () => 'codex',
        hasProject: async (id) => id === `project_${label}`,
        listProjects: async () => [{ id: `project_${label}`, name: label }],
        listModels: async () => [
          {
            driverKind: 'codex',
            available: true,
            models: [{ id: 'mock-model', label: 'Mock provider' }],
          },
        ],
        // Both hosts deliberately reuse this id: route and machine scope must carry ownership.
        mintSessionId: () => 'sess_same',
      }),
      identity: {
        ...identity,
        ...(copiedMachineId === undefined ? {} : { machineId: copiedMachineId }),
        name: label,
      },
      port,
      allowedOrigins: () => [`http://localhost:${gateway.port}`],
      pairing,
      idempotency: {
        ...(existsSync(receiptsPath) ? { restore: readFileSync(receiptsPath, 'utf8') } : {}),
        persist: (json) => writeFileSync(receiptsPath, json),
      },
    })
  }
  gateway = await start(0)
  const host: RunningHost = {
    dir,
    store,
    engine,
    gateway,
    prompts,
    decisions,
    restart: async () => {
      const port = gateway.port
      await gateway.close()
      await engine.shutdown()
      await store.closeJournal('sess_same')
      store = new SessionStore({ rootDir: join(dir, 'sessions') })
      engine = makeEngine(store)
      gateway = await start(port)
      Object.assign(host, { store, engine, gateway })
    },
  }
  cleanups.push(async () => {
    await gateway.close()
    await engine.shutdown()
    await store.closeJournal('sess_same')
  })
  return host
}
async function pair(
  machines: MachinesService,
  host: RunningHost,
  terminal = false,
): Promise<string> {
  const invite = host.gateway.pairing.begin(host.gateway.origin)
  const saved = await machines.add(`${host.gateway.origin}/#pair=${invite.invitationId}`)
  const view = await machines.pair({ machineId: saved.id, displayName: 'Desktop client' })
  expect(view.status).toBe('pairing')
  await vi.waitFor(() => expect(host.gateway.pairing.pending(invite.invitationId)).toBeDefined())
  const code = host.gateway.pairing.pending(invite.invitationId)!.confirmationCode
  expect(machines.pairStatus(saved.id).confirmationCode).toBe(code)
  expect(
    host.gateway.pairing.approve(invite.invitationId, code, [`project_${saved.name}`], terminal),
  ).toEqual({ ok: true })
  // Below-normal Windows runs may defer the approved pairing poll beyond one second.
  await vi.waitFor(() => expect(machines.pairStatus(saved.id).status).toBe('connected'), {
    timeout: 5000,
  })
  return saved.id
}

describe('persistent Machines safety', () => {
  it('allows only tailnet HTTPS origins and explicitly enabled loopback test routes', () => {
    expect(parseMachineAddress('https://pc.tailnet.ts.net:8443/#pair=inv_test')).toEqual({
      route: { kind: 'tailscale', origin: 'https://pc.tailnet.ts.net:8443' },
      invitationId: 'inv_test',
    })
    expect(() => parseMachineAddress('http://127.0.0.1:8787')).toThrow(/Production/)
    expect(parseMachineAddress('http://127.0.0.1:8787', true).route.kind).toBe('loopback')
    for (const address of [
      'file:///secret',
      'http://pc.tailnet.ts.net',
      'https://example.com',
      'https://192.168.1.2',
      'https://pc.tailnet.ts.net/path',
      'https://user:password@pc.tailnet.ts.net',
      'https://pc.tailnet.ts.net?target=public',
      'https://pc.tailnet.ts.net/#pair=inv_a&token=secret',
    ])
      expect(() => parseMachineAddress(address, true)).toThrow()
  })
  it('rejects public and mixed DNS answers before opening transport', async () => {
    for (const addresses of [
      [{ address: '8.8.8.8', family: 4 }],
      [
        { address: '100.70.1.2', family: 4 },
        { address: '8.8.8.8', family: 4 },
      ],
    ]) {
      const network = new MachineNetwork({ resolve: async () => addresses })
      await expect(
        network.clientOptions({ kind: 'tailscale', origin: 'https://pc.tailnet.ts.net' }),
      ).rejects.toThrow(/exclusively/)
    }
    await expect(
      new MachineNetwork({
        resolve: async () => [{ address: '100.70.1.2', family: 4 }],
      }).clientOptions({ kind: 'tailscale', origin: 'https://pc.tailnet.ts.net' }),
    ).resolves.toHaveProperty('fetch')
  })
  it('never follows a redirect from a permitted loopback peer', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(302, { location: 'http://8.8.8.8/private' })
      res.end()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    const options = await new MachineNetwork({ allowLoopback: true }).clientOptions({
      kind: 'loopback',
      origin,
    })
    await expect(options.fetch!(`${origin}/api/identity`)).rejects.toThrow(/redirects/)
  })
  it('seals per-machine keys, unlocks them across restart, and refuses missing secure storage', async () => {
    const dir = temporary()
    const registry = new MachinesRegistry(join(dir, 'machines.json'))
    const a = registry.add('A', { kind: 'tailscale', origin: 'https://a.tailnet.ts.net' }, null)
    const b = registry.add('B', { kind: 'tailscale', origin: 'https://b.tailnet.ts.net' }, null)
    const box = aesGcmSecretBox(randomBytes(32))
    const first = new DesktopMachineCredential(a.id, registry, () => box)
    const publicKey = await first.publicKey()
    await first.remember({ deviceId: 'device_a', displayName: 'Desktop', projectIds: [] })
    const disk = readFileSync(join(dir, 'machines.json'), 'utf8')
    expect(disk).not.toMatch(/PRIVATE KEY|device_a|"token"/)
    const restored = new DesktopMachineCredential(
      a.id,
      new MachinesRegistry(join(dir, 'machines.json')),
      () => box,
    )
    await restored.load()
    expect(restored.deviceId).toBe('device_a')
    expect(await restored.publicKey()).toEqual(publicKey)
    registry.update(b.id, { credentialCipher: registry.get(a.id).credentialCipher })
    await expect(new DesktopMachineCredential(b.id, registry, () => box).load()).rejects.toThrow(
      /another computer/,
    )
    const absent = registry.add(
      'C',
      { kind: 'tailscale', origin: 'https://c.tailnet.ts.net' },
      null,
    )
    await expect(
      new DesktopMachineCredential(absent.id, registry, () => null).publicKey(),
    ).rejects.toThrow(/Secure storage/)
    expect(registry.get(absent.id).credentialCipher).toBeNull()
  })
  it('preserves corrupt registry data and persists a stable host identity', () => {
    const dir = temporary()
    const first = loadMachineIdentity(dir, '1')
    expect(loadMachineIdentity(dir, '2')).toEqual({ ...first, ariVersion: '2' })
    const path = join(dir, 'machines.json')
    writeFileSync(path, '{broken')
    expect(() => new MachinesRegistry(path)).toThrow()
    expect(readFileSync(path, 'utf8')).toBe('{broken')
  })
  it('contains unreadable Machines registry startup while local RPC remains available', async () => {
    const dir = temporary()
    const path = join(dir, 'machines.json')
    writeFileSync(path, '{broken')
    const network = new MachineNetwork({ allowLoopback: true })
    const transport = vi.spyOn(network, 'clientOptions')
    const machines = client(dir, { network })
    const registry = new RpcRegistry({ send: vi.fn() })
    registry.register('session.list', () => [])
    registerMachinesRpc(registry, machines)
    await expect(registry.invoke('session.list', undefined)).resolves.toEqual([])
    await expect(registry.invoke('machines.list', undefined)).rejects.toThrow(
      /Saved computers could not be loaded/,
    )
    await expect(
      registry.invoke('machines.add', { address: 'http://127.0.0.1:8787' }),
    ).rejects.toThrow(/registry has been preserved/)
    expect(
      await registry.invoke('machines.query', {
        machineId: 'saved',
        query: { op: 'project.list' },
      }),
    ).toMatchObject({
      ok: false,
      error: {
        code: 'internal_error',
        message: expect.stringMatching(/registry has been preserved/),
      },
    })
    expect(() =>
      subscribeMachineStream(registry, machines, {
        id: 'updates',
        name: 'machines.updates',
        params: {},
      }),
    ).toThrow(/Saved computers/)
    expect(registry.subscriberCount()).toBe(0)
    expect(transport).not.toHaveBeenCalled()
    expect(readFileSync(path, 'utf8')).toBe('{broken')
    await expect(registry.invoke('session.list', undefined)).resolves.toEqual([])
  })
  it.each(['seal', 'write'] as const)(
    'does not activate an unsaved key or device identity after a failed %s',
    async (failure) => {
      const registry = new MachinesRegistry(join(temporary(), 'machines.json'))
      const row = registry.add('A', { kind: 'tailscale', origin: 'https://a.tailnet.ts.net' }, null)
      const box = aesGcmSecretBox(randomBytes(32))
      let failing = true
      const update = registry.update.bind(registry)
      vi.spyOn(registry, 'update').mockImplementation((id, patch) => {
        if (failing && failure === 'write') throw new Error('fixture write failure')
        return update(id, patch)
      })
      const credential = new DesktopMachineCredential(row.id, registry, () => ({
        decrypt: box.decrypt,
        encrypt: (plain) => {
          if (failing && failure === 'seal') throw new Error('fixture seal failure')
          return box.encrypt(plain)
        },
      }))
      await expect(credential.publicKey()).rejects.toThrow(/fixture/)
      await expect(credential.sign('nonce')).rejects.toThrow(/Pair this computer/)
      expect(registry.get(row.id).credentialCipher).toBeNull()
      failing = false
      const publicKey = await credential.publicKey()
      await credential.remember({ deviceId: 'original', displayName: 'A', projectIds: [] })
      const cipher = registry.get(row.id).credentialCipher
      failing = true
      await expect(
        credential.remember({ deviceId: 'unsaved', displayName: 'B', projectIds: [] }),
      ).rejects.toThrow(/fixture/)
      expect(credential.deviceId).toBe('original')
      expect(registry.get(row.id).credentialCipher).toBe(cipher)
      const restored = new DesktopMachineCredential(row.id, registry, () => box)
      await restored.load()
      expect(restored.deviceId).toBe('original')
      expect(await restored.publicKey()).toEqual(publicKey)
    },
  )
  it('discovers bounded explicit online peers without scans or pairing', async () => {
    const runner = vi.fn(async () => ({
      code: 0,
      stdout: JSON.stringify({
        BackendState: 'Running',
        Peer: {
          a: { Online: true, DNSName: 'a.tailnet.ts.net.' },
          b: { Online: false, DNSName: 'b.tailnet.ts.net.' },
          c: { Online: true, DNSName: 'evil.com.' },
        },
      }),
    }))
    expect(await tailnetPeerRoutes(runner)).toEqual([
      { kind: 'tailscale', origin: 'https://a.tailnet.ts.net' },
      { kind: 'tailscale', origin: 'https://a.tailnet.ts.net:8443' },
    ])
    expect(runner).toHaveBeenCalledExactlyOnceWith(['status', '--json'])
  })
})

describe('Machines with two real gateways and engines', () => {
  it('pairs with host approval, operates isolated sessions, streams, answers, stops, restarts and revokes', async () => {
    const a = await realHost('A')
    const b = await realHost('B')
    const profile = temporary()
    const box = aesGcmSecretBox(randomBytes(32))
    let machines = client(profile, { secretBox: () => box })
    const machineA = await pair(machines, a)
    const machineB = await pair(machines, b, true)
    expect(machines.list().find((row) => row.id === machineA)?.allowTerminal).toBe(false)
    expect(machines.list().find((row) => row.id === machineB)?.allowTerminal).toBe(true)
    expect(JSON.stringify(machines.list())).not.toMatch(
      /credentialCipher|PRIVATE KEY|"token"|deviceId/,
    )
    const identity = await fetch(`${a.gateway.origin}/api/identity`).then((response) =>
      response.json(),
    )
    expect(Object.keys(identity.result).sort()).toEqual([
      'ariVersion',
      'capabilities',
      'machineId',
      'machinesExtensions',
      'name',
      'protocolVersion',
    ])
    expect(identity.result.capabilities).toContain('pairing.request')
    for (const [id, label] of [
      [machineA, 'A'],
      [machineB, 'B'],
    ] as const) {
      expect(await machines.query(id, { op: 'project.list' })).toEqual([
        { id: `project_${label}`, name: label, sessionCount: 0 },
      ])
      const create = command({
        op: 'session.create',
        projectId: `project_${label}`,
        driverKind: 'codex',
        modelId: 'mock-model',
      })
      expect(await machines.command(id, create)).toEqual({ sessionId: 'sess_same' })
      expect(await machines.command(id, create)).toEqual({ sessionId: 'sess_same' })
      expect(await machines.query(id, { op: 'session.list' })).toMatchObject([
        { id: 'sess_same', projectId: `project_${label}` },
      ])
    }
    const framesA: MachineEventsFrame[] = []
    const framesB: MachineEventsFrame[] = []
    const snapshotA = remoteSessionResultSchema.parse(
      await machines.query(machineA, { op: 'session.get', sessionId: 'sess_same' }),
    )
    const snapshotB = remoteSessionResultSchema.parse(
      await machines.query(machineB, { op: 'session.get', sessionId: 'sess_same' }),
    )
    await machines.subscribe(
      'stream_a',
      { machineId: machineA, sessionId: 'sess_same', fromSeq: snapshotA.seq },
      (frame) => framesA.push(frame),
    )
    await machines.subscribe(
      'stream_b',
      { machineId: machineB, sessionId: 'sess_same', fromSeq: snapshotB.seq },
      (frame) => framesB.push(frame),
    )
    const promptA = command({
      op: 'session.prompt',
      sessionId: 'sess_same',
      text: 'approval please',
    })
    expect(await machines.command(machineA, promptA)).toMatchObject({ accepted: true })
    expect(
      await machines.command(
        machineB,
        command({ op: 'session.prompt', sessionId: 'sess_same', text: 'simple prompt' }),
      ),
    ).toMatchObject({ accepted: true })
    try {
      await vi.waitFor(
        async () => expect((await a.store.load('sess_same')).pendingApprovals).toHaveLength(1),
        { timeout: 6000 },
      )
    } catch (error) {
      const model = await a.store.load('sess_same')
      throw new Error(
        `Approval fixture state: ${JSON.stringify({ session: model.session, lastTurn: model.lastTurn, prompts: a.prompts, journal: await a.engine.replaySession('sess_same') })}`,
        { cause: error },
      )
    }
    await vi.waitFor(() =>
      expect(
        framesA.some(
          (frame) =>
            frame.message.type === 'events.frame' &&
            frame.message.events.some(
              (row) => (row.event as { type?: string }).type === 'approval.requested',
            ),
        ),
      ).toBe(true),
    )
    await machines.command(
      machineA,
      command({
        op: 'approval.respond',
        sessionId: 'sess_same',
        approvalId: 'approval_same',
        optionId: 'accept',
      }),
    )
    await a.engine.quiesce('sess_same')
    await b.engine.quiesce('sess_same')
    expect(a.decisions).toEqual([{ optionId: 'accept' }])
    expect(b.decisions).toEqual([])
    for (const [id, label, frames] of [
      [machineA, 'A', framesA],
      [machineB, 'B', framesB],
    ] as const) {
      const snapshot = remoteSessionResultSchema.parse(
        await machines.query(id, { op: 'session.get', sessionId: 'sess_same' }),
      )
      expect(snapshot.session.projectId).toBe(`project_${label}`)
      expect(
        snapshot.messages.some((message) =>
          message.parts.some((part) => part.type === 'text' && part.text.includes(label)),
        ),
      ).toBe(true)
      await vi.waitFor(() => expect(frames.length).toBeGreaterThan(0))
      for (const frame of frames) expect(machineEventsFrameSchema.parse(frame).machineId).toBe(id)
    }
    await machines.command(
      machineA,
      command({ op: 'session.prompt', sessionId: 'sess_same', text: 'hold this turn' }),
    )
    await vi.waitFor(async () =>
      expect((await a.store.load('sess_same')).session?.status).toBe('running'),
    )
    await machines.command(machineA, command({ op: 'session.interrupt', sessionId: 'sess_same' }))
    await a.engine.quiesce('sess_same')
    expect((await a.store.load('sess_same')).session?.status).toBe('idle')
    machines.rename(machineA, 'Office computer')
    machines.dispose()
    await a.restart()
    machines = client(profile, { secretBox: () => box })
    expect(machines.list().find((row) => row.id === machineA)?.name).toBe('Office computer')
    expect(machines.list().find((row) => row.id === machineB)?.allowTerminal).toBe(false)
    expect((await machines.connect(machineA)).status).toBe('connected')
    expect((await machines.connect(machineB)).allowTerminal).toBe(true)
    expect(
      await machines.query(machineA, {
        op: 'command.status',
        idempotencyKey: promptA.idempotencyKey,
      }),
    ).toMatchObject({ ok: true })
    const reconnectFrames: MachineEventsFrame[] = []
    await machines.subscribe(
      'resume_a',
      { machineId: machineA, sessionId: 'sess_same', fromSeq: snapshotA.seq },
      (frame) => reconnectFrames.push(frame),
    )
    await vi.waitFor(() =>
      expect(
        reconnectFrames.some(
          (frame) => frame.message.type === 'events.frame' && frame.message.caughtUp,
        ),
      ).toBe(true),
    )
    const deviceA = a.gateway.pairing.devices()[0]!.deviceId
    expect(a.gateway.pairing.revoke(deviceA)).toBe(true)
    expect((await machines.connect(machineA)).status).toBe('revoked')
    expect((await machines.connect(machineB)).status).toBe('connected')
    expect(await machines.remove(machineB)).toEqual({ removed: true })
    expect(b.gateway.pairing.devices()).toEqual([])
    expect(readFileSync(join(profile, 'machines.json'), 'utf8')).not.toContain(machineB)
  // Two engines, git fixtures, restart and PTY cleanup run below normal priority under the gate.
  }, 90_000)

  it('rejects version mismatch before a pairing request and missing capabilities before commands', async () => {
    const a = await realHost('A')
    let requests = 0
    const mismatch = createServer((req, res) => {
      if (req.url?.startsWith('/pair/')) requests++
      res.setHeader('content-type', 'application/json')
      res.end(
        JSON.stringify({
          ok: true,
          result: { machineId: 'incompatible', protocolVersion: 99, capabilities: [] },
        }),
      )
    })
    await new Promise<void>((resolve) => mismatch.listen(0, '127.0.0.1', resolve))
    cleanups.push(() => new Promise<void>((resolve) => mismatch.close(() => resolve())))
    const origin = `http://127.0.0.1:${(mismatch.address() as { port: number }).port}`
    const machines = client()
    const saved = await machines.add(`${origin}/#pair=inv_bad`)
    expect(saved.status).toBe('incompatible')
    await expect(
      machines.pair({ machineId: saved.id, displayName: 'Desktop' }),
    ).rejects.toMatchObject({ code: 'unsupported_version' })
    expect(requests).toBe(0)
    const id = await pair(machines, a)
    await expect(
      machines.command(id, command({ op: 'terminal.create', sessionId: 'sess_same' })),
    ).rejects.toMatchObject({ code: 'unsupported_capability' })
    expect(a.prompts).toEqual([])
  })

  it('registers only scoped RPCs and validates stream params before registering', async () => {
    const machines = client()
    const registry = new RpcRegistry({ send: vi.fn() })
    registerMachinesRpc(registry, machines)
    expect(await registry.invoke('machines.list', undefined)).toEqual([])
    await expect(
      registry.invoke('machines.command', {
        machineId: 'unknown',
        command: { op: 'command.dispatch', path: 'C:/private' },
      }),
    ).rejects.toThrow(/invalid params/)
    expect(() =>
      subscribeMachineStream(registry, machines, {
        id: 'bad',
        name: 'machines.events',
        params: { sessionId: 'sess_same' },
      }),
    ).toThrow()
    expect(registry.subscriberCount()).toBe(0)
  })

  it('preserves named IPC failures and leaves generic command outcomes uncertain', async () => {
    const machines = client()
    const registry = new RpcRegistry({ send: vi.fn() })
    registerMachinesRpc(registry, machines)
    const params = {
      machineId: 'fixture',
      query: { op: 'command.status', idempotencyKey: 'receipt_1' },
    }
    const query = vi.spyOn(machines, 'query')
    for (const code of ['not_found', 'conflict', 'unreachable'] as const) {
      query.mockRejectedValueOnce(new RemoteError(code, `fixture ${code}`))
      const result = JSON.parse(
        JSON.stringify(await registry.invoke('machines.query', params)),
      ) as unknown
      expect(machineOperationResultSchema.parse(result)).toEqual({
        ok: false,
        error: { code, message: `fixture ${code}` },
      })
    }
    const mutation = vi.spyOn(machines, 'command').mockResolvedValueOnce({ accepted: true })
    expect(
      await registry.invoke('machines.command', {
        machineId: 'fixture',
        command: command({ op: 'session.prompt', sessionId: 'sess_same', text: 'one' }),
      }),
    ).toEqual({ ok: true, result: { accepted: true } })
    mutation.mockRejectedValueOnce(new Error('unknown transport outcome'))
    await expect(
      registry.invoke('machines.command', {
        machineId: 'fixture',
        command: command({ op: 'session.prompt', sessionId: 'sess_same', text: 'two' }),
      }),
    ).rejects.toThrow(/unknown outcome/)
    expect(mutation).toHaveBeenCalledTimes(2)
  })

  it('drops late frames and failures when a subscription id is reused', async () => {
    const machines = client()
    const send = vi.fn()
    const registry = new RpcRegistry({ send })
    let fail!: (error: unknown) => void
    let emit!: (frame: MachineEventsFrame) => void
    vi.spyOn(machines, 'subscribe').mockImplementation((_id, _scope, listener) => {
      emit = listener
      return new Promise<void>((_resolve, reject) => {
        fail = reject
      })
    })
    subscribeMachineStream(registry, machines, {
      id: 'reused',
      name: 'machines.events',
      params: { machineId: 'A', sessionId: 'same' },
    })
    registry.unsubscribe('reused')
    registry.subscribe({ id: 'reused', name: 'session.events', params: { sessionId: 'local' } })
    emit({ machineId: 'A', message: { type: 'events.frame', sessionId: 'same', events: [] } })
    fail(new RemoteError('not_found', 'old subscription failure'))
    await vi.waitFor(() => expect(send).not.toHaveBeenCalled())
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(send).not.toHaveBeenCalled()
  })

  it('cancels actual delayed authorization before opening a removed/reused stream', async () => {
    const host = await realHost('A')
    const profile = temporary()
    const box = aesGcmSecretBox(randomBytes(32))
    const original = client(profile, { secretBox: () => box })
    const machineId = await pair(original, host)
    original.dispose()
    const network = new MachineNetwork({ allowLoopback: true })
    const clientOptions = network.clientOptions.bind(network)
    let release!: () => void
    let entered = false
    let sockets = 0
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    vi.spyOn(network, 'clientOptions').mockImplementation(async (route) => {
      const options = await clientOptions(route)
      return {
        ...options,
        fetch: async (input, init) => {
          const response = await options.fetch!(input, init)
          if (String(input).endsWith('/device/authorize')) {
            entered = true
            await gate
          }
          return response
        },
        webSocket: (url, protocols) => {
          sockets++
          return options.webSocket!(url, protocols)
        },
      }
    })
    const machines = client(profile, { secretBox: () => box, network })
    const send = vi.fn()
    const registry = new RpcRegistry({ send })
    subscribeMachineStream(registry, machines, {
      id: 'pending',
      name: 'machines.events',
      params: { machineId, sessionId: 'sess_same' },
    })
    await vi.waitFor(() => expect(entered).toBe(true))
    machines.unsubscribe('pending')
    registry.unsubscribe('pending')
    registry.subscribe({ id: 'pending', name: 'session.events', params: { sessionId: 'local' } })
    release()
    await vi.waitFor(() => expect(machines.list()[0]?.status).toBe('connected'))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(sockets).toBe(0)
    expect(send).not.toHaveBeenCalled()
    await expect(machines.query(machineId, { op: 'project.list' })).resolves.toHaveLength(1)
  })

  it('never reuses an approved credential at a new origin that copies public host identity', async () => {
    const host = await realHost('A')
    const profile = temporary()
    const machines = client(profile)
    const id = await pair(machines, host)
    const cipher = new MachinesRegistry(join(profile, 'machines.json')).get(id).credentialCipher
    const publicIdentity = (await fetch(`${host.gateway.origin}/api/identity`).then((response) =>
      response.json(),
    )) as unknown
    const received: string[] = []
    const attacker = createServer((req, res) => {
      received.push(req.url ?? '')
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(publicIdentity))
    })
    await new Promise<void>((resolve) => attacker.listen(0, '127.0.0.1', resolve))
    cleanups.push(() => new Promise<void>((resolve) => attacker.close(() => resolve())))
    const origin = `http://127.0.0.1:${(attacker.address() as { port: number }).port}`
    const copied = await machines.add(origin)
    expect(copied.identity?.machineId).toBe(
      machines.list().find((row) => row.id === id)?.identity?.machineId,
    )
    expect(copied.id).not.toBe(id)
    expect(machines.list()).toHaveLength(2)
    expect((await machines.connect(copied.id)).status).toBe('unpaired')
    await expect(machines.query(copied.id, { op: 'project.list' })).rejects.toMatchObject({
      code: 'unauthenticated',
    })
    expect(received.every((path) => path === '/api/identity' || path === '/info')).toBe(true)
    expect(
      new MachinesRegistry(join(profile, 'machines.json')).get(copied.id).credentialCipher,
    ).toBeNull()
    expect(new MachinesRegistry(join(profile, 'machines.json')).get(id).credentialCipher).toBe(
      cipher,
    )
    expect(host.gateway.pairing.devices()).toHaveLength(1)
  })

  it('independently approves different keys at two actual hosts with matching public ids', async () => {
    const a = await realHost('A')
    const identity = loadMachineIdentity(join(a.dir, 'remote'), 'test-1')
    const b = await realHost('B', identity.machineId)
    const profile = temporary()
    const box = aesGcmSecretBox(randomBytes(32))
    const machines = client(profile, { secretBox: () => box })
    const idA = await pair(machines, a)
    const savedB = await machines.add(b.gateway.origin)
    expect(savedB.identity?.machineId).toBe(identity.machineId)
    expect(savedB.id).not.toBe(idA)
    expect((await machines.connect(savedB.id)).status).toBe('unpaired')
    expect(b.gateway.pairing.devices()).toHaveLength(0)
    const idB = await pair(machines, b)
    expect(idB).toBe(savedB.id)
    const registry = new MachinesRegistry(join(profile, 'machines.json'))
    const keyA = await new DesktopMachineCredential(idA, registry, () => box).publicKey()
    const keyB = await new DesktopMachineCredential(idB, registry, () => box).publicKey()
    expect(keyB).not.toEqual(keyA)
    expect(await machines.query(idA, { op: 'project.list' })).toMatchObject([{ id: 'project_A' }])
    expect(await machines.query(idB, { op: 'project.list' })).toMatchObject([{ id: 'project_B' }])
    a.gateway.pairing.revoke(a.gateway.pairing.devices()[0]!.deviceId)
    expect((await machines.connect(idA)).status).toBe('revoked')
    expect((await machines.connect(idB)).status).toBe('connected')
  })

  it('does not resend an executed command after a lost answer and absent receipt history on host restart', async () => {
    const host = await realHost('A')
    const network = new MachineNetwork({ allowLoopback: true })
    const clientOptions = network.clientOptions.bind(network)
    let commands = 0
    vi.spyOn(network, 'clientOptions').mockImplementation(async (route) => {
      const options = await clientOptions(route)
      return {
        ...options,
        fetch: async (input, init) => {
          const response = await options.fetch!(input, init)
          if (String(input).endsWith('/command')) {
            commands++
            throw new TypeError('fixture answer lost after dispatch')
          }
          return response
        },
      }
    })
    const machines = client(temporary(), { network })
    const id = await pair(machines, host)
    const registry = new RpcRegistry({ send: vi.fn() })
    registerMachinesRpc(registry, machines)
    const create = command({
      op: 'session.create',
      projectId: 'project_A',
      driverKind: 'codex',
      modelId: 'mock-model',
    })
    expect(
      await registry.invoke('machines.command', { machineId: id, command: create }),
    ).toMatchObject({
      ok: false,
      error: { code: 'unreachable' },
    })
    expect((await host.store.load('sess_same')).session?.projectId).toBe('project_A')
    // A valid empty file models retention loss on old and hardened gateways.
    // Damaged restore is separately refused by B's gateway persistence tests.
    writeFileSync(join(host.dir, 'remote', 'receipts.json'), '[]')
    await host.restart()
    expect((await machines.connect(id)).status).toBe('connected')
    expect(
      await registry.invoke('machines.query', {
        machineId: id,
        query: { op: 'command.status', idempotencyKey: create.idempotencyKey },
      }),
    ).toMatchObject({
      ok: false,
      error: { code: expect.stringMatching(/^(not_found|conflict)$/) },
    })
    expect(commands).toBe(1)
    expect((await host.store.load('sess_same')).session?.projectId).toBe('project_A')
  })

  it('recovers a failed OS-keyring unlock using the original paired key', async () => {
    const host = await realHost('A')
    const profile = temporary()
    const box = aesGcmSecretBox(randomBytes(32))
    let available = true
    const original = client(profile, { secretBox: () => box })
    const id = await pair(original, host)
    const cipher = new MachinesRegistry(join(profile, 'machines.json')).get(id).credentialCipher
    original.dispose()
    available = false
    const restored = client(profile, { secretBox: () => (available ? box : null) })
    expect((await restored.connect(id)).status).toBe('offline')
    available = true
    expect((await restored.connect(id)).status).toBe('connected')
    expect(new MachinesRegistry(join(profile, 'machines.json')).get(id).credentialCipher).toBe(
      cipher,
    )
    expect(host.gateway.pairing.devices()).toHaveLength(1)
    restored.dispose()
    const removing = client(profile, { secretBox: () => box })
    expect(await removing.remove(id)).toEqual({ removed: true })
    expect(host.gateway.pairing.devices()).toHaveLength(0)
  })
})
