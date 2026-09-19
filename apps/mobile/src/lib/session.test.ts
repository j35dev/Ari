import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRemoteGateway, type RemoteGateway } from '@ari/remote-gateway/gateway'
import { PairingService } from '@ari/remote-gateway/pairing'
import type { RemoteCaller, RemoteHost } from '@ari/remote-gateway/host'
import type { RemoteOperation } from '@ari/contracts/remote'
import { sessionIdOf } from './command-result'
import { DeviceKeyring, MemoryDeviceStore } from './device-key'
import { GatewayClient } from './gateway-client'
import { MobileSession } from './session'

/**
 * The mobile client against the real gateway, over real sockets.
 *
 * Not a mock: the wire format, the origin check, the nonce binding and the DER
 * signature encoding are all exercised together, which is the only way a
 * mismatch between the two ends shows up as a failing test instead of as a
 * phone that will not pair.
 */

const ALLOWED = 'https://ari.tailnet.ts.net'

const running: RemoteGateway[] = []
afterEach(async () => {
  await Promise.all(running.splice(0).map((gateway) => gateway.close()))
})

type RecordingHost = RemoteHost & {
  executed: { op: string }[]
  callers: RemoteCaller[]
}

/** A host that records what it was asked to do, and as whom. */
function fakeHost(options: { withChanges?: boolean } = {}): RecordingHost {
  const executed: { op: string }[] = []
  const callers: RemoteCaller[] = []
  const capabilities: RemoteOperation[] = [
    'session.list',
    'session.create',
    'session.prompt',
    'events.subscribe',
  ]
  if (options.withChanges === true) capabilities.push('changes.files', 'changes.diff')
  return {
    executed,
    callers,
    capabilities: () => capabilities,
    listSessions: async (caller) => {
      callers.push(caller)
      return []
    },
    listProjects: async () => [],
    getSession: async () => undefined,
    replay: async () => [],
    query: async (caller, op, params) => {
      callers.push(caller)
      if (op === 'changes.files') {
        return { files: [{ path: 'a.txt' }], base: 'workspace-head', error: null }
      }
      if (op === 'changes.diff') {
        const path = (params as { path?: string }).path
        return {
          file:
            path === 'a.txt'
              ? {
                  path: 'a.txt',
                  hunks: [{ header: '@@ -1 +1 @@', lines: [{ type: 'del', content: 'old' }] }],
                }
              : null,
          error: null,
        }
      }
      return { op, sessions: [] }
    },
    subscribe: () => () => {},
    execute: async (caller, command) => {
      callers.push(caller)
      executed.push({ op: command.op })
      if (command.op === 'session.create') {
        return { ok: true, result: { sessionId: 'sess_new' } }
      }
      return { ok: true, result: { accepted: true } }
    },
  }
}

/**
 * Node's fetch sends no `Origin` and a browser will not let script set one, so
 * the test supplies what the browser would and nothing else.
 */
function browserFetch(options: { loseFirstMutation?: boolean } = {}): typeof fetch {
  let lost = false
  return async (input, init) => {
    const headers = new Headers(init?.headers)
    headers.set('origin', ALLOWED)
    const response = await fetch(input, { ...init, headers })
    if (options.loseFirstMutation === true && !lost && response.url.includes('/command')) {
      // The mutation reaches the desktop and its answer is lost on the way
      // back — the exact case that makes a naive client prompt an agent twice.
      lost = true
      await response.text()
      throw new TypeError('network connection lost')
    }
    return response
  }
}

async function startGateway(
  host: RemoteHost = fakeHost(),
  pairing?: PairingService,
): Promise<RemoteGateway> {
  const gateway = await createRemoteGateway({
    host,
    allowedOrigins: [ALLOWED],
    port: 0,
    ...(pairing === undefined ? {} : { pairing }),
  })
  running.push(gateway)
  return gateway
}

/** A session whose client reaches the loopback listener the phone cannot see. */
function sessionFor(
  gateway: RemoteGateway,
  keyring: DeviceKeyring,
  fetchImpl: typeof fetch = browserFetch(),
): MobileSession {
  return new MobileSession({
    client: new GatewayClient({ origin: gateway.origin, fetch: fetchImpl }),
    keyring,
    // The real flow waits for a person to tap Approve on the desktop; these
    // tests tap it in the statement after the next one.
    decisionPollMs: 2,
    decisionTimeoutMs: 2000,
    connectRetryMs: 1,
  })
}

/** Walks a phone through pairing against a gateway, as the user would. */
async function pairPhone(gateway: RemoteGateway, keyring: DeviceKeyring): Promise<MobileSession> {
  const session = sessionFor(gateway, keyring)
  const invitation = gateway.pairing.begin(gateway.origin)
  const pairing = session.pair(invitation.invitationId, 'Pixel 9')
  // The desktop's approval is what completes a pairing, so the phone waits
  // for it rather than redeeming the moment it has registered a key.
  await vi.waitFor(() => expect(gateway.pairing.pending(invitation.invitationId)).toBeDefined())
  expect(gateway.pairing.approve(invitation.invitationId, ['proj_1'])).toEqual({ ok: true })
  await pairing
  return session
}

describe('mobile pairing', () => {
  it('pairs with an invitation the desktop approved, and talks from then on', async () => {
    const host = fakeHost()
    const gateway = await startGateway(host)
    const keyring = new DeviceKeyring(new MemoryDeviceStore())

    const session = await pairPhone(gateway, keyring)

    expect(session.state).toBe('connected')
    expect(keyring.deviceId).toMatch(/^dev_/)
    // The user's approval is what carried the project grant, and it reached
    // the host with the call.
    await session.query('session.list')
    expect(host.callers[0]?.projectIds).toEqual(['proj_1'])
  })

  it('refuses an invitation the desktop denied', async () => {
    const gateway = await startGateway()
    const keyring = new DeviceKeyring(new MemoryDeviceStore())
    const session = sessionFor(gateway, keyring)

    const invitation = gateway.pairing.begin(gateway.origin)
    const pairing = session.pair(invitation.invitationId, 'Pixel 9')
    await vi.waitFor(() => expect(gateway.pairing.pending(invitation.invitationId)).toBeDefined())
    gateway.pairing.deny(invitation.invitationId)

    await expect(pairing).rejects.toMatchObject({ code: 'pairing_denied' })
    expect(keyring.deviceId).toBeNull()
  })
})

describe('mobile reconnection', () => {
  it('comes back with a signature after the desktop restarts', async () => {
    const first = await startGateway()
    const store = new MemoryDeviceStore()
    await pairPhone(first, new DeviceKeyring(store))

    // A restart: the device records were written down, the tokens were not.
    const restarted = await startGateway(
      fakeHost(),
      new PairingService({ restored: first.pairing.toPersisted() }),
    )
    const session = sessionFor(restarted, new DeviceKeyring(store))

    await expect(session.connect()).resolves.toBe('connected')
    expect(restarted.pairing.devices()).toHaveLength(1)
  })

  it('rides out a cold tailnet instead of stranding the launch', async () => {
    const gateway = await startGateway()
    const store = new MemoryDeviceStore()
    await pairPhone(gateway, new DeviceKeyring(store))

    // The phone's network is up before the tailnet is: the first attempt
    // fails, and the launch must survive it rather than land on "not
    // connected" with no way back.
    let attempts = 0
    const flaky = (async (input: unknown, init?: unknown) => {
      attempts++
      if (attempts === 1) throw new TypeError('network connection lost')
      return browserFetch()(input as never, init as never)
    }) as unknown as typeof fetch
    const session = sessionFor(gateway, new DeviceKeyring(store), flaky)

    await expect(session.connect()).resolves.toBe('connected')
    expect(attempts).toBeGreaterThan(1)
  })

  it('does not retry a refusal the desktop made on purpose', async () => {
    const gateway = await startGateway()
    const store = new MemoryDeviceStore()
    await pairPhone(gateway, new DeviceKeyring(store))
    const deviceId = gateway.pairing.devices()[0]?.deviceId
    if (deviceId === undefined) throw new Error('expected a paired device')
    gateway.pairing.revoke(deviceId)

    let attempts = 0
    const counting = (async (input: unknown, init?: unknown) => {
      attempts++
      return browserFetch()(input as never, init as never)
    }) as unknown as typeof fetch
    const session = sessionFor(gateway, new DeviceKeyring(store), counting)

    await expect(session.connect()).resolves.toBe('revoked')
    // info, challenge, then the authorization that reports the revocation:
    // nothing after the refusal.
    expect(attempts).toBe(3)
  })

  it('reports a revoked device as revoked rather than as unpaired', async () => {
    const gateway = await startGateway()
    const store = new MemoryDeviceStore()
    await pairPhone(gateway, new DeviceKeyring(store))
    const deviceId = gateway.pairing.devices()[0]?.deviceId
    if (deviceId === undefined) throw new Error('expected a paired device')
    gateway.pairing.revoke(deviceId)

    const session = sessionFor(gateway, new DeviceKeyring(store))
    // "Your access was withdrawn" and "this desktop has never seen you" need
    // different words on a phone, because only one invites pairing again.
    await expect(session.connect()).resolves.toBe('revoked')
  })

  it('reports a device the desktop no longer knows', async () => {
    const first = await startGateway()
    const store = new MemoryDeviceStore()
    await pairPhone(first, new DeviceKeyring(store))

    // A desktop whose device records are gone: the phone holds a key nothing
    // has a record of, and re-pairing is the only way forward.
    const fresh = await startGateway()
    const session = sessionFor(fresh, new DeviceKeyring(store))
    await expect(session.connect()).resolves.toBe('unknown-device')
  })

  it('says the version is wrong instead of failing a command later', async () => {
    const gateway = await startGateway()
    const keyring = new DeviceKeyring(new MemoryDeviceStore())
    await keyring.remember({ deviceId: 'dev_1', displayName: 'Pixel', projectIds: [] })

    const stub = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true, result: { protocolVersion: 99, capabilities: [] } }), {
          headers: { 'content-type': 'application/json' },
        }),
    ) as unknown as typeof fetch
    const session = new MobileSession({
      client: new GatewayClient({ origin: gateway.origin, fetch: stub }),
      keyring,
    })
    await expect(session.connect()).resolves.toBe('version-mismatch')
  })

  it('reports an unreachable desktop without claiming anything else', async () => {
    const keyring = new DeviceKeyring(new MemoryDeviceStore())
    await keyring.remember({ deviceId: 'dev_1', displayName: 'Pixel', projectIds: [] })
    const session = new MobileSession({
      client: new GatewayClient({ origin: 'http://127.0.0.1:9' }),
      keyring,
    })
    // Nothing answered, so that is all the client may say. It does not know
    // whether the desktop is off, asleep, or behind a bad connection.
    await expect(session.connect()).resolves.toBe('unreachable')
  })

  it('is unpaired when this browser has no device key at all', async () => {
    const gateway = await startGateway()
    const session = sessionFor(gateway, new DeviceKeyring(new MemoryDeviceStore()))
    await expect(session.connect()).resolves.toBe('unpaired')
  })
})

describe('mobile commands', () => {
  it('does not run a prompt twice when the answer is lost', async () => {
    const host = fakeHost()
    const gateway = await startGateway(host)
    const store = new MemoryDeviceStore()
    // Paired over a working connection first, so what this test exercises is
    // the lost answer and nothing else.
    await pairPhone(gateway, new DeviceKeyring(store))

    const lossy = sessionFor(gateway, new DeviceKeyring(store), browserFetch({ loseFirstMutation: true }))
    await expect(lossy.connect()).resolves.toBe('connected')

    const outcome = await lossy.send({
      op: 'session.prompt',
      sessionId: 'sess_1',
      text: 'summarize the failing test',
    })

    // The desktop ran it once: the retry asked what became of the key instead
    // of sending the prompt again.
    expect(host.executed.filter((entry) => entry.op === 'session.prompt')).toHaveLength(1)
    expect(outcome).toEqual({ ok: true, result: { accepted: true } })
  })

  it('reads the change list and one diff from a desktop that serves them', async () => {
    const gateway = await startGateway(fakeHost({ withChanges: true }))
    const session = await pairPhone(gateway, new DeviceKeyring(new MemoryDeviceStore()))
    // Capabilities arrive on connect, the way every app launch fetches them.
    await expect(session.connect()).resolves.toBe('connected')

    expect(session.supports('changes.files')).toBe(true)
    const files = await session.query<{
      files: { path: string }[]
      base: string
      error: string | null
    }>('changes.files', { sessionId: 'sess_1' })
    expect(files).toEqual({
      files: [{ path: 'a.txt' }],
      base: 'workspace-head',
      error: null,
    })

    const one = await session.query<{
      file: { path: string; hunks: { header: string }[] } | null
      error: string | null
    }>('changes.diff', { sessionId: 'sess_1', path: 'a.txt' })
    expect(one.file?.hunks[0]?.header).toBe('@@ -1 +1 @@')

    const missing = await session.query<{ file: null; error: string | null }>('changes.diff', {
      sessionId: 'sess_1',
      path: 'nope.txt',
    })
    expect(missing.file).toBeNull()
  })

  it('hides the changes tab when the desktop serves no change list', async () => {
    const gateway = await startGateway(fakeHost())
    const session = await pairPhone(gateway, new DeviceKeyring(new MemoryDeviceStore()))
    await expect(session.connect()).resolves.toBe('connected')

    // Capabilities come from the desktop's own discovery answer, so an older
    // desktop simply has no Changes tab rather than a failing one.
    expect(session.supports('changes.files')).toBe(false)
  })

  it('names the created session inside the gateway envelope', async () => {
    const host = fakeHost()
    const gateway = await startGateway(host)
    const session = await pairPhone(gateway, new DeviceKeyring(new MemoryDeviceStore()))
    await expect(session.connect()).resolves.toBe('connected')

    // The host's answer travels inside the gateway's own envelope. A client
    // that reads the outer layer reports a failure for a session that exists,
    // and the retry creates a duplicate.
    const created = await session.send({ op: 'session.create', projectId: 'proj_1' })
    expect(sessionIdOf(created)).toBe('sess_new')
  })

  it('mints a key per command, so two prompts are two prompts', async () => {
    const host = fakeHost()
    const gateway = await startGateway(host)
    const session = await pairPhone(gateway, new DeviceKeyring(new MemoryDeviceStore()))

    await session.send({ op: 'session.prompt', sessionId: 'sess_1', text: 'first' })
    await session.send({ op: 'session.prompt', sessionId: 'sess_1', text: 'first' })
    // Same text, different keys: a user who sends the same thing twice means
    // it twice.
    expect(host.executed).toHaveLength(2)
  })
})
