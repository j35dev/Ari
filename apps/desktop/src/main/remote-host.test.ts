import { generateKeyPairSync, sign } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionStore } from '@ari/engine/session-store'
import type { DriverKind } from '@ari/contracts/common'
import type { Command } from '@ari/contracts/commands'
import type { RemoteCommand } from '@ari/contracts/remote'
import type { Session } from '@ari/contracts/session'
import type { UnstampedEvent } from '@ari/engine/projection'
import type { RemoteCaller } from '@ari/remote-gateway/host'
import { PairingService } from '@ari/remote-gateway/pairing'
import { createRemoteHost, type RemoteHostDeps } from './remote-host'

const roots: string[] = []

afterEach(async () => {
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
    pairing: new PairingService(),
    mintSessionId: () => 'sess_remote_1',
    ...overrides,
  })
}

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
    // Nothing here has an implementation yet, and a capability a client can see
    // is a promise the host has to keep.
    expect(caps).not.toContain('changes.files')
    expect(caps).not.toContain('changes.diff')
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
    'project.list',
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
    'approval.respond',
    'input.respond',
    'changes.integrate',
  ])
  const overTheWire = new Set(['events.subscribe', 'events.ack', 'events.snapshot'])
  return queries.has(op) || commands.has(op) || overTheWire.has(op)
}

describe('reading sessions', () => {
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
  it('takes the permission mode from the desktop, never from the caller', async () => {
    const engine = fakeEngine()
    // The ceiling the user set. A remote client has no way to name this — the
    // strict envelope has no such field — so the host's own setting is the only
    // correct source.
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

    for (const op of ['session.prompt', 'session.queue', 'session.steer', 'session.interrupt', 'session.archive'] as const) {
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
      command('changes.integrate', { sessionId: 'sess_a', snapshotCommit: 'a'.repeat(40) }),
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
    pairing.approve(invitation.invitationId, ['proj_1'])
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
