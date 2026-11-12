import { join } from 'node:path'
import {
  machineIdentitySchema,
  type MachineDiscovery,
  type MachineEventsFrame,
  type MachineIdentity,
  type MachinePairingView,
  type MachineRoute,
  type MachineView,
  type MachineAutoPreference,
  type MachinesPreferences,
} from '@ari/contracts/machines'
import {
  REMOTE_ANONYMOUS_OPERATIONS,
  REMOTE_PROTOCOL_VERSION,
  remoteCommandEnvelopeSchema,
  remoteQuerySchema,
  remoteServerMessageSchema,
  type RemoteCommand,
  type RemoteQuery,
} from '@ari/contracts/remote'
import { GatewayClient, RemoteError, RemoteSession, authorizeRoute, verifyRoute, verifyHostManifest,
  type PinnedRouteIdentity, type ConnectionState } from '@ari/remote-client'
import type { SecretBox } from '@ari/ari-core/endpoints'
import { DesktopMachineCredential, MachinesRegistry, type MachineRecord } from './machines-registry'
import {
  MachineNetwork,
  parseMachineAddress,
  tailnetPeerRoutes,
  type TailnetRunner,
} from './machines-network'

interface Connection {
  machineId: string
  client: GatewayClient
  route: MachineRoute
  pin: PinnedRouteIdentity | null
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
  precheckIntervalMs?: number
  moveBackCooldownMs?: number
  now?: () => number
}

/** A desktop client of other hosts. This service has no local Engine or filesystem RPC. */
export class MachinesService {
  readonly #deps: MachinesServiceDeps
  readonly #storedRegistry: MachinesRegistry | null
  readonly #network: MachineNetwork
  readonly #connections = new Map<string, Connection>()
  readonly #pendingConnections = new Set<Connection>()
  readonly #views = new Map<string, Pick<MachineView, 'status' | 'error' | 'allowTerminal'>>()
  readonly #pairing = new Map<string, MachinePairingView>()
  readonly #invitations = new Map<string, string>()
  readonly #subscriptions = new Map<string, Subscription>()
  readonly #walks = new Map<string, Promise<MachineView>>()
  readonly #prechecks = new Map<string, Promise<MachineView>>()
  readonly #lastSwitch = new Map<string, number>()
  readonly #precheckTimer: ReturnType<typeof setInterval>
  #disposed = false
  #discovery: Promise<MachineDiscovery[]> | null = null

  constructor(deps: MachinesServiceDeps) {
    this.#deps = deps
    try {
      this.#storedRegistry = new MachinesRegistry(join(deps.dir, 'machines.json'))
    } catch {
      // Machines is optional to local startup. Keep unreadable data intact and
      // refuse machine operations rather than aborting registration of local RPC.
      this.#storedRegistry = null
    }
    this.#network = deps.network ?? new MachineNetwork({ allowLoopback: deps.allowLoopback })
    this.#precheckTimer = setInterval(() => { void this.precheck().catch(() => undefined) }, deps.precheckIntervalMs ?? 60_000)
    this.#precheckTimer.unref()
  }
  get #registry(): MachinesRegistry {
    if (this.#storedRegistry === null) throw registryUnavailable()
    return this.#storedRegistry
  }
  list(): MachineView[] {
    return this.#registry.list().map((row) => this.#view(row))
  }

  async add(address: string, name?: string): Promise<MachineView> {
    this.#assertOpen()
    const { route, invitationId } = parseMachineAddress(address, this.#deps.allowLoopback)
    const previous = this.#registry
      .list()
      .find((row) => row.routes.some((item) => item.origin === route.origin))
    if (previous !== undefined) {
      if (invitationId !== undefined) this.#invitations.set(previous.id, invitationId)
      return this.#view(previous)
    }
    let identity: MachineIdentity | null = null
    let error: string | null = null
    try {
      identity = await this.#probe(route)
    } catch (failure) {
      error = publicFailure(failure)
    }
    this.#assertOpen()
    if (invitationId !== undefined && identity?.machineId !== undefined && this.#registry.list().some((saved) =>
      saved.hostKey?.hostId === identity.machineId && !saved.routes.some((item) => item.origin === route.origin)))
      throw new Error('This pairing link uses an unknown address for a saved computer. Use Add route on that computer instead.')
    const row = this.#registry.add(
      name?.trim() || identity?.name || `Legacy Ari · ${new URL(route.origin).hostname}`,
      route,
      identity,
    )
    if (invitationId !== undefined) this.#invitations.set(row.id, invitationId)
    if (this.#views.has(row.id)) {
      this.#changed()
      return this.#view(row)
    }
    this.#views.set(row.id, {
      status:
        identity !== null && identity.protocolVersion !== REMOTE_PROTOCOL_VERSION
          ? 'incompatible'
          : error === null
            ? 'unpaired'
            : 'offline',
      error:
        identity !== null && identity.protocolVersion !== REMOTE_PROTOCOL_VERSION
          ? 'This computer uses an unsupported Ari protocol.'
          : error,
      allowTerminal: false,
    })
    this.#changed()
    return this.#view(this.#registry.get(row.id))
  }

  async discover(): Promise<MachineDiscovery[]> {
    this.#assertOpen()
    if (this.#discovery !== null) return this.#discovery
    this.#discovery = this.#discover().finally(() => {
      this.#discovery = null
    })
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
          const existing = results.find(
            (row) =>
              identity.machineId !== undefined && row.identity.machineId === identity.machineId,
          )
          if (existing !== undefined) existing.routes.push(route)
          else
            results.push({
              name: identity.name ?? `Legacy Ari · ${new URL(route.origin).hostname}`,
              routes: [route],
              identity,
            })
        } catch {
          /* A peer without Ari is not a discovered Ari host. */
        }
      }
    }
    await Promise.all([worker(), worker()])
    return this.#disposed ? [] : results
  }

  async pair(params: {
    machineId: string
    displayName: string
    invitationId?: string
    code?: string
  }): Promise<MachinePairingView> {
    this.#assertOpen()
    const pairingRow = this.#registry.get(params.machineId)
    if (pairingRow.hostKey === null && pairingRow.identity?.machineId !== undefined &&
      this.#registry.list().some((saved) => saved.id !== pairingRow.id &&
        saved.hostKey?.hostId === pairingRow.identity?.machineId &&
        !saved.routes.some((route) => route.origin === pairingRow.credentialOrigin)))
      throw new Error('This address belongs to a saved pinned computer. Use Add route on that computer instead of pairing again.')
    const connection = await this.#connection(params.machineId)
    if (connection.pairing !== undefined) return this.pairStatus(params.machineId)
    // Probe and verify identity/version before code resolution or request/redeem.
    try {
      await this.#negotiate(params.machineId, connection)
    } catch (error) {
      this.#operationFailed(params.machineId, connection, error)
      throw error
    }
    if (connection.credential.deviceId !== null && connection.session.usable)
      return {
        machineId: params.machineId,
        status: 'connected',
        confirmationCode: null,
        expiresAt: null,
        error: null,
      }
    let invitationId = params.invitationId ?? this.#invitations.get(params.machineId)
    if (params.code !== undefined)
      invitationId = await connection.session.resolvePairingCode(params.code)
    if (invitationId === undefined)
      throw new Error('Paste a pairing link or enter the code shown on the host computer.')
    this.#invitations.delete(params.machineId)
    this.#pairing.set(params.machineId, {
      machineId: params.machineId,
      status: 'pairing',
      confirmationCode: null,
      expiresAt: Date.now() + (this.#deps.decisionTimeoutMs ?? 300_000),
      error: null,
    })
    this.#set(params.machineId, 'pairing', null)
    const paired = connection.session
      .pair(invitationId, params.displayName, connection.controller.signal)
      .then(() => {
        if (!this.#active(params.machineId, connection)) return
        this.#pairing.set(params.machineId, {
          machineId: params.machineId,
          status: 'connected',
          confirmationCode: null,
          expiresAt: null,
          error: null,
        })
        this.#set(params.machineId, 'connected', null, connection.session.allowTerminal)
        return this.#refreshManifest(params.machineId, connection)
      })
      .catch((error: unknown) => {
        if (!this.#active(params.machineId, connection)) return
        this.#pairing.set(params.machineId, {
          machineId: params.machineId,
          status:
            error instanceof RemoteError && error.code === 'pairing_denied'
              ? 'denied'
              : error instanceof RemoteError && error.code === 'invitation_expired'
                ? 'expired'
                : 'error',
          confirmationCode: null,
          expiresAt: null,
          error: publicFailure(error),
        })
        this.#failed(params.machineId, error)
      })
      .finally(() => {
        if (this.#active(params.machineId, connection)) connection.pairing = undefined
      })
    connection.pairing = paired
    return this.pairStatus(params.machineId)
  }
  pairStatus(machineId: string): MachinePairingView {
    this.#registry.get(machineId)
    return structuredClone(
      this.#pairing.get(machineId) ?? {
        machineId,
        status: this.#views.get(machineId)?.status === 'connected' ? 'connected' : 'unpaired',
        confirmationCode: null,
        expiresAt: null,
        error: null,
      },
    )
  }

  async connect(machineId: string): Promise<MachineView> {
    this.#assertOpen()
    const existing = this.#walks.get(machineId)
    if (existing !== undefined) return existing
    const record = this.#registry.get(machineId)
    if (this.#connections.get(machineId)?.pairing !== undefined) return this.#view(record)
    const walk = this.#walk(machineId).finally(() => { if (this.#walks.get(machineId) === walk) this.#walks.delete(machineId) })
    this.#walks.set(machineId, walk)
    return walk
  }
  async #walk(machineId: string): Promise<MachineView> {
    const row = this.#registry.get(machineId)
    const prior = this.#connections.get(machineId)
    if (prior !== undefined) this.#drop(machineId, prior)
    let lastFailure: unknown = new RemoteError('unreachable', 'No saved computer route is reachable.')
    for (const route of row.routes) {
      this.#assertOpen()
      this.#registry.get(machineId)
      let connection: Connection | undefined
      try {
        connection = await this.#createConnection(machineId, route)
        this.#assertOpen()
        this.#registry.get(machineId)
        if (connection.credential.deviceId === null && route.origin !== row.credentialOrigin) {
          connection.controller.abort(); connection.session.disconnect(); continue
        }
        await this.#negotiate(machineId, connection, undefined, false)
        const state = await connection.session.connect(connection.controller.signal)
        if (state !== 'connected' && state !== 'unpaired') {
          // An unsigned descriptor cannot stop the route walk.
          throw new RemoteError(state === 'revoked' || state === 'unknown-device' ? 'access_revoked' : 'unreachable', stateError(state) ?? 'Route unavailable.')
        }
        this.#assertOpen()
        this.#registry.get(machineId)
        this.#connections.set(machineId, connection)
        this.#pendingConnections.delete(connection)
        this.#set(machineId, machineStatus(state), null, connection.session.allowTerminal)
        if (state === 'connected') {
          this.#lastSwitch.set(machineId, this.#now())
          await this.#refreshManifest(machineId, connection)
        }
        return this.#view(this.#registry.get(machineId))
      } catch (error) {
        lastFailure = error
        if (connection !== undefined) this.#drop(machineId, connection)
        if (this.#disposed || !this.#registry.list().some((record) => record.id === machineId)) throw error
        if (error instanceof RemoteError && error.code === 'unsupported_version') break
      }
    }
    this.#failed(machineId, lastFailure)
    return this.#view(this.#registry.get(machineId))
  }

  preferences(): MachinesPreferences { this.#assertOpen(); return this.#registry.preferences() }
  setAuto(enabled: boolean): MachinesPreferences { this.#assertOpen(); const result = this.#registry.setAuto(enabled); this.#changed(); return result }
  setPreference(machineId: string, tier: MachineAutoPreference): MachinesPreferences {
    this.#assertOpen(); const result = this.#registry.setPreference(machineId, tier); this.#changed(); return result
  }
  rememberProjectHost(projectKey: string, machineId: string): MachinesPreferences {
    this.#assertOpen(); return this.#registry.rememberProjectHost(projectKey, machineId)
  }
  async addRoute(machineId: string, address: string): Promise<MachineView> {
    this.#assertOpen()
    const {route, invitationId} = parseMachineAddress(address, this.#deps.allowLoopback)
    if (invitationId !== undefined) throw new Error('Add the route origin without its pairing invitation.')
    const row = this.#registry.get(machineId)
    if (row.routes.some((item) => item.origin === route.origin)) return this.#view(row)
    if (row.hostKey === null) throw new Error('Reconnect over the independently paired address before adding a verified route. Legacy hosts require independent pairing.')
    if (new URL(row.credentialOrigin).protocol === 'https:' && new URL(route.origin).protocol !== 'https:')
      throw new Error('An HTTPS computer credential cannot be used over HTTP.')
    const options = await this.#network.clientOptions(route)
    const pin = this.#pin(row)!
    await verifyRoute(new GatewayClient(options), pin)
    this.#assertOpen()
    const current = this.#registry.get(machineId)
    if (current.routes.length >= 16) throw new Error('Remove a saved route before adding another.')
    this.#registry.update(machineId, {routes: [...current.routes, {...route, source: 'manual', credentialOrigin: current.credentialOrigin}]})
    this.#changed()
    return this.#view(this.#registry.get(machineId))
  }
  reorderRoutes(machineId: string, origins: string[]): MachineView {
    this.#assertOpen()
    const row = this.#registry.get(machineId)
    if (origins.length !== row.routes.length || new Set(origins).size !== origins.length ||
      origins.some((origin) => !row.routes.some((route) => route.origin === origin)))
      throw new Error('Route order must contain every saved route exactly once.')
    const result = this.#registry.update(machineId, {routes: origins.map((origin) => row.routes.find((route) => route.origin === origin)!)})
    this.#changed()
    return this.#view(result)
  }
  removeRoute(machineId: string, origin: string): MachineView {
    this.#assertOpen()
    const row = this.#registry.get(machineId)
    const route = row.routes.find((item) => item.origin === origin)
    if (route === undefined) return this.#view(row)
    if (route.source === 'learned') throw new Error('Learned routes are removed when the host stops reporting them.')
    if (origin === row.credentialOrigin) throw new Error('The independently paired route holds this computer credential. Remove the computer to remove it.')
    const connection = this.#connections.get(machineId)
    for (const pending of this.#pendingConnections) if (pending.machineId === machineId && pending.route.origin === origin) {
      pending.controller.abort(); pending.session.disconnect(); this.#pendingConnections.delete(pending)
    }
    if (connection?.route.origin === origin) this.#drop(machineId, connection)
    const result = this.#registry.update(machineId, {routes: row.routes.filter((item) => item.origin !== origin)})
    this.#changed()
    return this.#view(result)
  }
  /** Called on focus/network changes by the renderer, and automatically every minute. */
  async precheck(machineId?: string): Promise<MachineView[]> {
    this.#assertOpen()
    const rows = machineId === undefined ? this.#registry.list() : [this.#registry.get(machineId)]
    for (const row of rows) {
      if (this.#walks.has(row.id)) continue
      let checking = this.#prechecks.get(row.id)
      if (checking === undefined) {
        checking = this.#precheck(row.id).finally(() => this.#prechecks.delete(row.id))
        this.#prechecks.set(row.id, checking)
      }
      await checking
    }
    return this.list()
  }
  async #precheck(machineId: string): Promise<MachineView> {
    const active = this.#connections.get(machineId)
    if (active === undefined || !active.session.usable) return this.#view(this.#registry.get(machineId))
    const row = this.#registry.get(machineId)
    const index = row.routes.findIndex((route) => route.origin === active.route.origin)
    if (index < 1 || this.#now() - (this.#lastSwitch.get(machineId) ?? 0) < (this.#deps.moveBackCooldownMs ?? 60_000))
      return this.#view(row)
    for (const route of row.routes.slice(0, index)) {
      let candidate: Connection | undefined
      try {
        candidate = await this.#createConnection(machineId, route)
        await this.#negotiate(machineId, candidate, undefined, false)
        if (await candidate.session.connect(candidate.controller.signal) !== 'connected') throw new Error('Route not authorized.')
        if (!this.#active(machineId, active) || this.#walks.has(machineId) ||
          !this.#registry.get(machineId).routes.some((item) => item.origin === route.origin)) throw new Error('Stale route precheck.')
        this.#drop(machineId, active)
        this.#connections.set(machineId, candidate)
        this.#pendingConnections.delete(candidate)
        this.#lastSwitch.set(machineId, this.#now())
        this.#set(machineId, 'connected', null, candidate.session.allowTerminal)
        await this.#refreshManifest(machineId, candidate)
        return this.#view(this.#registry.get(machineId))
      } catch {
        candidate?.controller.abort()
        candidate?.session.disconnect()
        if (candidate !== undefined) this.#pendingConnections.delete(candidate)
      }
    }
    return this.#view(this.#registry.get(machineId))
  }
  #now(): number { return (this.#deps.now ?? Date.now)() }
  #drop(machineId: string, connection: Connection): void {
    this.#pendingConnections.delete(connection)
    if (this.#connections.get(machineId) === connection) this.#connections.delete(machineId)
    this.#closeSubscriptions(machineId)
    connection.controller.abort()
    connection.session.disconnect()
  }
  #pin(row: MachineRecord): PinnedRouteIdentity | null {
    return row.hostKey === null ? null : {...row.hostKey, credentialOrigin: row.credentialOrigin}
  }
  async #refreshManifest(machineId: string, connection: Connection): Promise<void> {
    if (!this.#active(machineId, connection) || !connection.session.usable) return
    const row = this.#registry.get(machineId)
    // Initial key trust is possible only on the independently paired origin.
    if (row.hostKey === null && connection.route.origin !== row.credentialOrigin) return
    const info = machineIdentitySchema.parse(await connection.client.info())
    this.#ensureActive(machineId, connection)
    if (info.routeIdentity === undefined) return
    const manifest = await verifyHostManifest(await connection.client.routeManifest(), connection.route.origin,
      row.identity?.machineId, this.#pin(row))
    this.#ensureActive(machineId, connection)
    const routes: MachineRoute[] = []
    for (const origin of manifest.payload.routes) {
      try {
        const route = parseMachineAddress(origin, this.#deps.allowLoopback).route
        if (new URL(row.credentialOrigin).protocol === 'https:' && new URL(origin).protocol !== 'https:') continue
        routes.push(route)
      } catch { /* Unsupported transports do not relax production HTTPS policy. */ }
    }
    const updated = this.#registry.learn(machineId, manifest, routes)
    connection.pin = this.#pin(updated)
    this.#changed()
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
    for (const pending of this.#pendingConnections) if (pending.machineId === machineId) {
      pending.controller.abort(); pending.session.disconnect(); this.#pendingConnections.delete(pending)
    }
    this.#closeSubscriptions(machineId)
    // Only revoke this client's device; never invoke a local/host approve or list operation.
    let revocation: Promise<unknown> | undefined
    if (connection?.session.usable && connection.credential.deviceId !== null) {
      revocation = connection.client
        .query('device.revoke', { deviceId: connection.credential.deviceId })
        .catch(() => undefined)
    } else if (record.credentialCipher !== null) {
      // Unlock before deleting the record, then make one bounded fresh proof
      // attempt using a private client that can never publish into the renderer.
      const credential = new DesktopMachineCredential(
        machineId,
        this.#registry,
        this.#deps.secretBox,
      )
      try {
        await credential.load()
        if (credential.deviceId !== null)
          revocation = this.#revokeRemoved(record, credential).catch(() => undefined)
      } catch {
        /* Local removal still succeeds if the OS keyring is unavailable. */
      }
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
    const client = new GatewayClient(await this.#routeOptions(record, record.routes.find((route) => route.origin === record.credentialOrigin)!))
    try {
      const info = machineIdentitySchema.parse(await client.info())
      if (
        info.protocolVersion !== REMOTE_PROTOCOL_VERSION ||
        (record.identity?.machineId !== undefined &&
          record.identity.machineId !== info.machineId) ||
        !info.capabilities.includes('device.revoke')
      )
        return
      const deviceId = credential.deviceId
      if (deviceId === null) return
      const { nonce } = await client.deviceChallenge(deviceId)
      const signature = await credential.sign(nonce)
      const authorized = await client.deviceAuthorize(deviceId, { nonce, signature })
      client.token = authorized.token
      await client.query('device.revoke', { deviceId })
    } finally {
      client.token = null
    }
  }

  async query(machineId: string, rawQuery: RemoteQuery): Promise<unknown> {
    const query = remoteQuerySchema.parse(rawQuery)
    const connection = await this.#ready(machineId, query.op)
    const { op, ...params } = query
    try {
      const result = await connection.session.query(op, params)
      this.#ensureActive(machineId, connection)
      return result
    } catch (error) {
      this.#operationFailed(machineId, connection, error)
      throw error
    }
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
    } catch (error) {
      this.#operationFailed(machineId, connection, error)
      throw error
    }
  }

  async subscribe(
    id: string,
    params: { machineId: string; sessionId: string; fromSeq?: number; desktop?: true },
    emit: (frame: MachineEventsFrame) => void,
  ): Promise<void> {
    this.unsubscribe(id)
    let cancelled = false
    const pending: Subscription = {
      machineId: params.machineId,
      close: () => {
        cancelled = true
      },
    }
    this.#subscriptions.set(id, pending)
    try {
      const connection = await this.#ready(params.machineId, params.desktop === true ? 'events.desktop.subscribe' : 'events.subscribe')
      if (cancelled || this.#subscriptions.get(id) !== pending) return
      const close = connection.session.subscribe(params.sessionId, {
        ...(params.fromSeq === undefined ? {} : { fromSeq: params.fromSeq }),
        ...(params.desktop === true ? { desktop: true as const } : {}),
        onFrame: (raw) => {
          if (cancelled || !this.#active(params.machineId, connection)) return
          const parsed = remoteServerMessageSchema.safeParse(raw)
          if (
            !parsed.success ||
            ('sessionId' in parsed.data && parsed.data.sessionId !== params.sessionId)
          )
            return
          emit({ machineId: params.machineId, message: parsed.data })
        },
        onClose: () => {
          if (!cancelled && this.#active(params.machineId, connection))
            emit({
              machineId: params.machineId,
              message: {
                type: 'error',
                error: {
                  code:
                    connection.session.state === 'revoked' ? 'access_revoked' : 'internal_error',
                  message: 'The computer activity connection closed. Reconnect to resume.',
                },
              },
            })
        },
      })
      pending.close = () => {
        cancelled = true
        close()
      }
    } catch (error) {
      if (cancelled || this.#subscriptions.get(id) !== pending) return
      if (!cancelled && this.#subscriptions.get(id) === pending) this.#subscriptions.delete(id)
      throw error
    }
  }
  unsubscribe(id: string): void {
    this.#subscriptions.get(id)?.close()
    this.#subscriptions.delete(id)
  }
  clearSubscriptions(): void {
    for (const id of [...this.#subscriptions.keys()]) this.unsubscribe(id)
  }
  dispose(): void {
    this.#disposed = true
    clearInterval(this.#precheckTimer)
    this.clearSubscriptions()
    for (const connection of this.#connections.values()) {
      connection.controller.abort()
      connection.session.disconnect()
    }
    for (const connection of this.#pendingConnections) {
      connection.controller.abort()
      connection.session.disconnect()
    }
    this.#pendingConnections.clear()
    this.#connections.clear()
  }

  async #connection(machineId: string): Promise<Connection> {
    this.#assertOpen()
    const existing = this.#connections.get(machineId)
    if (existing !== undefined) return existing
    const row = this.#registry.get(machineId)
    const connection = await this.#createConnection(machineId, row.routes.find((route) => route.origin === row.credentialOrigin)!)
    this.#assertOpen()
    this.#registry.get(machineId)
    const winner = this.#connections.get(machineId)
    if (winner !== undefined) {
      connection.controller.abort(); connection.session.disconnect(); this.#pendingConnections.delete(connection); return winner
    }
    this.#connections.set(machineId, connection)
    this.#pendingConnections.delete(connection)
    return connection
  }
  async #createConnection(machineId: string, route: MachineRoute): Promise<Connection> {
    this.#assertOpen()
    const row = this.#registry.get(machineId)
    const options = await this.#routeOptions(row, route)
    this.#assertOpen()
    this.#registry.get(machineId)
    const credential = new DesktopMachineCredential(machineId, this.#registry, this.#deps.secretBox)
    const client = new GatewayClient(options)
    const controller = new AbortController()
    const session = new RemoteSession({
      client,
      keyring: credential,
      connectAttempts: 1,
      ...(row.hostKey === null ? {} : { authorize: (deviceId: string, signal: AbortSignal) =>
        authorizeRoute(client, this.#pin(this.#registry.get(machineId))!, credential, deviceId, signal) }),
      ...(this.#deps.decisionPollMs === undefined
        ? {}
        : { decisionPollMs: this.#deps.decisionPollMs }),
      ...(this.#deps.decisionTimeoutMs === undefined
        ? {}
        : { decisionTimeoutMs: this.#deps.decisionTimeoutMs }),
      onState: (state) => {
        if (!controller.signal.aborted && this.#connections.get(machineId)?.controller === controller) {
          if (state === 'revoked' || state === 'unknown-device' || state === 'version-mismatch')
            this.#closeSubscriptions(machineId)
          this.#set(
            machineId,
            machineStatus(state),
            state === 'connected' ? null : stateError(state),
            session.allowTerminal,
          )
        }
      },
      onPairCode: (confirmationCode) => {
        const pairing = this.#pairing.get(machineId)
        if (pairing !== undefined && !controller.signal.aborted) {
          pairing.confirmationCode = confirmationCode
          this.#changed()
        }
      },
    })
    const connection: Connection = { machineId, client, credential, session, controller, route, pin: this.#pin(row) }
    this.#pendingConnections.add(connection)
    try {
      // Failed unlocks must never install an incomplete credential. A later
      // keyring recovery reloads the original sealed key and device id.
      await credential.load()
      this.#assertOpen()
      this.#registry.get(machineId)
    } catch (error) {
      controller.abort()
      session.disconnect()
      this.#pendingConnections.delete(connection)
      throw error
    }
    return connection
  }
  async #routeOptions(row: MachineRecord, route: MachineRoute): Promise<ConstructorParameters<typeof GatewayClient>[0]> {
    if (row.hostKey === null && route.origin !== row.credentialOrigin)
      throw new RemoteError('invalid_signature', 'Legacy computer addresses require independent pairing.')
    if (new URL(row.credentialOrigin).protocol === 'https:' && new URL(route.origin).protocol !== 'https:')
      throw new RemoteError('invalid_signature', 'HTTPS computer credentials cannot be used over HTTP.')
    const options = await this.#network.clientOptions(route)
    const client = new GatewayClient(options)
    const pin = this.#pin(row)
    if (pin !== null) {
      const proof = await verifyRoute(client, pin)
      if (proof.protocolVersion !== REMOTE_PROTOCOL_VERSION)
        throw new RemoteError('unsupported_version', 'The verified computer uses an unsupported Ari protocol.')
    }
    const identity = machineIdentitySchema.parse(await client.info())
    if (row.identity?.machineId !== undefined && identity.machineId !== row.identity.machineId)
      throw new RemoteError(pin === null ? 'access_revoked' : 'invalid_signature', 'This address now belongs to another computer. Verify its route on the original computer.')
    if (identity.protocolVersion !== REMOTE_PROTOCOL_VERSION)
      throw new RemoteError(pin === null && route.origin === row.credentialOrigin ? 'unsupported_version' : 'invalid_signature', 'This computer uses an unsupported Ari protocol.')
    return options
  }
  async #probe(route: MachineRoute): Promise<MachineIdentity> {
    const options = await this.#network.clientOptions(route)
    const response = await options.fetch!(`${route.origin}/api/identity`, {
      method: 'GET',
      redirect: 'error',
    })
    if (response.status === 404)
      return machineIdentitySchema.parse(await new GatewayClient(options).info())
    if (!response.ok)
      throw new RemoteError(
        'unreachable',
        'This computer did not answer an Ari identity probe.',
        response.status,
      )
    const envelope = (await response.json()) as { ok?: boolean; result?: unknown }
    if (envelope.ok !== true) throw new Error('This computer did not return an Ari identity.')
    return machineIdentitySchema.parse(envelope.result)
  }
  async #negotiate(machineId: string, connection: Connection, operation?: string, installed = true): Promise<void> {
    if (connection.pin !== null) {
      const proof = await verifyRoute(connection.client, connection.pin, connection.controller.signal)
      if (proof.protocolVersion !== REMOTE_PROTOCOL_VERSION) throw new RemoteError(
        'unsupported_version', 'The verified computer uses an unsupported Ari protocol.')
    }
    const identity = machineIdentitySchema.parse(await connection.client.info())
    if (installed) this.#ensureActive(machineId, connection)
    else { this.#assertOpen(); this.#registry.get(machineId) }
    const saved = this.#registry.get(machineId).identity
    if (saved?.machineId !== undefined && saved.machineId !== identity.machineId)
      throw new RemoteError(
        connection.pin === null ? 'access_revoked' : 'invalid_signature',
        'This address now belongs to a different computer. Verify its route on the original computer.',
      )
    this.#registry.update(machineId, { identity, lastSeenAt: Date.now() })
    if (identity.protocolVersion !== REMOTE_PROTOCOL_VERSION)
      throw new RemoteError(
        connection.pin === null ? 'unsupported_version' : 'invalid_signature',
        'This computer uses an unsupported Ari protocol. Update Ari before pairing or sending commands.',
      )
    // command.status is implemented by the v1 gateway's receipt store rather
    // than the host, so legacy hosts do not advertise it in host.capabilities.
    if (
      operation !== undefined &&
      operation !== 'command.status' &&
      !identity.capabilities.includes(operation) &&
      !identity.machinesExtensions?.operations.some((item) => item === operation) &&
      !REMOTE_ANONYMOUS_OPERATIONS.some((item) => item === operation)
    )
      throw new RemoteError(
        'unsupported_capability',
        `This computer does not support ${operation}.`,
      )
  }
  async #ready(machineId: string, operation: string): Promise<Connection> {
    this.#assertOpen()
    let connection = this.#connections.get(machineId)
    if (connection === undefined || !connection.session.usable) {
      const view = await this.connect(machineId)
      if (view.status !== 'connected')
        throw new RemoteError(
          view.status === 'incompatible'
            ? 'unsupported_version'
            : view.status === 'revoked'
              ? 'access_revoked'
              : 'unauthenticated',
          view.error ?? 'Reconnect or pair this computer first.',
        )
      connection = await this.#connection(machineId)
    }
    try {
      await this.#negotiate(machineId, connection, operation)
    } catch (error) {
      this.#operationFailed(machineId, connection, error)
      throw error
    }
    if (operation.startsWith('terminal.') && !connection.session.allowTerminal)
      throw new RemoteError(
        'unsupported_capability',
        'The host has not granted terminal access to this device.',
      )
    return connection
  }
  #active(id: string, connection: Connection): boolean {
    return (
      !this.#disposed &&
      !connection.controller.signal.aborted &&
      this.#connections.get(id) === connection
    )
  }
  #ensureActive(id: string, connection: Connection): void {
    if (!this.#active(id, connection)) throw new Error('The computer connection was removed.')
  }
  #view(row: MachineRecord): MachineView {
    const state = this.#views.get(row.id) ?? {
      status: row.credentialCipher === null ? 'unpaired' : 'offline',
      error: null,
      allowTerminal: false,
    }
    return {
      id: row.id,
      name: row.name,
      routes: row.routes,
      identity: row.identity,
      lastSeenAt: row.lastSeenAt,
      ...state,
      effectiveRoute: this.#connections.get(row.id)?.session.usable ? this.#connections.get(row.id)!.route.origin : null,
      versionReady: state.status === 'connected',
      permissionsReady: state.status === 'connected',
      projectIds: state.status === 'connected' ? [...(this.#connections.get(row.id)?.session.projectIds ?? [])] : [],
      autoPreference: this.#registry.preferences().hostTiers[row.id] ?? 'normal',
    }
  }
  #set(
    id: string,
    status: MachineView['status'],
    error: string | null,
    allowTerminal = false,
  ): void {
    this.#views.set(id, { status, error, allowTerminal: status === 'connected' && allowTerminal })
    this.#changed()
  }
  #failed(id: string, error: unknown): void {
    const status =
      error instanceof RemoteError && error.code === 'unsupported_version'
        ? 'incompatible'
        : error instanceof RemoteError && (error.code === 'access_revoked' || error.code === 'invalid_signature')
          ? 'revoked'
          : 'offline'
    this.#set(id, status, publicFailure(error))
  }
  #operationFailed(id: string, connection: Connection, error: unknown): void {
    if (!this.#active(id, connection)) return
    if (
      error instanceof RemoteError &&
      [
        'access_revoked',
        'invalid_signature',
        'unsupported_version',
        'unreachable',
        'authentication_expired',
        'unauthenticated',
      ].includes(error.code)
    ) {
      this.#closeSubscriptions(id)
      connection.session.disconnect()
      this.#failed(id, error)
    }
  }
  #closeSubscriptions(id: string): void {
    for (const [key, sub] of this.#subscriptions) if (sub.machineId === id) this.unsubscribe(key)
  }
  #changed(): void {
    if (!this.#disposed) this.#deps.onChange?.(this.list())
  }
  #assertOpen(): void {
    if (this.#disposed) throw new Error('The machines service has shut down.')
    if (this.#storedRegistry === null) throw registryUnavailable()
  }
}

function registryUnavailable(): RemoteError {
  return new RemoteError(
    'internal_error',
    'Saved computers could not be loaded. The registry has been preserved; restore it from a backup and restart Ari.',
  )
}

function publicFailure(error: unknown): string {
  // Transport exceptions can contain local implementation paths; only named
  // remote failures or deliberately written validation messages cross IPC.
  return error instanceof RemoteError
    ? error.message
    : error instanceof Error && !/ENOENT|EACCES|EPERM|[A-Z]:\\/i.test(error.message)
      ? error.message
      : 'This computer connection could not be opened.'
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
  if (state === 'revoked' || state === 'unknown-device')
    return 'The host revoked or no longer recognizes this device. Pair again with host approval.'
  if (state === 'version-mismatch') return 'This computer uses an unsupported Ari protocol.'
  return 'This computer is offline. Reconnect when it is reachable.'
}
