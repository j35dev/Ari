import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { DriverKind, PermissionMode } from '@ari/contracts/common'
import type { RemoteModelCatalog } from '@ari/contracts/remote'
import type { RemoteDeviceView, RemoteState } from '@ari/contracts/rpc'
import { PairingService, type PersistedPairing } from '@ari/remote-gateway/pairing'
import {
  createRemoteGateway,
  type RemoteGateway,
  type ConnectLeaseVerifier,
} from '@ari/remote-gateway/gateway'
import { createLogger } from '@ari/shared/logger'
import { createRemoteHost, type RemoteHostDeps } from './remote-host'
import type { Engine } from './engine'
import type { SessionStore } from '@ari/engine/session-store'
import { AttachmentStore } from './attachments'
import { RemoteTerminals } from './remote-terminals'
import type { PtyFactory } from './terminal-service'
import { ManagedWorkspaces } from '@ari/engine/git'
import { RemoteIntegration } from './remote-integration'

const log = createLogger('desktop:remote')

/**
 * Remote access, on the desktop side (ADR §5, §9).
 *
 * Owns the gateway's lifetime and the two things a user does with it: open an
 * invitation, and decide on the device that asked. Both are in-process calls
 * from the renderer — neither has an HTTP route, deliberately, because whoever
 * holds the invitation (anyone who can read the screen) must not also be able
 * to approve themselves.
 *
 * The records that outlive the process live here too: paired devices and the
 * command deduplication table. A phone that has paired once proves its device
 * key again after a restart rather than scanning a new code, and a prompt that
 * was accepted before the restart is not accepted twice.
 */

export interface RemoteServiceDeps {
  engine: Engine
  store: SessionStore
  /** Directory holding the desktop's remote records (device + idempotency). */
  dir: string
  /** Providers this desktop can drive right now. */
  driverKinds: () => readonly DriverKind[]
  /** The permission ceiling a session created from a phone inherits. */
  defaultPermissionMode: () => PermissionMode
  defaultDriverKind: () => DriverKind | null
  hasProject: (projectId: string) => Promise<boolean>
  /** Every project this desktop has registered, for the phone's picker. */
  listProjects: () => Promise<{ id: string; name: string }[]>
  /** Providers this desktop can run, with their catalog models. */
  listModels: () => Promise<RemoteModelCatalog['providers']>
  mintSessionId: () => string
  /**
   * The address a phone should open, or null when none is configured yet.
   * Read on every state build, so enabling Tailscale changes the QR code
   * without restarting the gateway.
   */
  clientOrigin: () => string | null
  /** Exact extra origins to allow, beyond the gateway's own. */
  allowedOrigins: () => readonly string[]
  /**
   * The built PWA the gateway serves, or undefined when it has not been built.
   * Under Tailscale this is what makes the app same-origin with the API it
   * calls; absent, the gateway serves the API alone.
   */
  webRoot?: () => string | undefined
  /** Called whenever the state a user sees changes. */
  onChange?: (state: RemoteState) => void
  now?: () => number
  terminalFactory?: PtyFactory
  fork?: RemoteHostDeps['fork']
}

export class RemoteService {
  readonly #deps: RemoteServiceDeps
  #gateway: RemoteGateway | null = null
  #managedGateway: RemoteGateway | null = null
  #managedClientUrl: string | null = null
  #terminals: RemoteTerminals | undefined
  readonly #integration: RemoteIntegration
  readonly #managedInvitations = new Set<string>()
  readonly #managedDeviceIds = new Set<string>()
  #pairing: PairingService
  #invitation: { invitationId: string; url: string; expiresAt: number } | null = null
  /** The port the user chose, so a restart can come back on the same one. */
  #port: number
  #error: string | null = null

  constructor(deps: RemoteServiceDeps, options: { port?: number } = {}) {
    this.#deps = deps
    this.#integration = new RemoteIntegration(
      new ManagedWorkspaces(join(dirname(deps.dir), 'worktrees')),
      deps.engine,
      deps.store,
    )
    this.#port = options.port ?? 8787
    this.#pairing = this.#makePairing()
    try {
      const ids: unknown = JSON.parse(this.#read('managed-devices.json') ?? '[]')
      if (Array.isArray(ids))
        for (const id of ids) if (typeof id === 'string') this.#managedDeviceIds.add(id)
    } catch {
      log.warn('managed device registrations unreadable')
    }
  }

  get running(): boolean {
    return this.#gateway !== null
  }

  /** Starts the gateway and records that remote access is on. */
  async start(port?: number): Promise<RemoteState> {
    if (port !== undefined) this.#port = port
    if (this.#gateway !== null) return this.state()
    this.#error = null
    try {
      // Rebuilt rather than reused: the pairing service reads its records at
      // construction, and a gateway that failed to start must not leave a
      // service whose devices are the ones from a previous run.
      this.#pairing = this.#makePairing()
      if (this.#deps.terminalFactory !== undefined)
        this.#terminals = new RemoteTerminals(this.#deps.terminalFactory, (id) =>
          this.#pairing
            .devices()
            .some((device) => device.deviceId === id && device.allowTerminal === true),
        )
      const webRoot = this.#deps.webRoot?.()
      this.#gateway = await createRemoteGateway({
        host: createRemoteHost({
          engine: this.#deps.engine,
          store: this.#deps.store,
          driverKinds: this.#deps.driverKinds,
          defaultPermissionMode: this.#deps.defaultPermissionMode,
          defaultDriverKind: this.#deps.defaultDriverKind,
          hasProject: this.#deps.hasProject,
          listProjects: this.#deps.listProjects,
          listModels: this.#deps.listModels,
          pairing: this.#pairing,
          mintSessionId: this.#deps.mintSessionId,
          attachments: new AttachmentStore(join(dirname(this.#deps.dir), 'attachments')),
          integration: this.#integration,
          ...(this.#deps.fork === undefined ? {} : { fork: this.#deps.fork }),
          ...(this.#terminals === undefined ? {} : { terminals: this.#terminals }),
        }),
        // Exact origins, plus whatever the gateway is bound to. A phone on
        // the tailnet reaches it through the tailnet address, and the managed
        // PWA through the Connect origin; both are named here, never a pattern.
        allowedOrigins: () => [...this.#deps.allowedOrigins()],
        port: this.#port,
        pairing: this.#pairing,
        idempotency: {
          restore: this.#read('idempotency.json') ?? undefined,
          persist: (json) => this.#write('idempotency.json', json),
        },
        ...(this.#deps.now === undefined ? {} : { now: this.#deps.now }),
        ...(webRoot === undefined ? {} : { webRoot }),
      })
      log.info('remote access listening', { port: this.#gateway.port })
    } catch (error) {
      this.#terminals?.close()
      this.#terminals = undefined
      this.#error = error instanceof Error ? error.message : String(error)
      log.error('remote access failed to start', { error: this.#error })
      this.#gateway = null
    }
    return this.#changed()
  }

  async stop(): Promise<void> {
    this.#terminals?.close()
    this.#terminals = undefined
    await this.stopManaged()
    const gateway = this.#gateway
    this.#gateway = null
    this.#invitation = null
    // The tokens go with the gateway: they are operational credentials, and
    // closing it is exactly the case the device key exists for.
    if (gateway !== null) await gateway.close()
    log.info('remote access stopped')
    this.#changed()
  }

  /** An independent listener makes a forged Origin unable to bypass managed membership. */
  async startManaged(options: {
    port: number
    issuer: string
    hostname: string
    computerId: string
    verifier: () => ConnectLeaseVerifier | null
  }): Promise<number | null> {
    if (!this.running) await this.start()
    if (!this.running) return null
    await this.stopManaged()
    this.#managedGateway = await createRemoteGateway({
      host: createRemoteHost({
        engine: this.#deps.engine,
        store: this.#deps.store,
        driverKinds: this.#deps.driverKinds,
        defaultPermissionMode: this.#deps.defaultPermissionMode,
        defaultDriverKind: this.#deps.defaultDriverKind,
        hasProject: this.#deps.hasProject,
        listProjects: this.#deps.listProjects,
        listModels: this.#deps.listModels,
        pairing: this.#pairing,
        mintSessionId: this.#deps.mintSessionId,
        attachments: new AttachmentStore(join(dirname(this.#deps.dir), 'attachments')),
        integration: this.#integration,
        ...(this.#deps.fork === undefined ? {} : { fork: this.#deps.fork }),
        ...(this.#terminals === undefined ? {} : { terminals: this.#terminals }),
      }),
      allowedOrigins: [options.issuer, `https://${options.hostname}`],
      port: options.port,
      pairing: this.#pairing,
      managedAccess: { verifier: options.verifier },
      idempotency: {
        restore: this.#read('managed-idempotency.json') ?? undefined,
        persist: (json) => this.#write('managed-idempotency.json', json),
      },
    })
    this.#managedClientUrl = `${options.issuer}/?computer=${encodeURIComponent(options.computerId)}`
    this.#changed()
    return this.#managedGateway.port
  }

  async stopManaged(): Promise<void> {
    const gateway = this.#managedGateway
    this.#managedGateway = null
    this.#managedClientUrl = null
    if (gateway !== null) await gateway.close()
    this.#changed()
  }

  pairedRecords(): PersistedPairing {
    const records = this.#pairing.toPersisted()
    return {
      devices: records.devices.filter((device) => this.#managedDeviceIds.has(device.deviceId)),
      revoked: records.revoked.filter((device) => this.#managedDeviceIds.has(device.deviceId)),
    }
  }

  state(): RemoteState {
    const gateway = this.#gateway
    const clientUrl = this.#deps.clientOrigin()
    const pending = this.#pendingInvitation()
    return {
      enabled: gateway !== null,
      origin: gateway === null ? null : gateway.origin,
      // With no reachable address the QR would encode a loopback URL that
      // means "this phone" to the phone reading it.
      clientUrl: gateway === null ? null : (clientUrl ?? this.#managedClientUrl),
      allowedOrigins: gateway === null ? [] : [...this.#deps.allowedOrigins(), gateway.origin],
      devices: this.#deviceViews(),
      invitation: this.#invitation,
      pending,
      error: this.#error,
    }
  }

  /**
   * Opens an invitation. Single use and short-lived (ADR §9): it is displayed
   * as a QR code, which anyone who can see the screen can photograph, so it is
   * the user's approval that pairs a device and never the code alone.
   */
  invite(method: 'tailscale' | 'connect' = 'tailscale'): RemoteState {
    const gateway = this.#gateway
    if (gateway === null) return this.state()
    const base =
      method === 'connect' ? this.#managedClientUrl : (this.#deps.clientOrigin() ?? gateway.origin)
    if (base === null) return this.state()
    const invitation = gateway.pairing.begin(new URL(base).origin)
    if (method === 'connect') this.#managedInvitations.add(invitation.invitationId)
    this.#invitation = {
      invitationId: invitation.invitationId,
      // The id travels in the fragment, which never reaches a server and so
      // never lands in a tunnel's request log.
      url: `${base}${base.includes('?') ? '' : '/'}#pair=${encodeURIComponent(invitation.invitationId)}`,
      expiresAt: invitation.expiresAt,
    }
    return this.#changed()
  }

  cancelInvite(): RemoteState {
    this.#invitation = null
    return this.#changed()
  }

  approve(invitationId: string, projectIds: readonly string[], allowTerminal = false): RemoteState {
    const gateway = this.#gateway
    if (gateway === null) return this.state()
    const result = gateway.pairing.approve(invitationId, projectIds, allowTerminal)
    if (!result.ok) log.warn('pairing approval refused', { code: result.code })
    return this.#changed()
  }

  deny(invitationId: string): RemoteState {
    const gateway = this.#gateway
    if (gateway === null) return this.state()
    const result = gateway.pairing.deny(invitationId)
    if (!result.ok) log.warn('pairing denial refused', { code: result.code })
    return this.#changed()
  }

  revokeDevice(deviceId: string): RemoteState {
    // Revocation is a durable record, not a property of the listener: a user
    // who has turned remote access off still gets to withdraw a phone's access
    // so that turning it back on does not quietly restore it.
    if (!this.#pairing.revoke(deviceId)) {
      log.warn('revoking a device that is not paired', { deviceId })
    }
    return this.#changed()
  }

  #pendingInvitation(): RemoteState['pending'] {
    const gateway = this.#gateway
    const invitation = this.#invitation
    if (gateway === null || invitation === null) return null
    // Actionable only while a device is waiting on the user's decision. An
    // approved or redeemed invitation keeps no prompt: the phone finishes on
    // its own, and an Approve button left behind would only fail as a
    // conflict. A used code is dropped with the prompt so it cannot be
    // scanned again.
    const status = gateway.pairing.status(invitation.invitationId)
    if (status !== 'pending') {
      this.#invitation = null
      return null
    }
    const pending = gateway.pairing.pending(invitation.invitationId)
    if (pending === undefined) return null
    return {
      invitationId: invitation.invitationId,
      displayName: pending.displayName,
      confirmationCode: pending.confirmationCode,
      expiresAt: invitation.expiresAt,
    }
  }

  #deviceViews(): RemoteDeviceView[] {
    // Read from the service rather than the gateway: a device the user paired
    // stays listed while remote access is off, because it is still remembered
    // and the user is the one who decides whether to forget it.
    return this.#pairing.devices().map((device) => ({
      deviceId: device.deviceId,
      displayName: device.displayName,
      projectIds: [...device.projectIds],
      pairedAt: device.pairedAt,
      lastSeenAt: device.lastSeenAt,
      allowTerminal: device.allowTerminal === true,
    }))
  }

  #changed(): RemoteState {
    const state = this.state()
    this.#deps.onChange?.(state)
    return state
  }

  /**
   * The pairing service, restored from disk. Its `save` is where an approval
   * or a revocation reaches both the file and the renderer, so the two cannot
   * disagree about which devices exist.
   */
  #makePairing(): PairingService {
    const restored = this.#readPairing()
    return new PairingService({
      ...(this.#deps.now === undefined ? {} : { now: this.#deps.now }),
      ...(restored === undefined ? {} : { restored }),
      persist: { save: (state) => this.#writePairing(state) },
      onChange: () => this.#changed(),
    })
  }

  #readPairing(): PersistedPairing | undefined {
    const raw = this.#read('devices.json')
    if (raw === undefined) return undefined
    try {
      const parsed = JSON.parse(raw) as PersistedPairing
      if (!Array.isArray(parsed.devices) || !Array.isArray(parsed.revoked)) return undefined
      return parsed
    } catch {
      // A corrupt file must not stop the desktop from starting or the user
      // from pairing again; PairingService drops anything unusable in it.
      log.warn('device records unreadable; starting with none')
      return undefined
    }
  }

  #writePairing(state: PersistedPairing): void {
    for (const id of this.#managedInvitations) {
      const deviceId = this.#pairing.redeemedDeviceId(id)
      if (deviceId === undefined) continue
      this.#managedDeviceIds.add(deviceId)
      this.#managedInvitations.delete(id)
    }
    this.#write('managed-devices.json', JSON.stringify([...this.#managedDeviceIds]))
    this.#write('devices.json', JSON.stringify(state, null, 2))
  }

  #read(name: string): string | undefined {
    try {
      return readFileSync(join(this.#deps.dir, name), 'utf8')
    } catch {
      return undefined
    }
  }

  /** Atomic on the same volume, so a crash never leaves a torn record. */
  #write(name: string, contents: string): void {
    const path = join(this.#deps.dir, name)
    try {
      mkdirSync(dirname(path), { recursive: true })
      const tmp = `${path}.tmp`
      writeFileSync(tmp, contents, 'utf8')
      renameSync(tmp, path)
    } catch (error) {
      // Losing a record is survivable — a phone re-authorizes, a command is
      // retried under a fresh key — so this must not take the desktop down.
      log.error('could not write remote record', { name, error: String(error) })
    }
  }
}
