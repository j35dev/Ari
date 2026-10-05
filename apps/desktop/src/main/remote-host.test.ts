import { generateKeyPairSync, sign } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GitService } from '@ari/engine/git'
import { SessionStore } from '@ari/engine/session-store'
import { ok, err } from '@ari/shared/result'
import { driverKindSchema, type DriverKind } from '@ari/contracts/common'
import type { Command } from '@ari/contracts/commands'
import {
  remoteChangesSchema,
  remoteAttentionSchema,
  remoteQuerySchema,
  remoteModelCatalogSchema,
  type RemoteCommand,
} from '@ari/contracts/remote'
import type { Session } from '@ari/contracts/session'
import type { UnstampedEvent } from '@ari/engine/projection'
import type { RemoteCaller } from '@ari/remote-gateway/host'
import { PairingService } from '@ari/remote-gateway/pairing'
import { createRemoteHost, type RemoteHostDeps } from './remote-host'
import { AttachmentStore } from './attachments'

const roots: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function tempStore(): Promise<SessionStore> {
  const root = await mkdtemp(join(tmpdir(), 'ari-remote-host-'))
  roots.push(root)
  return new SessionStore({ rootDir: root })
}

/** A device the user paired and granted two projects. */
const CALLER: RemoteCaller = { deviceId: 'dev_phone', projectIds: ['proj_1', 'proj_2'] }
const STRANGER: RemoteCaller = { deviceId: 'dev_other', projectIds: [] }

function sessionFixture(id: string, projectId = 'proj_1'): Session {
  return {
    id,
    projectId,
    title: `Session ${id}`,
    driverKind: 'claude',
    modelId: null,
    permissionMode: 'ask',
    status: 'idle',
    createdAt: 1,
    updatedAt: 1,
  }
}

function sessionCreated(id: string, projectId = 'proj_1'): UnstampedEvent {
  return { type: 'session.created', session: sessionFixture(id, projectId) }
}

/** A real P-256 keypair, signing as the phone's Web Crypto does: DER, SHA-256. */
function deviceKey(): {
  jwk: { kty: 'EC'; crv: 'P-256'; x: string; y: string }
  sign: (nonce: string) => string
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

/** The slice of `Engine` the host uses, recording what it was asked to do. */
interface FakeEngine {
  dispatched: Command[]
  created: Session[]
  dispatch: RemoteHostDeps['engine']['dispatch']
  createSession: RemoteHostDeps['engine']['createSession']
  replaySession: RemoteHostDeps['engine']['replaySession']
  workspace: RemoteHostDeps['engine']['workspace']
}

function fakeEngine(overrides: Partial<FakeEngine> = {}): FakeEngine {
  const dispatched: Command[] = []
  const created: Session[] = []
  return {
    dispatched,
    created,
    dispatch: async (command) => {
      dispatched.push(command)
      return { accepted: true }
    },
    createSession: async (session) => {
      created.push(session)
    },
    replaySession: async () => [],
    workspace: async () => null,
    ...overrides,
  }
}

function hostFor(
  store: SessionStore,
  engine: FakeEngine,
  overrides: Partial<RemoteHostDeps> = {},
): ReturnType<typeof createRemoteHost> {
  return createRemoteHost({
    engine: engine as unknown as RemoteHostDeps['engine'],
    store,
    driverKinds: ['claude', 'codex'] as DriverKind[],
    defaultPermissionMode: () => 'ask',
    defaultDriverKind: () => 'claude',
    hasProject: async () => true,
    listProjects: async () => [{ id: 'proj_1', name: 'Ari' }],
    listModels: async () => [
      { driverKind: 'claude', models: [{ id: 'model-a', label: 'Model A' }] },
      { driverKind: 'codex', models: [] },
    ],
    pairing: new PairingService(),
    mintSessionId: () => 'sess_remote_1',
    ...overrides,
  })
}

/** A catalog whose default provider reports effort levels, as a live desktop's does. */
const EFFORT_MODELS: Awaited<ReturnType<RemoteHostDeps['listModels']>> = [
  {
    driverKind: 'claude',
    models: [{ id: 'model-a', label: 'Model A' }],
    efforts: [
      { id: 'low', label: 'Low' },
      { id: 'high', label: 'High', current: true },
    ],
  },
  { driverKind: 'codex', models: [] },
]

function command(op: RemoteCommand['op'], fields: Record<string, unknown>): RemoteCommand {
  return { op, clientCommandId: 'cmd-1', idempotencyKey: 'idem-0001', ...fields } as RemoteCommand
}

describe('remote host capabilities', () => {
  it('reports only what it can actually serve', async () => {
    const host = hostFor(await tempStore(), fakeEngine())
    const caps = host.capabilities()

    expect(caps).toContain('session.list')
    expect(caps).toContain('session.prompt')
    expect(caps).toContain('approval.respond')
    expect(caps).toContain('events.subscribe')
    expect(caps).toContain('changes.files')
    expect(caps).toContain('changes.diff')
    expect(caps).not.toContain('changes.integrate')
  })

  it('advertises only operations the contract declares', async () => {
    const host = hostFor(await tempStore(), fakeEngine())
    for (const op of host.capabilities()) {
      expect(commandOrReadExists(op)).toBe(true)
    }
  })
})

/** Mirrors the contract's own lists, so a typo in a capability is caught here. */
function commandOrReadExists(op: string): boolean {
  const queries = new Set([
    'gateway.info',
    'session.list',
    'session.get',
    'attention.list',
    'files.list',
    'files.read',
    'project.list',
    'models.list',
    'changes.files',
    'changes.diff',
    'command.status',
    'device.list',
    'device.revoke',
  ])
  const commands = new Set([
    'session.create',
    'session.prompt',
    'session.queue',
    'session.steer',
    'session.interrupt',
    'session.archive',
    'session.update',
    'approval.respond',
    'input.respond',
    'changes.integrate',
  ])
  const overTheWire = new Set(['events.subscribe', 'events.ack', 'events.snapshot'])
  return queries.has(op) || commands.has(op) || overTheWire.has(op)
}

describe('reading sessions', () => {
  it('forks only visible parents and selects providers without carrying another provider model', async () => {
    const store = await tempStore()
    await store.append('sess_a', sessionCreated('sess_a'))
    const fork = vi.fn(async () => ({ ok: true as const, result: { sessionId: 'child' } }))
    const host = hostFor(store, fakeEngine(), { fork })
    expect(host.capabilities()).toContain('session.fork')
    const request = command('session.fork', {
      sessionId: 'sess_a',
      title: 'Task',
      driverKind: 'codex',
    })
    expect(await host.execute(STRANGER, request)).toMatchObject({ ok: false, code: 'not_found' })
    expect(fork).not.toHaveBeenCalled()
    expect(await host.execute(CALLER, request)).toMatchObject({
      ok: true,
      result: { sessionId: 'child' },
    })
    expect(fork).toHaveBeenCalledWith(CALLER.deviceId, { ...request, driverKind: 'codex' })
    expect(
      await host.execute(
        CALLER,
        command('session.fork', { sessionId: 'sess_a', title: 'Task', driverKind: 'gemini' }),
      ),
    ).toMatchObject({ ok: false, code: 'unsupported_capability' })
  })
  it('lists only the sessions in projects this device was granted', async () => {
    const store = await tempStore()
    await store.append('sess_mine', sessionCreated('sess_mine', 'proj_1'))
    await store.append('sess_theirs', sessionCreated('sess_theirs', 'proj_ungranted'))
    const host = hostFor(store, fakeEngine())

    const summaries = await host.listSessions(CALLER)

    expect(summaries.map((s) => s.id)).toEqual(['sess_mine'])
  })

  it('returns a session with the journal high-water mark it was taken at', async () => {
    const store = await tempStore()
    await store.append('sess_a', sessionCreated('sess_a'))
    const host = hostFor(store, fakeEngine())

    const snapshot = await host.getSession(CALLER, 'sess_a')

    expect(snapshot?.session.id).toBe('sess_a')
    expect(snapshot?.summary.id).toBe('sess_a')
    // The mark and the state travel together, or a subscriber resuming from it
    // would see a gap or a duplicate. Journals are 0-based, matching
    // `initialReadModel().lastSeq === -1`.
    expect(snapshot?.seq).toBe(0)
  })

  it('hands the client what is waiting on a human, with the exact choices', async () => {
    const store = await tempStore()
    await store.append('sess_a', sessionCreated('sess_a'))
    await store.append('sess_a', {
      type: 'approval.requested',
      approvalId: 'appr_1',
      toolName: 'Bash',
      summaryJson: '{"command":"rm -rf build"}',
      options: [
        { optionId: 'opt_session', name: 'Allow for this session', kind: 'allow_always' },
        { optionId: 'opt_prefix', name: 'Always allow rm -rf', kind: 'allow_always' },
      ],
    })
    const host = hostFor(store, fakeEngine())

    const snapshot = await host.getSession(CALLER, 'sess_a')

    // A phone opening this session never saw the event that announced the
    // approval. Without this it would render an idle session while the agent
    // sits blocked on an answer.
    expect(snapshot?.pendingApprovals).toHaveLength(1)
    expect(snapshot?.pendingApprovals[0]?.approvalId).toBe('appr_1')
    // Two choices share a kind, so both must survive to the client intact.
    expect(snapshot?.pendingApprovals[0]?.options.map((option) => option.optionId)).toEqual([
      'opt_session',
      'opt_prefix',
    ])
  })

  it('answers undefined for a session that does not exist', async () => {
    const host = hostFor(await tempStore(), fakeEngine())
    expect(await host.getSession(CALLER, 'sess_missing')).toBeUndefined()
  })

  it('answers undefined for a session in a project the device was not granted', async () => {
    const store = await tempStore()
    await store.append('sess_theirs', sessionCreated('sess_theirs', 'proj_ungranted'))
    const host = hostFor(store, fakeEngine())

    // Indistinguishable from "no such session" on purpose: telling a device
    // that a session exists but is someone else's is itself a disclosure.
    expect(await host.getSession(CALLER, 'sess_theirs')).toBeUndefined()
    expect(await host.getSession(STRANGER, 'sess_theirs')).toBeUndefined()
  })

  it('replays only the events after the given sequence', async () => {
    const store = await tempStore()
    await store.append('sess_a', sessionCreated('sess_a'))
    const engine = fakeEngine({
      replaySession: async () => [
        { ...sessionCreated('sess_a'), seq: 1, at: 1, sessionId: 'sess_a' },
      ],
    })
    const host = hostFor(store, engine)

    const replayed = await host.replay(CALLER, 'sess_a', 0)

    expect(replayed?.map((e) => e.seq)).toEqual([1])
  })

  it('refuses to replay a session the device was not granted', async () => {
    const store = await tempStore()
    await store.append('sess_theirs', sessionCreated('sess_theirs', 'proj_ungranted'))
    const host = hostFor(store, fakeEngine())

    expect(await host.replay(CALLER, 'sess_theirs', 0)).toBeUndefined()
  })
})

describe('creating a session', () => {
  it.each(driverKindSchema.options)(
    'uses live registration for %s after background hydration and refuses it again if removed',
    async (driverKind) => {
      const engine = fakeEngine()
      let registered: DriverKind[] = []
      const host = hostFor(await tempStore(), engine, {
        driverKinds: () => registered,
        listModels: async () =>
          driverKindSchema.options.map((kind) => ({
            driverKind: kind,
            models: [],
            available: true,
          })),
      })
      const create = command('session.create', { projectId: 'proj_1', driverKind })
      expect(await host.execute(CALLER, create)).toMatchObject({
        ok: false,
        code: 'unsupported_capability',
      })
      registered = [driverKind]
      expect(await host.execute(CALLER, create)).toMatchObject({ ok: true })
      expect(engine.created[0]).toMatchObject({ driverKind, modelId: null, permissionMode: 'ask' })
      registered = []
      expect(await host.execute(CALLER, create)).toMatchObject({
        ok: false,
        code: 'unsupported_capability',
      })
      expect(engine.created).toHaveLength(1)
    },
  )

  it('uses effective desktop defaults and rechecks availability while preserving arbitrary native IDs', async () => {
    const engine = fakeEngine()
    const providers = [
      {
        driverKind: 'opencode' as const,
        available: true,
        defaultModelId: null,
        models: [{ id: 'default', label: 'CLI default' }],
      },
      {
        driverKind: 'ari-core' as const,
        available: true,
        defaultModelId: 'ep:local:model:latest',
        models: [{ id: 'ep:local:model:latest', label: 'Local' }],
      },
    ]
    const host = hostFor(await tempStore(), engine, {
      driverKinds: () => ['opencode', 'ari-core'],
      defaultDriverKind: () => null,
      listModels: async () => providers,
    })
    expect(await host.query(CALLER, 'models.list', {})).toMatchObject({
      defaults: { driverKind: 'opencode', modelId: null, permissionMode: 'ask' },
    })
    await host.execute(CALLER, command('session.create', { projectId: 'proj_1' }))
    await host.execute(
      CALLER,
      command('session.create', {
        projectId: 'proj_1',
        driverKind: 'opencode',
        modelId: 'default',
      }),
    )
    await host.execute(
      CALLER,
      command('session.create', {
        projectId: 'proj_1',
        driverKind: 'opencode',
        modelId: 'native/custom:model',
      }),
    )
    expect(engine.created.map((row) => row.modelId)).toEqual([null, null, 'native/custom:model'])
    providers[0]!.available = false
    expect(
      await host.execute(
        CALLER,
        command('session.create', { projectId: 'proj_1', driverKind: 'opencode' }),
      ),
    ).toMatchObject({ ok: false })
    await host.execute(CALLER, command('session.create', { projectId: 'proj_1' }))
    expect(engine.created.at(-1)).toMatchObject({
      driverKind: 'ari-core',
      modelId: 'ep:local:model:latest',
    })
  })
  it('uses the desktop default permission mode when the phone does not choose one', async () => {
    const engine = fakeEngine()
    const host = hostFor(await tempStore(), engine, { defaultPermissionMode: () => 'allow-edits' })

    const result = await host.execute(
      CALLER,
      command('session.create', { projectId: 'proj_1', title: 'From the phone' }),
    )

    expect(result).toEqual({ ok: true, result: { sessionId: 'sess_remote_1' } })
    expect(engine.created[0]).toMatchObject({
      id: 'sess_remote_1',
      projectId: 'proj_1',
      title: 'From the phone',
      permissionMode: 'allow-edits',
      driverKind: 'claude',
      status: 'idle',
    })
    expect(engine.created[0]).not.toHaveProperty('effort')
  })

  it('creates a session with the effort and permission mode the phone chose', async () => {
    const engine = fakeEngine()
    const host = hostFor(await tempStore(), engine, { listModels: async () => EFFORT_MODELS })

    const result = await host.execute(
      CALLER,
      command('session.create', { projectId: 'proj_1', permissionMode: 'full', effort: 'high' }),
    )

    expect(result).toMatchObject({ ok: true })
    expect(engine.created[0]).toMatchObject({ permissionMode: 'full', effort: 'high' })
  })

  it('refuses to create a session with an effort the provider does not offer', async () => {
    const engine = fakeEngine()
    const host = hostFor(await tempStore(), engine, { listModels: async () => EFFORT_MODELS })

    expect(
      await host.execute(
        CALLER,
        command('session.create', { projectId: 'proj_1', effort: 'ludicrous' }),
      ),
    ).toMatchObject({ ok: false, code: 'unsupported_capability' })
    expect(engine.created).toEqual([])
  })

  it('refuses a project the device was not granted', async () => {
    const engine = fakeEngine()
    const host = hostFor(await tempStore(), engine)

    const result = await host.execute(
      CALLER,
      command('session.create', { projectId: 'proj_ungranted' }),
    )

    expect(result).toMatchObject({ ok: false, code: 'not_found' })
    // A project id is caller-supplied, so it is checked against the grant
    // before it is checked against the disk.
    expect(engine.created).toEqual([])
  })

  it('refuses a project that does not exist', async () => {
    const engine = fakeEngine()
    const host = hostFor(await tempStore(), engine, { hasProject: async () => false })

    const result = await host.execute(CALLER, command('session.create', { projectId: 'proj_1' }))

    expect(result).toMatchObject({ ok: false, code: 'not_found' })
    // No half-made session in a workspace that is not there.
    expect(engine.created).toEqual([])
  })

  it('refuses a driver the desktop cannot run', async () => {
    const engine = fakeEngine()
    const host = hostFor(await tempStore(), engine, { driverKinds: ['claude'] as DriverKind[] })

    const result = await host.execute(
      CALLER,
      command('session.create', { projectId: 'proj_1', driverKind: 'codex' }),
    )

    expect(result).toMatchObject({ ok: false, code: 'unsupported_capability' })
    expect(engine.created).toEqual([])
  })
})

describe('agent actions', () => {
  async function grantedHost(
    overrides: Partial<RemoteHostDeps> = {},
  ): Promise<{ host: ReturnType<typeof createRemoteHost>; engine: FakeEngine }> {
    const store = await tempStore()
    await store.append('sess_a', sessionCreated('sess_a'))
    const engine = fakeEngine()
    return { host: hostFor(store, engine, overrides), engine }
  }

  it('maps each remote command onto the engine command it names', async () => {
    const { host, engine } = await grantedHost()

    await host.execute(CALLER, command('session.prompt', { sessionId: 'sess_a', text: 'hello' }))
    await host.execute(CALLER, command('session.queue', { sessionId: 'sess_a', text: 'later' }))
    await host.execute(CALLER, command('session.steer', { sessionId: 'sess_a', text: 'stop' }))
    await host.execute(CALLER, command('session.interrupt', { sessionId: 'sess_a' }))
    await host.execute(CALLER, command('session.archive', { sessionId: 'sess_a' }))
    await host.execute(
      CALLER,
      command('approval.respond', {
        sessionId: 'sess_a',
        approvalId: 'ap_1',
        optionId: 'opt_allow',
      }),
    )
    await host.execute(
      CALLER,
      command('input.respond', { sessionId: 'sess_a', inputId: 'in_1', value: 'yes' }),
    )

    expect(engine.dispatched).toEqual([
      { type: 'turn.start', sessionId: 'sess_a', text: 'hello', attachments: [] },
      { type: 'message.enqueue', sessionId: 'sess_a', text: 'later', attachments: [] },
      { type: 'message.steer', sessionId: 'sess_a', text: 'stop', attachments: [] },
      { type: 'turn.interrupt', sessionId: 'sess_a' },
      { type: 'session.update', sessionId: 'sess_a', archived: true },
      // The exact option the provider offered, never re-expanded from a kind.
      { type: 'approval.respond', sessionId: 'sess_a', approvalId: 'ap_1', optionId: 'opt_allow' },
      { type: 'input.respond', sessionId: 'sess_a', inputId: 'in_1', value: 'yes' },
    ])
  })

  it('refuses a command naming a session that does not exist', async () => {
    const { host, engine } = await grantedHost()

    const result = await host.execute(
      CALLER,
      command('session.prompt', { sessionId: 'sess_nope', text: 'hi' }),
    )

    expect(result).toMatchObject({ ok: false, code: 'not_found' })
    expect(engine.dispatched).toEqual([])
  })

  it('refuses every action on a session in a project the device was not granted', async () => {
    const store = await tempStore()
    await store.append('sess_theirs', sessionCreated('sess_theirs', 'proj_ungranted'))
    const engine = fakeEngine()
    const host = hostFor(store, engine)

    for (const op of [
      'session.prompt',
      'session.queue',
      'session.steer',
      'session.interrupt',
      'session.archive',
    ] as const) {
      const result = await host.execute(
        CALLER,
        command(op, { sessionId: 'sess_theirs', text: 'x', approvalId: 'a', optionId: 'o' }),
      )
      expect(result).toMatchObject({ ok: false, code: 'not_found' })
    }

    expect(engine.dispatched).toEqual([])
  })

  it('reports an engine refusal rather than claiming success', async () => {
    const { host } = await grantedHost({
      engine: fakeEngine({
        dispatch: async () => ({ accepted: false, reason: 'a turn is already running' }),
      }) as unknown as RemoteHostDeps['engine'],
    })

    const result = await host.execute(
      CALLER,
      command('session.prompt', { sessionId: 'sess_a', text: 'hi' }),
    )

    expect(result).toMatchObject({ ok: false, message: 'a turn is already running' })
  })

  it('refuses an integration this desktop cannot perform', async () => {
    const { host, engine } = await grantedHost()

    const result = await host.execute(
      CALLER,
      command('changes.integrate', {
        sessionId: 'sess_a',
        snapshotCommit: 'a'.repeat(40),
        expectedParentSnapshot: 'b'.repeat(40),
      }),
    )

    // The contract declares the operation; this host does not serve it. The
    // refusal has to be explicit — a `never` arm would only prove it at
    // compile time, and `changes.integrate` reaching a host that cannot
    // integrate must not look like success.
    expect(result).toMatchObject({ ok: false, code: 'unsupported_capability' })
    expect(engine.dispatched).toEqual([])
  })
})

describe('devices', () => {
  async function withDevice(): Promise<{
    host: ReturnType<typeof createRemoteHost>
    pairing: PairingService
    deviceId: string
  }> {
    const pairing = new PairingService()
    const key = deviceKey()
    const invitation = pairing.begin('http://127.0.0.1:1')
    const registered = pairing.request(invitation.invitationId, {
      displayName: 'Phone',
      publicKey: key.jwk,
    })
    if (!registered.ok) throw new Error(`registration refused: ${registered.code}`)
    pairing.approve(
      invitation.invitationId,
      pairing.pending(invitation.invitationId)?.confirmationCode ?? '',
      ['proj_1'],
    )
    // A device record exists only once the key has proved possession of itself,
    // so the invite has to be redeemed before there is anything to list — by
    // signing the nonce the server issued, not one the phone chose.
    const redeemed = pairing.redeem(invitation.invitationId, {
      nonce: registered.nonce,
      signature: key.sign(registered.nonce),
    })
    if (!redeemed.ok) throw new Error(`redemption refused: ${redeemed.code}`)
    return {
      host: hostFor(await tempStore(), fakeEngine(), { pairing }),
      pairing,
      deviceId: redeemed.device.deviceId,
    }
  }

  it('lists paired devices with what they were granted', async () => {
    const { host } = await withDevice()

    const devices = (await host.query(CALLER, 'device.list', {})) as {
      deviceId: string
      displayName: string
      projectIds: string[]
    }[]

    expect(devices).toHaveLength(1)
    expect(devices[0]?.displayName).toBe('Phone')
    expect(devices[0]?.projectIds).toEqual(['proj_1'])
  })

  it('revokes a device by id', async () => {
    const { host, deviceId } = await withDevice()
    expect(host.capabilities()).toContain('device.revoke')

    const result = (await host.query(CALLER, 'device.revoke', { deviceId })) as {
      revoked: boolean
    }

    expect(result.revoked).toBe(true)
    expect(await host.query(CALLER, 'device.list', {})).toEqual([])
  })

  it('reports a revoke that named no device as a non-event', async () => {
    const { host } = await withDevice()
    const result = (await host.query(CALLER, 'device.revoke', { deviceId: 'dev_none' })) as {
      revoked: boolean
    }
    expect(result.revoked).toBe(false)
  })
})

describe('session changes', () => {
  const DIFF = [
    'diff --git a/a.txt b/a.txt',
    '--- a/a.txt',
    '+++ b/a.txt',
    '@@ -1 +1 @@',
    '-old',
    '+new',
    'diff --git a/b.txt b/b.txt',
    '--- a/b.txt',
    '+++ b/b.txt',
    '@@ -1 +1 @@',
    '-gone',
    '+here',
  ].join('\n')

  interface GitStubs {
    /** Repo top the stub reports; 'auto' answers the workspace itself. */
    toplevel: string
    diff?: string
    untracked?: string[]
  }

  /** A workspace that is a real directory, with git hidden behind stubs. */
  async function changedHost(
    stubs: GitStubs,
    sessionId = 'sess_a',
    workspaceOverride?: string,
  ): Promise<{ host: ReturnType<typeof createRemoteHost>; workspace: string }> {
    const store = await tempStore()
    await store.append(sessionId, sessionCreated(sessionId))
    const workspace = workspaceOverride ?? (await mkdtemp(join(tmpdir(), 'ari-remote-changes-')))
    roots.push(workspace)
    const engine = fakeEngine({ workspace: async () => workspace })
    vi.spyOn(GitService.prototype, 'runPlumbing').mockImplementation(async (cwd, args) => {
      if (args.includes('rev-parse')) {
        const top = stubs.toplevel === 'auto' ? String(cwd) : stubs.toplevel
        return ok({ stdout: `${top}\n` })
      }
      if (stubs.diff === undefined) return err({ code: 'output_overflow', message: 'too big' })
      return ok({ stdout: stubs.diff })
    })
    vi.spyOn(GitService.prototype, 'status').mockImplementation(async () => {
      await Promise.resolve()
      return ok({
        branch: 'main',
        files: (stubs.untracked ?? []).map((path) => ({
          path,
          staged: false,
          kind: 'untracked' as const,
        })),
      })
    })
    return { host: hostFor(store, engine), workspace }
  }

  it('answers null for a session the device was not granted', async () => {
    const store = await tempStore()
    await store.append('sess_theirs', sessionCreated('sess_theirs', 'proj_ungranted'))
    const host = hostFor(store, fakeEngine())

    expect(await host.query(CALLER, 'changes.files', { sessionId: 'sess_theirs' })).toBeNull()
    expect(
      await host.query(CALLER, 'changes.diff', { sessionId: 'sess_theirs', path: 'a.txt' }),
    ).toBeNull()
  })

  it('reports unavailable when the session has no workspace', async () => {
    const store = await tempStore()
    await store.append('sess_a', sessionCreated('sess_a'))
    const host = hostFor(store, fakeEngine())

    const files = (await host.query(CALLER, 'changes.files', { sessionId: 'sess_a' })) as {
      error: string | null
    }

    expect(files.error).toMatch(/unavailable/)
  })

  it('reports unavailable when the workspace left its repo', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'ari-remote-elsewhere-'))
    roots.push(outside)
    const { host, workspace } = await changedHost({ toplevel: outside, diff: DIFF })

    const files = (await host.query(CALLER, 'changes.files', { sessionId: 'sess_a' })) as {
      error: string | null
    }

    expect(workspace).not.toBe(outside)
    expect(files.error).toMatch(/unavailable/)
  })

  it('lists files without hunks and serves one file with them', async () => {
    const { host } = await changedHost({ toplevel: 'auto', diff: DIFF })

    const files = await host.query(CALLER, 'changes.files', { sessionId: 'sess_a' })
    expect(remoteChangesSchema.safeParse(files).success).toBe(true)
    expect(files).toMatchObject({
      base: 'workspace-head',
      error: null,
      files: [{ path: 'a.txt' }, { path: 'b.txt' }],
    })
    // Hunks travel only with the single-file read, not the list.
    for (const file of (files as { files: Record<string, unknown>[] }).files) {
      expect(file).not.toHaveProperty('hunks')
    }

    const one = (await host.query(CALLER, 'changes.diff', {
      sessionId: 'sess_a',
      path: 'a.txt',
    })) as { file: { path: string; hunks: { header: string }[] } | null; error: string | null }
    expect(one.error).toBeNull()
    expect(one.file?.path).toBe('a.txt')
    expect(one.file?.hunks[0]?.header).toContain('@@ -1 +1 @@')

    const missing = (await host.query(CALLER, 'changes.diff', {
      sessionId: 'sess_a',
      path: 'nope.txt',
    })) as { file: null; error: string | null }
    expect(missing.file).toBeNull()
    expect(missing.error).toBeNull()
  })

  it('names an untracked file with no hunks to preview', async () => {
    const { host } = await changedHost({ toplevel: 'auto', diff: DIFF, untracked: ['new.txt'] })

    const files = (await host.query(CALLER, 'changes.files', { sessionId: 'sess_a' })) as {
      files: { path: string; isNew?: boolean }[]
    }

    expect(files.files.map((file) => file.path)).toEqual(['a.txt', 'b.txt', 'new.txt'])
    const one = (await host.query(CALLER, 'changes.diff', {
      sessionId: 'sess_a',
      path: 'new.txt',
    })) as { file: { hunks: unknown[] } | null }
    expect(one.file?.hunks).toEqual([])
  })

  it('says the diff was too large instead of failing the query', async () => {
    const { host } = await changedHost({ toplevel: 'auto' })

    const files = (await host.query(CALLER, 'changes.files', { sessionId: 'sess_a' })) as {
      error: string | null
    }

    expect(files.error).toMatch(/size limit/)
  })

  it('reads a subdirectory of the repo, not only its top', async () => {
    const top = await mkdtemp(join(tmpdir(), 'ari-remote-repo-'))
    roots.push(top)
    const sub = join(top, 'packages', 'app')
    await mkdir(sub, { recursive: true })
    const { host } = await changedHost({ toplevel: top, diff: DIFF }, 'sess_a', sub)

    const files = (await host.query(CALLER, 'changes.files', { sessionId: 'sess_a' })) as {
      files: unknown[]
      error: string | null
    }

    expect(files.error).toBeNull()
    expect(files.files).toHaveLength(2)
  })
})

describe('model catalog', () => {
  it('keeps native aliases and defaults usable for model updates and isolated forks', async () => {
    const store = await tempStore()
    await store.append('sess_a', sessionCreated('sess_a'))
    await store.append('sess_core', {
      type: 'session.created',
      session: { ...sessionFixture('sess_core'), driverKind: 'ari-core', modelId: 'ep:local' },
    })
    const engine = fakeEngine()
    const fork = vi.fn(async () => ({ ok: true as const, result: { sessionId: 'child' } }))
    const host = hostFor(store, engine, {
      driverKinds: () => ['claude', 'ari-core'],
      fork,
      listModels: async () => [
        {
          driverKind: 'claude',
          available: true,
          models: [{ id: 'claude-opus-current', label: 'Opus', aliases: ['opus'] }],
        },
        {
          driverKind: 'ari-core',
          available: true,
          defaultModelId: 'ep:local:model',
          models: [{ id: 'ep:local:model', label: 'Local', aliases: ['ep:local', 'local'] }],
        },
      ],
    })
    expect(
      await host.execute(
        CALLER,
        command('session.update', { sessionId: 'sess_a', modelId: 'opus' }),
      ),
    ).toMatchObject({ ok: true })
    expect(
      await host.execute(
        CALLER,
        command('session.update', { sessionId: 'sess_a', modelId: 'default' }),
      ),
    ).toMatchObject({ ok: true })
    expect(
      await host.execute(
        CALLER,
        command('session.update', { sessionId: 'sess_core', modelId: null }),
      ),
    ).toMatchObject({ ok: true })
    expect(engine.dispatched).toEqual([
      { type: 'session.update', sessionId: 'sess_a', modelId: 'opus' },
      { type: 'session.update', sessionId: 'sess_a', modelId: null },
      { type: 'session.update', sessionId: 'sess_core', modelId: 'ep:local:model' },
    ])
    await host.execute(
      CALLER,
      command('session.fork', { sessionId: 'sess_a', title: 'Alias', modelId: 'opus' }),
    )
    expect(fork).toHaveBeenLastCalledWith(
      CALLER.deviceId,
      expect.objectContaining({ modelId: 'claude-opus-current' }),
    )
    await host.execute(
      CALLER,
      command('session.fork', { sessionId: 'sess_a', title: 'Default', modelId: 'default' }),
    )
    expect(
      (fork.mock.calls.at(-1) as unknown as [string, Record<string, unknown>])[1]['modelId'],
    ).toBeUndefined()
    await host.execute(
      CALLER,
      command('session.fork', { sessionId: 'sess_core', title: 'Endpoint default' }),
    )
    expect(fork).toHaveBeenLastCalledWith(
      CALLER.deviceId,
      expect.objectContaining({ modelId: 'ep:local:model' }),
    )
  })
  it('serves the providers with their catalog models', async () => {
    const host = hostFor(await tempStore(), fakeEngine())

    expect(host.capabilities()).toContain('models.list')
    const catalog = await host.query(CALLER, 'models.list', {})

    expect(remoteModelCatalogSchema.safeParse(catalog).success).toBe(true)
    expect(catalog).toEqual({
      defaults: {
        driverKind: 'claude',
        modelId: null,
        permissionMode: 'ask',
        configuredDriverKind: 'claude',
      },
      providers: [
        { driverKind: 'claude', available: true, models: [{ id: 'model-a', label: 'Model A' }] },
        { driverKind: 'codex', available: true, models: [] },
      ],
    })
  })
})

describe('event subscription', () => {
  it('forwards only the subscribed session and stops after unsubscribe', async () => {
    const store = await tempStore()
    const host = hostFor(store, fakeEngine())
    const seen: string[] = []
    const unsubscribe = host.subscribe(CALLER, 'sess_a', (event) => seen.push(event.sessionId))

    await store.append('sess_a', { type: 'session.updated', title: 'mine' })
    await store.append('sess_b', { type: 'session.updated', title: 'not mine' })
    unsubscribe()
    await store.append('sess_a', { type: 'session.updated', title: 'after' })

    expect(seen).toEqual(['sess_a'])
  })
})

describe('mobile workspace capabilities', () => {
  it('finds attention across every granted session and paginates without including other projects', async () => {
    const store = await tempStore()
    for (let i = 0; i < 16; i++)
      await store.append(
        `sess_${String(i).padStart(2, '0')}`,
        sessionCreated(`sess_${String(i).padStart(2, '0')}`),
      )
    await store.append('sess_14', {
      type: 'approval.requested',
      approvalId: 'a',
      toolName: 'Bash',
      summaryJson: '{}',
      options: [{ optionId: 'exact', name: 'Allow once', kind: 'allow_once' }],
    })
    await store.append('sess_15', {
      type: 'input.requested',
      inputId: 'q',
      prompt: 'Which branch?',
      choicesJson: '["main"]',
    })
    await store.append('sess_secret', sessionCreated('sess_secret', 'proj_ungranted'))
    await store.append('sess_secret', {
      type: 'approval.requested',
      approvalId: 'secret',
      toolName: 'Bash',
      summaryJson: '{}',
      options: [],
    })
    const host = hostFor(store, fakeEngine())
    const first = await host.query(CALLER, 'attention.list', { limit: 1 })
    expect(remoteAttentionSchema.safeParse(first).success).toBe(true)
    expect(first).toMatchObject({
      items: [{ sessionId: 'sess_14', pendingApprovals: [{ options: [{ optionId: 'exact' }] }] }],
      nextCursor: 'sess_14',
    })
    expect(
      await host.query(CALLER, 'attention.list', { cursor: 'sess_14', limit: 1 }),
    ).toMatchObject({
      items: [{ sessionId: 'sess_15', pendingInputs: [{ inputId: 'q' }] }],
      nextCursor: null,
    })
    expect(await host.query(STRANGER, 'attention.list', {})).toEqual({
      items: [],
      nextCursor: null,
    })
  })

  it('reads files only from the authorized session workspace', async () => {
    const store = await tempStore()
    const root = await mkdtemp(join(tmpdir(), 'ari-remote-scope-'))
    roots.push(root)
    await writeFile(join(root, 'code.ts'), 'const scoped = true')
    await store.append('sess_a', sessionCreated('sess_a'))
    const engine = fakeEngine({ workspace: async () => root })
    const host = hostFor(store, engine)
    expect(
      await host.query(CALLER, 'files.read', { sessionId: 'sess_a', path: 'code.ts' }),
    ).toMatchObject({ content: 'const scoped = true' })
    expect(
      await host.query(STRANGER, 'files.read', { sessionId: 'sess_a', path: 'code.ts' }),
    ).toBeNull()
    expect(await host.query(STRANGER, 'files.list', { sessionId: 'sess_a' })).toBeNull()
  })

  it('changes effort and permission mode on a session', async () => {
    const store = await tempStore()
    await store.append('sess_a', sessionCreated('sess_a'))
    const engine = fakeEngine()
    const host = hostFor(store, engine, { listModels: async () => EFFORT_MODELS })

    expect(
      await host.execute(
        CALLER,
        command('session.update', { sessionId: 'sess_a', permissionMode: 'full', effort: 'low' }),
      ),
    ).toMatchObject({ ok: true })
    expect(
      await host.execute(CALLER, command('session.update', { sessionId: 'sess_a', effort: null })),
    ).toMatchObject({ ok: true })
    expect(engine.dispatched).toEqual([
      { type: 'session.update', sessionId: 'sess_a', permissionMode: 'full', effort: 'low' },
      { type: 'session.update', sessionId: 'sess_a', effort: null },
    ])
  })

  it('refuses an effort the session provider does not offer', async () => {
    const store = await tempStore()
    await store.append('sess_a', sessionCreated('sess_a'))
    const engine = fakeEngine()
    const host = hostFor(store, engine, { listModels: async () => EFFORT_MODELS })

    expect(
      await host.execute(
        CALLER,
        command('session.update', { sessionId: 'sess_a', effort: 'ludicrous' }),
      ),
    ).toMatchObject({ ok: false, code: 'unsupported_capability' })
    expect(engine.dispatched).toEqual([])
  })

  it('accepts an effort only the selected model offers', async () => {
    const store = await tempStore()
    await store.append('sess_a', sessionCreated('sess_a'))
    const engine = fakeEngine()
    const asked: unknown[] = []
    const host = hostFor(store, engine, {
      effortsForModel: async (kind, modelId) => {
        asked.push([kind, modelId])
        return [{ id: 'max', label: 'Max' }]
      },
    })

    expect(host.capabilities()).toContain('models.efforts')
    expect(
      await host.query(CALLER, 'models.efforts', { driverKind: 'claude', modelId: 'model-a' }),
    ).toEqual({ efforts: [{ id: 'max', label: 'Max' }] })
    expect(
      await host.execute(CALLER, command('session.update', { sessionId: 'sess_a', effort: 'max' })),
    ).toMatchObject({ ok: true })
    expect(asked).toEqual([
      ['claude', 'model-a'],
      ['claude', null],
    ])
  })

  it('does not offer the per-model lookup when the desktop cannot perform it', async () => {
    expect(hostFor(await tempStore(), fakeEngine()).capabilities()).not.toContain('models.efforts')
  })

  it('validates model changes and maps only allowed session updates', async () => {
    const store = await tempStore()
    await store.append('sess_a', sessionCreated('sess_a'))
    const engine = fakeEngine()
    const host = hostFor(store, engine)
    expect(
      await host.execute(
        CALLER,
        command('session.update', {
          sessionId: 'sess_a',
          title: 'New title',
          pinned: true,
          modelId: 'model-a',
        }),
      ),
    ).toMatchObject({ ok: true })
    expect(engine.dispatched).toEqual([
      {
        type: 'session.update',
        sessionId: 'sess_a',
        title: 'New title',
        pinned: true,
        modelId: 'model-a',
      },
    ])
    expect(
      await host.execute(
        CALLER,
        command('session.update', { sessionId: 'sess_a', modelId: 'invented-model' }),
      ),
    ).toMatchObject({ ok: false, code: 'unsupported_capability' })
    expect(
      await host.execute(
        STRANGER,
        command('session.update', { sessionId: 'sess_a', pinned: true }),
      ),
    ).toMatchObject({ ok: false, code: 'not_found' })
    for (const path of ['../secret', '/etc/passwd', 'C:\\Windows', 'x:stream']) {
      expect(
        remoteQuerySchema.safeParse({ op: 'files.read', sessionId: 'sess_a', path }).success,
      ).toBe(false)
    }
  })

  it('stages verified raster images for one device/session and resolves authorized prompt references', async () => {
    const store = await tempStore()
    await store.append('sess_a', sessionCreated('sess_a'))
    await store.append('sess_b', sessionCreated('sess_b'))
    const root = await mkdtemp(join(tmpdir(), 'ari-remote-images-'))
    roots.push(root)
    const attachments = new AttachmentStore(root)
    const engine = fakeEngine()
    const host = hostFor(store, engine, { attachments })
    const image = {
      name: 'screen.png',
      mimeType: 'image/png',
      dataBase64:
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==',
    }
    const staged = await host.execute(
      CALLER,
      command('attachments.stage', { sessionId: 'sess_a', files: [image] }),
    )
    expect(staged.ok).toBe(true)
    const refs = (staged as { result: { attachments: { id: string; name: string }[] } }).result
      .attachments
    const id = refs[0]?.id
    expect(
      await host.query(CALLER, 'attachments.read', { sessionId: 'sess_a', attachmentId: id }),
    ).toMatchObject({ attachment: { dataBase64: image.dataBase64 }, error: null })
    const peer = { ...CALLER, deviceId: 'another_phone' }
    expect(
      await host.query(peer, 'attachments.read', { sessionId: 'sess_a', attachmentId: id }),
    ).toMatchObject({ attachment: null })
    expect(
      await host.query(CALLER, 'attachments.read', { sessionId: 'sess_b', attachmentId: id }),
    ).toMatchObject({ attachment: null })
    expect(
      await host.execute(
        CALLER,
        command('session.prompt', { sessionId: 'sess_b', text: 'look', attachmentIds: [id] }),
      ),
    ).toMatchObject({ ok: false, code: 'not_found' })
    expect(
      await host.execute(
        CALLER,
        command('session.prompt', { sessionId: 'sess_a', text: '', attachmentIds: [id] }),
      ),
    ).toMatchObject({ ok: true })
    expect(engine.dispatched[0]).toMatchObject({ type: 'turn.start', text: '', attachments: refs })
    expect(
      await host.execute(
        CALLER,
        command('attachments.stage', {
          sessionId: 'sess_a',
          files: [{ ...image, dataBase64: 'aGVsbG8=' }],
        }),
      ),
    ).toMatchObject({ ok: false })
    expect(
      await host.execute(
        STRANGER,
        command('attachments.stage', { sessionId: 'sess_a', files: [image] }),
      ),
    ).toMatchObject({ ok: false, code: 'not_found' })
    expect(
      await host.execute(CALLER, command('session.prompt', { sessionId: 'sess_a', text: ' ' })),
    ).toMatchObject({ ok: false })
    await store.append('sess_a', {
      type: 'user.message.added',
      message: {
        id: 'm',
        sessionId: 'sess_a',
        turnId: null,
        role: 'user',
        parts: [
          {
            type: 'image',
            attachmentId: String(id),
            name: image.name,
            mimeType: image.mimeType,
            size: Buffer.from(image.dataBase64, 'base64').length,
          },
        ],
        createdAt: 1,
      },
    })
    const afterRestart = hostFor(store, engine, { attachments })
    expect(
      await afterRestart.query(peer, 'attachments.read', { sessionId: 'sess_a', attachmentId: id }),
    ).toMatchObject({ attachment: { name: image.name } })
  })
})
