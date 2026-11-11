import { join } from 'node:path'
import {
  machineIdentitySchema, type MachineDiscovery, type MachineEventsFrame,
  type MachineIdentity, type MachinePairingView, type MachineRoute, type MachineView,
} from '@ari/contracts/machines'
import {
  REMOTE_ANONYMOUS_OPERATIONS, REMOTE_PROTOCOL_VERSION,
  remoteCommandEnvelopeSchema, remoteQuerySchema, remoteServerMessageSchema,
  type RemoteCommand, type RemoteQuery,
} from '@ari/contracts/remote'
import { GatewayClient, RemoteError, RemoteSession, type ConnectionState } from '@ari/remote-client'
import type { SecretBox } from '@ari/ari-core/endpoints'
import { DesktopMachineCredential, MachinesRegistry, type MachineRecord } from './machines-registry'
import { MachineNetwork, parseMachineAddress, tailnetPeerRoutes, type TailnetRunner } from './machines-network'

interface Connection {
  client: GatewayClient
  credential: DesktopMachineCredential
  session: RemoteSession
  controller: AbortController
  connecting?: Promise<MachineView>
  pairing?: Promise<void>
}
interface Subscription {
  machineId: string
  close: () => void
}
export interface MachinesServiceDeps {
  dir: string
  /** Only an OS-backed safeStorage box; null refuses pairing. */
  secretBox: () => SecretBox | null
  onChange?: (machines: MachineView[]) => void
  /** Explicit test seam. Production registration never enables loopback. */
  allowLoopback?: boolean
  network?: MachineNetwork
  tailnetRunner?: TailnetRunner
  decisionPollMs?: number
  decisionTimeoutMs?: number
}

/** A desktop client of other hosts. This service has no local Engine or filesystem RPC. */
export class MachinesService {
  readonly #deps: MachinesServiceDeps
  readonly #registry: MachinesRegistry
  readonly #network: MachineNetwork
  readonly #connections = new Map<string, Connection>()
  readonly #views = new Map<string, Pick<MachineView, 'status' | 'error' | 'allowTerminal'>>()
  readonly #pairing = new Map<string, MachinePairingView>()
  readonly #invitations = new Map<string, string>()
  readonly #subscriptions = new Map<string, Subscription>()
  #disposed = false
  #discovery: Promise<MachineDiscovery[]> | null = null

  constructor(deps: MachinesServiceDeps) {
    this.#deps = deps
    this.#registry = new MachinesRegistry(join(deps.dir, 'machines.json'))
    this.#network = deps.network ?? new MachineNetwork({ allowLoopback: deps.allowLoopback })
  }
  list(): MachineView[] { return this.#registry.list().map((row) => this.#view(row)) }

  async add(address: string, name?: string): Promise<MachineView> {
    this.#assertOpen()
    const { route, invitationId } = parseMachineAddress(address, this.#deps.allowLoopback)
    const previous = this.#registry.list().find((row) => row.routes.some((item) => item.origin === route.origin))
    if (previous !== undefined) {
      if (invitationId !== undefined) this.#invitations.set(previous.id, invitationId)
      return this.#view(previous)
    }
    let identity: MachineIdentity | null = null
    let error: string | null = null
    try { identity = await this.#probe(route) } catch (failure) { error = publicFailure(failure) }
    this.#assertOpen()
    const row = this.#registry.add(name?.trim() || identity?.name || `Legacy Ari · ${new URL(route.origin).hostname}`, route, identity)
    if (invitationId !== undefined) this.#invitations.set(row.id, invitationId)
    this.#views.set(row.id, {
      status: identity !== null && identity.protocolVersion !== REMOTE_PROTOCOL_VERSION ? 'incompatible' : error === null ? 'unpaired' : 'offline',
      error: identity !== null && identity.protocolVersion !== REMOTE_PROTOCOL_VERSION ? 'This computer uses an unsupported Ari protocol.' : error,
      allowTerminal: false,
    })
    this.#changed()
    return this.#view(this.#registry.get(row.id))
  }

  async discover(): Promise<MachineDiscovery[]> {
    this.#assertOpen()
    if (this.#discovery !== null) return this.#discovery
    this.#discovery = this.#discover().finally(() => { this.#discovery = null })
    return this.#discovery
  }
  async #discover(): Promise<MachineDiscovery[]> {
    const routes = await tailnetPeerRoutes(this.#deps.tailnetRunner)
    const results: MachineDiscovery[] = []
    let next = 0
    // Two bounded probes, at most 32 explicit routes, and a ten-second budget.
    const deadline = Date.now() + 10_000
    const worker = async (): Promise<void> => {
      while (next < routes.length && Date.now() < deadline && !this.#disposed) {
        const route = routes[next++]!
        try {
          const identity = await this.#probe(route)
          const existing = results.find((row) => identity.machineId !== undefined && row.identity.machineId === identity.machineId)
          if (existing !== undefined) existing.routes.push(route)
          else results.push({ name: identity.name ?? `Legacy Ari · ${new URL(route.origin).hostname}`, routes: [route], identity })
        } catch { /* A peer without Ari is not a discovered Ari host. */ }
      }
    }
    await Promise.all([worker(), worker()])
    return this.#disposed ? [] : results
  }

  async pair(params: { machineId: string; displayName: string; invitationId?: string; code?: string }): Promise<MachinePairingView> {
    this.#assertOpen()
    const connection = await this.#connection(params.machineId)
    if (connection.pairing !== undefined) return this.pairStatus(params.machineId)
    // Probe and verify identity/version before code resolution or request/redeem.
    try { await this.#negotiate(params.machineId, connection) }
    catch (error) { this.#operationFailed(params.machineId, connection, error); throw error }
    if (connection.credential.deviceId !== null && connection.session.usable)
      return { machineId: params.machineId, status: 'connected', confirmationCode: null, expiresAt: null, error: null }
    let invitationId = params.invitationId ?? this.#invitations.get(params.machineId)
    if (params.code !== undefined) invitationId = await connection.session.resolvePairingCode(params.code)
    if (invitationId === undefined) throw new Error('Paste a pairing link or enter the code shown on the host computer.')
    this.#invitations.delete(params.machineId)
    this.#pairing.set(params.machineId, { machineId: params.machineId, status: 'pairing', confirmationCode: null, expiresAt: Date.now() + (this.#deps.decisionTimeoutMs ?? 300_000), error: null })
    this.#set(params.machineId, 'pairing', null)
    const paired = connection.session.pair(invitationId, params.displayName, connection.controller.signal)
      .then(() => {
        if (!this.#active(params.machineId, connection)) return
        this.#pairing.set(params.machineId, { machineId: params.machineId, status: 'connected', confirmationCode: null, expiresAt: null, error: null })
        this.#set(params.machineId, 'connected', null, connection.session.allowTerminal)
      })
      .catch((error: unknown) => {
        if (!this.#active(params.machineId, connection)) return
        this.#pairing.set(params.machineId, {
          machineId: params.machineId,
          status: error instanceof RemoteError && error.code === 'pairing_denied' ? 'denied' : error instanceof RemoteError && error.code === 'invitation_expired' ? 'expired' : 'error',
          confirmationCode: null, expiresAt: null, error: publicFailure(error),
        })
        this.#failed(params.machineId, error)
      })
      .finally(() => { if (this.#active(params.machineId, connection)) connection.pairing = undefined })
    connection.pairing = paired
    return this.pairStatus(params.machineId)
  }
  pairStatus(machineId: string): MachinePairingView {
    this.#registry.get(machineId)
    return structuredClone(this.#pairing.get(machineId) ?? {
      machineId, status: this.#views.get(machineId)?.status === 'connected' ? 'connected' : 'unpaired',
      confirmationCode: null, expiresAt: null, error: null,
    })
  }

  async connect(machineId: string): Promise<MachineView> {
    this.#assertOpen()
    this.#registry.get(machineId)
    let connection: Connection
    try { connection = await this.#connection(machineId) }
    catch (error) {
      this.#failed(machineId, error)
      return this.#view(this.#registry.get(machineId))
    }
    if (connection.connecting !== undefined) return connection.connecting
    if (connection.pairing !== undefined) return this.#view(this.#registry.get(machineId))
    connection.connecting = this.#connect(machineId, connection).finally(() => { connection.connecting = undefined })
    return connection.connecting
  }
  async #connect(machineId: string, connection: Connection): Promise<MachineView> {
    try {
      this.#closeSubscriptions(machineId)
      connection.session.disconnect()
      await this.#negotiate(machineId, connection)
      const state = await connection.session.connect(connection.controller.signal)
      if (!this.#active(machineId, connection)) throw new Error('The computer connection was removed.')
      this.#set(machineId, machineStatus(state), state === 'connected' || state === 'unpaired' ? null : stateError(state), connection.session.allowTerminal)
    } catch (error) {
      if (!this.#active(machineId, connection)) throw error
      this.#failed(machineId, error)
    }
    return this.#view(this.#registry.get(machineId))
  }

  rename(machineId: string, name: string): MachineView {
    this.#assertOpen()
    const record = this.#registry.update(machineId, { name: name.trim() })
    this.#changed()
    return this.#view(record)
  }
  async remove(machineId: string): Promise<{ removed: boolean }> {
    this.#assertOpen()
    if (!this.#registry.list().some((row) => row.id === machineId)) return { removed: false }
    const record = this.#registry.get(machineId)
    const connection = this.#connections.get(machineId)
    this.#closeSubscriptions(machineId)
    // Only revoke this client's device; never invoke a local/host approve or list operation.
    let revocation: Promise<unknown> | undefined
    if (connection?.session.usable && connection.credential.deviceId !== null) {
      revocation = connection.client.query('device.revoke', { deviceId: connection.credential.deviceId }).catch(() => undefined)
    } else if (record.credentialCipher !== null) {
      // Unlock before deleting the record, then make one bounded fresh proof
      // attempt using a private client that can never publish into the renderer.
      const credential = new DesktopMachineCredential(machineId, this.#registry, this.#deps.secretBox)
      try {
        await credential.load()
        if (credential.deviceId !== null) revocation = this.#revokeRemoved(record, credential).catch(() => undefined)
      } catch { /* Local removal still succeeds if the OS keyring is unavailable. */ }
    }
    this.#connections.delete(machineId)
    connection?.controller.abort()
    connection?.session.disconnect()
    const removed = this.#registry.remove(machineId)
    this.#views.delete(machineId)
    this.#pairing.delete(machineId)
    this.#invitations.delete(machineId)
    this.#changed()
    await revocation
    return { removed }
  }

  async #revokeRemoved(record: MachineRecord, credential: DesktopMachineCredential): Promise<void> {
    const client = new GatewayClient(await this.#network.clientOptions(record.routes[0]!))
    try {
      const info = machineIdentitySchema.parse(await client.info())
      if (info.protocolVersion !== REMOTE_PROTOCOL_VERSION || (record.identity?.machineId !== undefined && record.identity.machineId !== info.machineId) || !info.capabilities.includes('device.revoke')) return
      const deviceId = credential.deviceId
      if (deviceId === null) return
      const { nonce } = await client.deviceChallenge(deviceId)
      const signature = await credential.sign(nonce)
      const authorized = await client.deviceAuthorize(deviceId, { nonce, signature })
      client.token = authorized.token
      await client.query('device.revoke', { deviceId })
    } finally { client.token = null }
  }

  async query(machineId: string, rawQuery: RemoteQuery): Promise<unknown> {
    const query = remoteQuerySchema.parse(rawQuery)
    const connection = await this.#ready(machineId, query.op)
    const { op, ...params } = query
    try {
      const result = await connection.session.query(op, params)
      this.#ensureActive(machineId, connection)
      return result
    } catch (error) { this.#operationFailed(machineId, connection, error); throw error }
  }
  async command(machineId: string, rawCommand: RemoteCommand): Promise<unknown> {
    const command = remoteCommandEnvelopeSchema.parse(rawCommand)
    const connection = await this.#ready(machineId, command.op)
    try {
      // A lost response is uncertain: preserve the caller's keys and let its
      // machine-scoped command.status receipt resolve it. Never auto-resubmit.
      const result = await connection.client.command(command)
      this.#ensureActive(machineId, connection)
      return result
    } catch (error) { this.#operationFailed(machineId, connection, error); throw error }
  }

  async subscribe(id: string, params: { machineId: string; sessionId: string; fromSeq?: number }, emit: (frame: MachineEventsFrame) => void): Promise<void> {
    this.unsubscribe(id)
    let cancelled = false
    const pending: Subscription = { machineId: params.machineId, close: () => { cancelled = true } }
    this.#subscriptions.set(id, pending)
    try {
      const connection = await this.#ready(params.machineId, 'events.subscribe')
      if (cancelled || this.#subscriptions.get(id) !== pending) return
      const close = connection.session.subscribe(params.sessionId, {
        ...(params.fromSeq === undefined ? {} : { fromSeq: params.fromSeq }),
        onFrame: (raw) => {
          if (cancelled || !this.#active(params.machineId, connection)) return
          const parsed = remoteServerMessageSchema.safeParse(raw)
          if (!parsed.success || ('sessionId' in parsed.data && parsed.data.sessionId !== params.sessionId)) return
          emit({ machineId: params.machineId, message: parsed.data })
        },
        onClose: () => {
          if (!cancelled && this.#active(params.machineId, connection))
            emit({ machineId: params.machineId, message: { type: 'error', error: { code: connection.session.state === 'revoked' ? 'access_revoked' : 'internal_error', message: 'The computer activity connection closed. Reconnect to resume.' } } })
        },
      })
      pending.close = () => { cancelled = true; close() }
    } catch (error) {
      if (!cancelled && this.#subscriptions.get(id) === pending) this.#subscriptions.delete(id)
      throw error
    }
  }
  unsubscribe(id: string): void { this.#subscriptions.get(id)?.close(); this.#subscriptions.delete(id) }
  clearSubscriptions(): void { for (const id of [...this.#subscriptions.keys()]) this.unsubscribe(id) }
  dispose(): void {
    this.#disposed = true
    this.clearSubscriptions()
    for (const connection of this.#connections.values()) { connection.controller.abort(); connection.session.disconnect() }
    this.#connections.clear()
  }

  async #connection(machineId: string): Promise<Connection> {
    this.#assertOpen()
    const existing = this.#connections.get(machineId)
    if (existing !== undefined) return existing
    const row = this.#registry.get(machineId)
    const options = await this.#network.clientOptions(row.routes[0]!)
    this.#assertOpen()
    this.#registry.get(machineId)
    // An overlapping read may already have installed the connection.
    const installed = this.#connections.get(machineId)
    if (installed !== undefined) return installed
    const credential = new DesktopMachineCredential(machineId, this.#registry, this.#deps.secretBox)
    const client = new GatewayClient(options)
    const controller = new AbortController()
    const session = new RemoteSession({
      client, keyring: credential,
      ...(this.#deps.decisionPollMs === undefined ? {} : { decisionPollMs: this.#deps.decisionPollMs }),
      ...(this.#deps.decisionTimeoutMs === undefined ? {} : { decisionTimeoutMs: this.#deps.decisionTimeoutMs }),
      onState: (state) => {
        if (!controller.signal.aborted && this.#connections.has(machineId)) {
          if (state === 'revoked' || state === 'unknown-device' || state === 'version-mismatch') this.#closeSubscriptions(machineId)
          this.#set(machineId, machineStatus(state), state === 'connected' ? null : stateError(state), session.allowTerminal)
        }
      },
      onPairCode: (confirmationCode) => {
        const pairing = this.#pairing.get(machineId)
        if (pairing !== undefined && !controller.signal.aborted) { pairing.confirmationCode = confirmationCode; this.#changed() }
      },
    })
    const connection: Connection = { client, credential, session, controller }
    this.#connections.set(machineId, connection)
    await credential.load()
    return connection
  }
  async #probe(route: MachineRoute): Promise<MachineIdentity> {
    const options = await this.#network.clientOptions(route)
    const response = await options.fetch!(`${route.origin}/api/identity`, { method: 'GET', redirect: 'error' })
    if (response.status === 404) return machineIdentitySchema.parse(await new GatewayClient(options).info())
    if (!response.ok) throw new RemoteError('unreachable', 'This computer did not answer an Ari identity probe.', response.status)
    const envelope = await response.json() as { ok?: boolean; result?: unknown }
    if (envelope.ok !== true) throw new Error('This computer did not return an Ari identity.')
    return machineIdentitySchema.parse(envelope.result)
  }
  async #negotiate(machineId: string, connection: Connection, operation?: string): Promise<void> {
    const identity = machineIdentitySchema.parse(await connection.client.info())
    this.#ensureActive(machineId, connection)
    const saved = this.#registry.get(machineId).identity
    if (saved?.machineId !== undefined && saved.machineId !== identity.machineId)
      throw new RemoteError('access_revoked', 'This address now belongs to a different computer. Remove it and pair again.')
    this.#registry.update(machineId, { identity, lastSeenAt: Date.now() })
    if (identity.protocolVersion !== REMOTE_PROTOCOL_VERSION)
      throw new RemoteError('unsupported_version', 'This computer uses an unsupported Ari protocol. Update Ari before pairing or sending commands.')
    // command.status is implemented by the v1 gateway's receipt store rather
    // than the host, so legacy hosts do not advertise it in host.capabilities.
    if (operation !== undefined && operation !== 'command.status' && !identity.capabilities.includes(operation) && !REMOTE_ANONYMOUS_OPERATIONS.some((item) => item === operation))
      throw new RemoteError('unsupported_capability', `This computer does not support ${operation}.`)
  }
  async #ready(machineId: string, operation: string): Promise<Connection> {
    this.#assertOpen()
    const connection = await this.#connection(machineId)
    if (!connection.session.usable) {
      const view = await this.connect(machineId)
      if (view.status !== 'connected') throw new RemoteError(view.status === 'incompatible' ? 'unsupported_version' : view.status === 'revoked' ? 'access_revoked' : 'unauthenticated', view.error ?? 'Reconnect or pair this computer first.')
    }
    try { await this.#negotiate(machineId, connection, operation) }
    catch (error) { this.#operationFailed(machineId, connection, error); throw error }
    if (operation.startsWith('terminal.') && !connection.session.allowTerminal)
      throw new RemoteError('unsupported_capability', 'The host has not granted terminal access to this device.')
    return connection
  }
  #active(id: string, connection: Connection): boolean { return !this.#disposed && !connection.controller.signal.aborted && this.#connections.get(id) === connection }
  #ensureActive(id: string, connection: Connection): void { if (!this.#active(id, connection)) throw new Error('The computer connection was removed.') }
  #view(row: MachineRecord): MachineView {
    const state = this.#views.get(row.id) ?? { status: row.credentialCipher === null ? 'unpaired' : 'offline', error: null, allowTerminal: false }
    return { id: row.id, name: row.name, routes: row.routes, identity: row.identity, lastSeenAt: row.lastSeenAt, ...state }
  }
  #set(id: string, status: MachineView['status'], error: string | null, allowTerminal = false): void {
    this.#views.set(id, { status, error, allowTerminal: status === 'connected' && allowTerminal })
    this.#changed()
  }
  #failed(id: string, error: unknown): void {
    const status = error instanceof RemoteError && error.code === 'unsupported_version' ? 'incompatible' : error instanceof RemoteError && error.code === 'access_revoked' ? 'revoked' : 'offline'
    this.#set(id, status, publicFailure(error))
  }
  #operationFailed(id: string, connection: Connection, error: unknown): void {
    if (!this.#active(id, connection)) return
    if (error instanceof RemoteError && ['access_revoked', 'unsupported_version', 'unreachable', 'authentication_expired', 'unauthenticated'].includes(error.code)) {
      this.#closeSubscriptions(id)
      connection.session.disconnect()
      this.#failed(id, error)
    }
  }
  #closeSubscriptions(id: string): void { for (const [key, sub] of this.#subscriptions) if (sub.machineId === id) this.unsubscribe(key) }
  #changed(): void { if (!this.#disposed) this.#deps.onChange?.(this.list()) }
  #assertOpen(): void { if (this.#disposed) throw new Error('The machines service has shut down.') }
}

function publicFailure(error: unknown): string {
  // Transport exceptions can contain local implementation paths; only named
  // remote failures or deliberately written validation messages cross IPC.
  return error instanceof RemoteError ? error.message : error instanceof Error && !/ENOENT|EACCES|EPERM|[A-Z]:\\/i.test(error.message) ? error.message : 'This computer connection could not be opened.'
}
function machineStatus(state: ConnectionState): MachineView['status'] {
  if (state === 'connected') return 'connected'
  if (state === 'unpaired') return 'unpaired'
  if (state === 'revoked' || state === 'unknown-device') return 'revoked'
  if (state === 'version-mismatch') return 'incompatible'
  return 'offline'
}
function stateError(state: ConnectionState): string | null {
  if (state === 'connected' || state === 'unpaired') return null
  if (state === 'revoked' || state === 'unknown-device') return 'The host revoked or no longer recognizes this device. Pair again with host approval.'
  if (state === 'version-mismatch') return 'This computer uses an unsupported Ari protocol.'
  return 'This computer is offline. Reconnect when it is reachable.'
}
