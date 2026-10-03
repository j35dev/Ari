import { generateKeyPairSync } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { z } from 'zod'
import type { SecretBox } from '@ari/ari-core/endpoints'
import {
  connectComputerSchema,
  connectConnectorSchema,
  connectDesktopPollSchema,
  connectDesktopStartSchema,
  connectJwksSchema,
  connectStoredSecretSchema,
  connectStoredStateSchema,
  pairingKeySchema,
} from '@ari/contracts/remote'
import type { RemoteConnectState } from '@ari/contracts/rpc'
import { ConnectLeaseVerifier } from '@ari/remote-gateway/gateway'
import { createLogger } from '@ari/shared/logger'
import type { RemoteService } from './remote'
import {
  probeConnectConnector,
  runConnectConnector,
  type ConnectConnector,
} from './remote-connect-runner'

const log = createLogger('desktop:remote-connect')
type StoredState = z.infer<typeof connectStoredStateSchema>
interface Deps {
  dir: string
  version: string
  secretBox(): SecretBox | null
  openExternal(url: string): Promise<void>
  remote: Pick<RemoteService, 'running' | 'startManaged' | 'stopManaged' | 'pairedRecords'>
  fetch?: typeof fetch
  probeConnector?: typeof probeConnectConnector
  runConnector?: typeof runConnectConnector
  onChange?(state: RemoteConnectState): void
  port?: number
}

/** Hosts invited-account authorization and an isolated, lease-protected connector lifecycle. */
export class RemoteConnectService {
  readonly #deps: Deps
  #stored: StoredState | null = null
  #credential: string | null = null
  #verifier: ConnectLeaseVerifier | null = null
  #generation = 0
  #abort = new AbortController()
  #timer: ReturnType<typeof setTimeout> | null = null
  #heartbeat: ReturnType<typeof setInterval> | null = null
  #connector: ConnectConnector | null = null
  #operation: Promise<void> | null = null
  #authorizing = false
  #provisionChecks = 0
  #sync: Promise<void> = Promise.resolve()
  readonly #synced = new Map<string, string>()
  #state: RemoteConnectState = {
    phase: 'unconfigured',
    origin: null,
    computerName: null,
    computerId: null,
    clientUrl: null,
    error: null,
    browserUrl: null,
    expiresAt: null,
    cloudflaredAvailable: false,
  }

  constructor(deps: Deps) {
    this.#deps = deps
    const path = join(deps.dir, 'connect.json')
    if (!existsSync(path)) return
    try {
      this.#stored = connectStoredStateSchema.parse(JSON.parse(readFileSync(path, 'utf8')))
      const origin = this.#origin(this.#stored.origin)
      this.#stored.origin = origin
      this.#state = {
        ...this.#state,
        phase: 'signed-out',
        origin,
        computerId: this.#stored.computerId,
        computerName: this.#stored.computerName,
      }
      if (this.#stored.secretCipher !== null) {
        const plain = deps.secretBox()?.decrypt(this.#stored.secretCipher)
        if (plain == null)
          throw new Error(
            'Stored Connect credentials cannot be unlocked. Disconnect and sign in again.',
          )
        this.#credential = connectStoredSecretSchema.parse(JSON.parse(plain)).credential
      }
      if (this.#stored.disconnectPending)
        this.#state = {
          ...this.#state,
          phase: 'error',
          error:
            'Connect is stopped locally. Disconnect again to remove the computer from the service.',
        }
    } catch {
      this.#state = {
        ...this.#state,
        phase: 'error',
        error: 'Stored Connect credentials cannot be unlocked. Disconnect and sign in again.',
      }
    }
  }

  state(): RemoteConnectState {
    return { ...this.#state }
  }

  async status(): Promise<RemoteConnectState> {
    if (this.#operation !== null || this.#authorizing) return this.state()
    this.#state.cloudflaredAvailable = await (this.#deps.probeConnector ?? probeConnectConnector)()
    if (
      this.#credential !== null &&
      this.#stored?.disconnectPending !== true &&
      this.#deps.remote.running &&
      ['signed-out', 'missing-cloudflared', 'error'].includes(this.#state.phase)
    ) {
      this.#begin(() => this.#connect(this.#generation))
    }
    return this.state()
  }

  async configure(origin: string): Promise<RemoteConnectState> {
    if (this.#credential !== null || this.#authorizing || this.#state.phase === 'awaiting-approval')
      return this.#set({ error: 'Disconnect Ari Connect before changing its service address.' })
    try {
      const normalized = this.#origin(origin)
      await this.stop()
      this.#stored = {
        origin: normalized,
        computerId: null,
        computerName: null,
        secretCipher: null,
        publicKey: null,
        jwks: null,
        port: this.#deps.port ?? 8788,
        disconnectPending: false,
      }
      this.#save()
      return this.#set({ phase: 'signed-out', origin: normalized, error: null })
    } catch {
      return this.#set({
        phase: 'error',
        error:
          'Use an HTTPS service origin supplied by your Ari administrator, without a path, credentials or query.',
      })
    }
  }

  async signIn(computerName: string): Promise<RemoteConnectState> {
    if (this.#stored === null)
      return this.#set({ error: 'Configure the Ari Connect service first.' })
    if (this.#stored.disconnectPending)
      return this.#set({ error: 'Connect is stopped locally. Disconnect again before signing in.' })
    if (!this.#deps.remote.running)
      return this.#set({ error: 'Enable mobile access before signing in.' })
    if (this.#operation !== null || this.#authorizing || this.#state.phase === 'awaiting-approval')
      return this.state()
    if (this.#credential !== null) {
      this.#begin(() => this.#connect(this.#generation))
      return this.state()
    }
    if (
      computerName.trim().length === 0 ||
      computerName.length > 64 ||
      [...computerName].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
    )
      return this.#set({ error: 'Use a computer name between 1 and 64 printable characters.' })
    if (this.#deps.secretBox() === null)
      return this.#set({
        phase: 'error',
        error:
          'OS-protected credential storage is unavailable. Unlock your system keyring before using Ari Connect.',
      })
    this.#authorizing = true
    try {
      return await this.#authorize(computerName)
    } finally {
      this.#authorizing = false
    }
  }

  async #authorize(computerName: string): Promise<RemoteConnectState> {
    const generation = this.#generation + 1
    await this.stop()
    if (
      !this.#current(generation) ||
      this.#stored === null ||
      this.#stored.disconnectPending ||
      !this.#deps.remote.running
    )
      return this.state()
    const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    const jwk = pairingKeySchema.parse(publicKey.export({ format: 'jwk' }))
    const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    try {
      const result = connectDesktopStartSchema.parse(
        await this.#request('/desktop/authorize/start', 'POST', {
          computerName: computerName.trim(),
          publicKey: jwk,
          appVersion: this.#deps.version,
          protocolVersion: '1',
          gatewayPort: this.#stored.port,
        }),
      )
      if (!this.#current(generation)) return this.state()
      const browser = new URL(result.browserUrl)
      if (
        browser.origin !== this.#stored.origin ||
        browser.pathname !== `/authorize/${result.transactionId}` ||
        browser.search ||
        browser.hash
      )
        throw new Error('The service returned an unexpected approval URL.')
      this.#set({
        phase: 'awaiting-approval',
        computerName: computerName.trim(),
        browserUrl: result.browserUrl,
        expiresAt: Date.parse(result.expiresAt),
        error: null,
      })
      await this.#deps.openExternal(result.browserUrl)
      if (this.#current(generation))
        this.#later(result.intervalSeconds * 1000, () =>
          this.#poll(generation, result, jwk, privateKeyPem),
        )
    } catch (error) {
      if (this.#current(generation)) await this.#fail(error)
    }
    return this.state()
  }

  async signOut(): Promise<RemoteConnectState> {
    const old = this.#stored
    const credential = this.#credential
    if (this.#stored !== null) {
      this.#stored.disconnectPending = true
      this.#save()
    }
    await this.stop()
    if (old?.computerId !== null && old?.computerId !== undefined && credential !== null) {
      try {
        await this.#request(
          `/computers/${encodeURIComponent(old.computerId)}`,
          'DELETE',
          undefined,
          credential,
        )
      } catch {
        return this.#set({
          phase: 'error',
          error:
            'Connect is stopped locally. The service could not remove this computer; check the connection and disconnect again.',
        })
      }
    }
    this.#credential = null
    this.#synced.clear()
    if (this.#stored !== null) {
      this.#stored = {
        ...this.#stored,
        computerId: null,
        computerName: null,
        secretCipher: null,
        publicKey: null,
        jwks: null,
        disconnectPending: false,
      }
      this.#save()
    }
    return this.#set({
      phase: this.#stored === null ? 'unconfigured' : 'signed-out',
      computerId: null,
      computerName: null,
      error: null,
    })
  }

  /** Stops managed traffic and cancels pending work; the local/Tailscale gateway remains independent. */
  async stop(): Promise<void> {
    ++this.#generation
    this.#provisionChecks = 0
    this.#abort.abort()
    this.#abort = new AbortController()
    if (this.#timer !== null) clearTimeout(this.#timer)
    if (this.#heartbeat !== null) clearInterval(this.#heartbeat)
    this.#timer = null
    this.#heartbeat = null
    this.#verifier = null
    const connector = this.#connector
    this.#connector = null
    if (connector !== null) await connector.stop()
    await this.#deps.remote.stopManaged()
    this.#set({
      phase: this.#stored === null ? 'unconfigured' : 'signed-out',
      clientUrl: null,
      browserUrl: null,
      expiresAt: null,
    })
  }

  syncDevices(): void {
    const generation = this.#generation
    this.#sync = this.#sync
      .then(async () => {
        if (
          !this.#current(generation) ||
          this.#state.phase !== 'ready' ||
          this.#stored?.computerId == null
        )
          return
        const base = `/computers/${encodeURIComponent(this.#stored.computerId)}/devices`
        const records = this.#deps.remote.pairedRecords()
        for (const device of records.devices) {
          const payload = {
            computerId: this.#stored.computerId,
            deviceId: device.deviceId,
            displayName: device.displayName.slice(0, 64),
            projectIds: device.projectIds,
            publicKey: device.publicKey,
          }
          const fingerprint = JSON.stringify(payload)
          if (this.#synced.get(device.deviceId) === fingerprint) continue
          await this.#request(base, 'POST', payload, this.#credential ?? undefined)
          if (!this.#current(generation)) return
          this.#synced.set(device.deviceId, fingerprint)
        }
        for (const device of records.revoked) {
          if (this.#synced.get(device.deviceId) === 'revoked') continue
          await this.#request(
            `${base}/${encodeURIComponent(device.deviceId)}`,
            'DELETE',
            undefined,
            this.#credential ?? undefined,
          )
          if (!this.#current(generation)) return
          this.#synced.set(device.deviceId, 'revoked')
        }
      })
      .catch(() => {
        if (this.#current(generation))
          this.#set({
            error:
              'A paired-device registration could not reach Ari Connect. Check again to retry.',
          })
      })
  }

  async #poll(
    generation: number,
    transaction: z.infer<typeof connectDesktopStartSchema>,
    publicKey: z.infer<typeof pairingKeySchema>,
    privateKeyPem: string,
  ): Promise<void> {
    if (!this.#current(generation)) return
    if (Date.now() >= Date.parse(transaction.expiresAt)) {
      this.#set({
        phase: 'denied',
        error: 'The browser approval expired. Sign in again.',
        browserUrl: null,
        expiresAt: null,
      })
      return
    }
    const result = connectDesktopPollSchema.parse(
      await this.#request('/desktop/authorize/poll', 'POST', {
        transactionId: transaction.transactionId,
        pollToken: transaction.pollToken,
      }),
    )
    if (!this.#current(generation)) return
    if (result.status === 'pending') {
      this.#later(transaction.intervalSeconds * 1000, () =>
        this.#poll(generation, transaction, publicKey, privateKeyPem),
      )
      return
    }
    if (result.status !== 'approved') {
      this.#set({
        phase: 'denied',
        error: 'The browser approval was denied or expired.',
        browserUrl: null,
        expiresAt: null,
      })
      return
    }
    const box = this.#deps.secretBox()
    if (box === null || this.#stored === null)
      throw new Error('OS-protected credential storage is unavailable.')
    this.#credential = result.computer.credential
    this.#stored = {
      ...this.#stored,
      computerId: result.computer.computerId,
      computerName: result.computer.name,
      publicKey,
      secretCipher: box.encrypt(JSON.stringify({ credential: this.#credential, privateKeyPem })),
    }
    this.#save()
    this.#set({
      computerId: result.computer.computerId,
      computerName: result.computer.name,
      browserUrl: null,
      expiresAt: null,
    })
    await this.#connect(generation)
  }

  async #connect(generation: number): Promise<void> {
    if (
      !this.#current(generation) ||
      !this.#deps.remote.running ||
      this.#stored?.computerId == null ||
      this.#credential === null ||
      this.#connector !== null
    )
      return
    this.#set({ phase: 'provisioning', error: null })
    const base = `/computers/${encodeURIComponent(this.#stored.computerId)}`
    const result = connectComputerSchema.parse(
      await this.#request(base, 'GET', undefined, this.#credential),
    ).computer
    if (!this.#current(generation)) return
    if (result.computerId !== this.#stored.computerId)
      throw new Error('The service returned another computer.')
    if (result.state !== 'ready' && result.state !== 'offline') {
      if (result.state !== 'provisioning' && result.state !== 'registered')
        throw new Error('This computer is unavailable. Contact your Ari administrator.')
      if (++this.#provisionChecks > 20)
        throw new Error(
          'Ari Connect is still provisioning this computer. Check the service and retry later.',
        )
      const next =
        result.provision.nextAttemptAt === null
          ? Date.now() + 5000
          : Date.parse(result.provision.nextAttemptAt)
      this.#later(Math.min(30_000, Math.max(5000, next - Date.now())), () =>
        this.#connect(generation),
      )
      return
    }
    this.#provisionChecks = 0
    const available = await (this.#deps.probeConnector ?? probeConnectConnector)()
    if (!this.#current(generation)) return
    this.#set({ cloudflaredAvailable: available })
    if (!available) {
      this.#set({ phase: 'missing-cloudflared' })
      return
    }
    const jwks = connectJwksSchema.parse(await this.#request('/.well-known/jwks.json', 'GET'))
    // The key set is pinned at first registration; a changed key requires fresh desktop authorization.
    if (this.#stored.jwks !== null && JSON.stringify(this.#stored.jwks) !== JSON.stringify(jwks))
      throw new Error(
        'The Connect signing key changed. Disconnect and sign in again after checking with your administrator.',
      )
    this.#stored.jwks = jwks
    this.#save()
    const connector = connectConnectorSchema.parse(
      await this.#request(`${base}/connector`, 'GET', undefined, this.#credential),
    )
    if (!this.#current(generation)) return
    if (connector.computerId !== result.computerId || connector.hostname !== result.hostname)
      throw new Error('The connector does not match this computer.')
    this.#verifier = new ConnectLeaseVerifier({
      issuer: this.#stored.origin,
      computerId: this.#stored.computerId,
      jwks,
    })
    const port = await this.#deps.remote.startManaged({
      port: this.#stored.port,
      issuer: this.#stored.origin,
      computerId: this.#stored.computerId,
      hostname: result.hostname,
      verifier: () => this.#verifier,
    })
    if (!this.#current(generation)) {
      await this.#deps.remote.stopManaged()
      return
    }
    if (port === null || port !== this.#stored.port)
      throw new Error('The managed gateway could not bind its configured port.')
    this.#set({ phase: 'connecting' })
    const process = await (this.#deps.runConnector ?? runConnectConnector)(connector.token, {
      onReady: () => {
        void this.#markReady(generation, result.hostname).catch((error: unknown) =>
          this.#current(generation) ? this.#fail(error) : undefined,
        )
      },
      onExit: () => {
        if (this.#current(generation))
          void this.#fail(new Error('The Cloudflare connector stopped. Check again to reconnect.'))
      },
    })
    if (!this.#current(generation)) {
      await process.stop()
      return
    }
    this.#connector = process
    if (this.#state.phase !== 'ready')
      this.#later(30_000, () => {
        throw new Error(
          'The Cloudflare connector could not reach Cloudflare. Check your network and retry.',
        )
      })
  }

  async #markReady(generation: number, hostname: string): Promise<void> {
    if (!this.#current(generation) || this.#stored?.computerId == null) return
    await this.#request(
      `/computers/${encodeURIComponent(this.#stored.computerId)}/status`,
      'POST',
      { state: 'ready', appVersion: this.#deps.version, gatewayPort: this.#stored.port },
      this.#credential ?? undefined,
    )
    if (!this.#current(generation)) return
    if (this.#timer !== null) clearTimeout(this.#timer)
    this.#timer = null
    this.#set({
      phase: 'ready',
      clientUrl: `${this.#stored.origin}/?computer=${encodeURIComponent(this.#stored.computerId)}`,
      error: null,
    })
    this.syncDevices()
    this.#heartbeat = setInterval(() => {
      void this.#request(
        `/computers/${encodeURIComponent(this.#stored?.computerId ?? '')}/status`,
        'POST',
        { state: 'ready' },
        this.#credential ?? undefined,
      )
        .then(() => {
          if (this.#current(generation)) this.syncDevices()
        })
        .catch((error: unknown) => (this.#current(generation) ? this.#fail(error) : undefined))
    }, 60_000)
    this.#heartbeat.unref()
    log.info('managed connector ready', { hostname })
  }

  #origin(value: string): string {
    const url = new URL(value)
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    )
      throw new Error('Invalid Connect origin.')
    return url.origin
  }

  async #request(
    path: string,
    method: string,
    body?: unknown,
    credential?: string,
  ): Promise<unknown> {
    if (this.#stored === null) throw new Error('Configure Ari Connect first.')
    const response = await (this.#deps.fetch ?? fetch)(`${this.#stored.origin}${path}`, {
      method,
      redirect: 'error',
      signal: AbortSignal.any([this.#abort.signal, AbortSignal.timeout(10_000)]),
      headers: {
        'content-type': 'application/json',
        ...(credential === undefined ? {} : { authorization: `Bearer ${credential}` }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    if (!response.ok)
      throw new Error(
        response.status === 401 || response.status === 403
          ? 'Your Ari Connect membership or computer authorization is unavailable. Contact your administrator.'
          : `Ari Connect could not complete this request (HTTP ${response.status}). Check your connection and retry.`,
      )
    const reader = response.body?.getReader()
    if (reader === undefined) throw new Error('Ari Connect returned an empty response.')
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      while (true) {
        const part = await reader.read()
        if (part.done) break
        size += part.value.byteLength
        if (size > 64 * 1024) throw new Error('Ari Connect returned an oversized response.')
        chunks.push(part.value)
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
    } finally {
      await reader.cancel().catch(() => undefined)
    }
  }

  #current(generation: number): boolean {
    return generation === this.#generation && !this.#abort.signal.aborted
  }
  #begin(task: () => Promise<void>): void {
    const generation = this.#generation
    const operation = task().catch((error: unknown) =>
      this.#current(generation) ? this.#fail(error) : undefined,
    )
    this.#operation = operation
    void operation.finally(() => {
      if (this.#operation === operation) this.#operation = null
    })
  }
  #later(delay: number, task: () => Promise<void> | void): void {
    if (this.#timer !== null) clearTimeout(this.#timer)
    this.#timer = setTimeout(() => {
      this.#timer = null
      this.#begin(async () => {
        await task()
      })
    }, delay)
    this.#timer.unref()
  }
  async #fail(error: unknown): Promise<void> {
    const message =
      error instanceof Error && /^(The |Your Ari|Ari Connect|OS-protected)/.test(error.message)
        ? error.message
        : 'Ari Connect could not complete the connection. Check your network and retry.'
    await this.stop()
    this.#set({ phase: 'error', error: message })
    log.warn('managed connection unavailable')
  }
  #set(patch: Partial<RemoteConnectState>): RemoteConnectState {
    this.#state = { ...this.#state, ...patch }
    this.#deps.onChange?.(this.state())
    return this.state()
  }
  #save(): void {
    if (this.#stored === null) return
    const path = join(this.#deps.dir, 'connect.json')
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(`${path}.tmp`, JSON.stringify(this.#stored), { mode: 0o600 })
    renameSync(`${path}.tmp`, path)
  }
}
