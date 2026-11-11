import { RemoteError, type GatewayClient } from './gateway-client'
import type { DeviceCredential, LeaseAdapter } from './credential'
import type { RemoteServerMessage } from '@ari/contracts/remote'

/**
 * The connection a phone actually lives with (ADR §17).
 *
 * A phone is asleep, backgrounded, on a train, or holding a socket that the
 * network forgot to tell it about. So this layer exists to answer one
 * question honestly at any moment: *what is the state of this link, and what
 * can the user do about it?* The states below are kept distinct on purpose —
 * collapsing "the desktop is unreachable" into "not connected" is how an app
 * ends up claiming the PC is asleep when it only knows the tunnel is closed.
 *
 * It also owns the two things that must not be got wrong for a remote client:
 * a mutation is never sent twice under the same key, and a token that has
 * expired is renewed by proving the device key rather than by asking the user
 * to pair again.
 */

export type ConnectionState =
  /** No device key stored: this browser has never paired. */
  | 'unpaired'
  /** The key is known but no token has been obtained yet. */
  | 'connecting'
  | 'connected'
  /** Was connected, lost the link, trying again. */
  | 'reconnecting'
  /** The desktop says this device's access was withdrawn. */
  | 'revoked'
  /** The desktop's records no longer know this device. */
  | 'unknown-device'
  /** The gateway answered, and speaks a protocol this client cannot use. */
  | 'version-mismatch'
  /** Nothing answered. */
  | 'unreachable'

export interface SessionDeps {
  client: GatewayClient
  keyring: DeviceCredential
  /** Called whenever the state changes, for the UI banner. */
  onState?: (state: ConnectionState) => void
  onPairCode?: (code: string) => void
  lease?: LeaseAdapter
  /** How often to ask whether the desktop has decided. Tests shorten it. */
  decisionPollMs?: number
  /** How long to wait for that decision before giving up. */
  decisionTimeoutMs?: number
  /** Base backoff between connection attempts. Tests shorten it. */
  connectRetryMs?: number
}

/** The protocol this build speaks; the gateway answers with its own. */
export const CLIENT_PROTOCOL_VERSION = 1

/** An invitation lives five minutes; the wait must not outlast it. */
const DECISION_POLL_MS = 1000
const DECISION_TIMEOUT_MS = 5 * 60 * 1000
/** A cold tailnet is the usual reason the first attempt fails; three tries. */
const CONNECT_ATTEMPTS = 3
const CONNECT_RETRY_MS = 900

export class RemoteSession {
  readonly #client: GatewayClient
  readonly #keyring: DeviceCredential
  readonly #onState: ((state: ConnectionState) => void) | undefined
  readonly #onPairCode: ((code: string) => void) | undefined
  readonly #decisionPollMs: number
  readonly #decisionTimeoutMs: number
  #state: ConnectionState = 'unpaired'
  #token: string | null = null
  /** Resolved project ids the desktop reported at the last authorization. */
  #projectIds: string[] = []
  #allowTerminal = false
  #capabilities: readonly string[] = []
  #listeners = new Set<() => void>()
  #connectRetryMs: number
  readonly #managed: LeaseAdapter | null
  #lifecycle = new AbortController()
  readonly #subscriptions = new Set<() => void>()

  constructor(deps: SessionDeps) {
    this.#client = deps.client
    this.#keyring = deps.keyring
    this.#onState = deps.onState
    this.#onPairCode = deps.onPairCode
    this.#managed = deps.lease ?? null
    this.#decisionPollMs = deps.decisionPollMs ?? DECISION_POLL_MS
    this.#decisionTimeoutMs = deps.decisionTimeoutMs ?? DECISION_TIMEOUT_MS
    this.#connectRetryMs = deps.connectRetryMs ?? CONNECT_RETRY_MS
  }

  get state(): ConnectionState {
    return this.#state
  }

  /** The registered device this browser is, once it has paired. */
  get deviceId(): string | null {
    return this.#keyring.deviceId
  }

  /**
   * What the desktop said it can serve. Empty until a connection has been
   * made: a screen must hide an unsupported action rather than offer it and
   * fail, so an empty list disables everything rather than assuming it works.
   */
  get capabilities(): readonly string[] {
    return this.#capabilities
  }

  supports(operation: string): boolean {
    if (operation.startsWith('terminal.') && !this.#allowTerminal) return false
    return this.#capabilities.includes(operation)
  }

  /** A separate desktop approval is required for a phone-controlled shell. */
  get allowTerminal(): boolean {
    return this.#allowTerminal
  }

  get projectIds(): readonly string[] {
    return this.#projectIds
  }

  /** Whether a request can be attempted at all. */
  get usable(): boolean {
    return this.#token !== null && this.#state === 'connected'
  }

  /** Subscribes to state changes; returns an unsubscribe function. */
  watch(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  /**
   * Establishes the session, without a user in the loop.
   *
   * Called on every app start and on every return from the background. If this
   * browser holds a device key, the desktop hands back a fresh token; if it
   * does not, the caller is told to pair — never asked to retry something the
   * user cannot fix. A failure that could be the tailnet still waking up is
   * retried a few times before the UI is told anything is wrong.
   */
  async connect(signal?: AbortSignal): Promise<ConnectionState> {
    signal = this.#operationSignal(signal)
    signal?.throwIfAborted()
    await this.#keyring.load()
    signal?.throwIfAborted()
    const deviceId = this.#keyring.deviceId
    if (deviceId === null) return this.#set('unpaired')

    this.#set('connecting')
    for (let attempt = 0; ; attempt++) {
      try {
        // Asked before anything else is sent: a client that speaks a different
        // protocol should say so, not discover it from a failed command.
        const info = await this.#client.info()
        signal?.throwIfAborted()
        if (info.protocolVersion !== CLIENT_PROTOCOL_VERSION) {
          return this.#set('version-mismatch')
        }
        this.#capabilities = info.capabilities
        await this.#authorize(deviceId, signal)
        signal?.throwIfAborted()
        return this.#set('connected')
      } catch (error) {
        signal?.throwIfAborted()
        if (attempt + 1 >= CONNECT_ATTEMPTS || !retryable(error)) {
          return this.#set(stateForError(error))
        }
        await waitForRetry(this.#connectRetryMs * (attempt + 1), signal)
      }
    }
  }

  /**
   * Registers this browser's key against an invitation the desktop is showing,
   * and waits for the user to decide (ADR §9).
   *
   * The wait is the point of the flow, not an implementation detail: the phone
   * has no credential yet, so nothing can be pushed to it, and the desktop's
   * approval is what makes pairing a deliberate act rather than something a
   * photographed QR code accomplishes on its own. Polling is the honest
   * mechanism available at this one moment.
   */
  async pair(invitationId: string, displayName: string, signal?: AbortSignal): Promise<void> {
    signal = this.#operationSignal(signal)
    // Version 1 defines the anonymous handshake as mandatory. Negotiate before
    // creating any host-side invitation request, not after redeeming it.
    await this.negotiate(signal)
    signal?.throwIfAborted()
    const publicKey = await this.#keyring.publicKey()
    signal?.throwIfAborted()
    const { nonce, confirmationCode } = await this.#client.pairRequest(
      invitationId,
      displayName,
      publicKey,
    )
    this.#onPairCode?.(confirmationCode)
    await this.#awaitDecision(invitationId, signal)
    const signature = await this.#keyring.sign(nonce)
    signal?.throwIfAborted()
    await this.negotiate(signal)
    const redeemed = await this.#client.pairRedeem(invitationId, { nonce, signature })
    signal?.throwIfAborted()
    this.#useToken(redeemed.token, signal)
    await this.#keyring.remember({ deviceId: redeemed.deviceId, displayName, projectIds: [] })
    signal.throwIfAborted()
    await this.#authorize(redeemed.deviceId, signal)
    this.#set('connected')
  }

  /** Waits for the desktop's decision, and reports it as the user would see it. */
  async #awaitDecision(invitationId: string, signal?: AbortSignal): Promise<void> {
    const deadline = Date.now() + this.#decisionTimeoutMs
    for (;;) {
      signal?.throwIfAborted()
      const status = await this.#client.pairStatus(invitationId)
      signal?.throwIfAborted()
      if (status === 'approved') return
      if (status === 'denied') {
        throw new RemoteError('pairing_denied', 'this device was not approved')
      }
      if (status === 'expired') {
        throw new RemoteError('invitation_expired', 'the invitation expired')
      }
      if (status === 'redeemed') {
        // Someone redeemed it, and it was not this attempt: the invitation is
        // single use, and saying so is better than looping forever.
        throw new RemoteError('invitation_used', 'this invitation was already used')
      }
      if (Date.now() >= deadline) {
        throw new RemoteError('invitation_expired', 'the desktop did not answer in time')
      }
      await waitForRetry(this.#decisionPollMs, signal)
    }
  }

  /** Trades the short code on the desktop's screen for the invitation it names. */
  async resolvePairingCode(code: string, signal?: AbortSignal): Promise<string> {
    signal = this.#operationSignal(signal)
    await this.negotiate(signal)
    const invitationId = await this.#client.pairResolve(code)
    signal.throwIfAborted()
    return invitationId
  }

  /** Validate the mandatory handshake version and any requested host operations. */
  async negotiate(signal?: AbortSignal, requiredCapabilities: readonly string[] = []): Promise<void> {
    signal = this.#operationSignal(signal)
    signal?.throwIfAborted()
    const info = await this.#client.info()
    signal?.throwIfAborted()
    if (info.protocolVersion !== CLIENT_PROTOCOL_VERSION) {
      this.#set('version-mismatch')
      throw new RemoteError('unsupported_version', 'Update Ari on your computer to use this version.')
    }
    this.#capabilities = info.capabilities
    for (const operation of requiredCapabilities) {
      if (!info.capabilities.includes(operation as never)) {
        throw new RemoteError('unsupported_capability', `This computer does not support ${operation}.`)
      }
    }
  }

  /** Dispose credentials held in memory when their owning computer is removed. */
  disconnect(): void {
    this.#lifecycle.abort(new DOMException('Computer connection disposed.', 'AbortError'))
    for (const unsubscribe of [...this.#subscriptions]) unsubscribe()
    this.#lifecycle = new AbortController()
    this.#token = null
    this.#client.token = null
    this.#client.lease = null
    this.#allowTerminal = false
    this.#projectIds = []
    this.#capabilities = []
    this.#set('unpaired')
  }

  /** What the desktop currently thinks of this device's registration. */
  async pairingStatus(invitationId: string, signal?: AbortSignal): Promise<string> {
    signal = this.#operationSignal(signal)
    const status = await this.#client.pairStatus(invitationId)
    signal.throwIfAborted()
    return status
  }

  /**
   * Sends a mutation, with the retry behaviour a phone needs.
   *
   * The key is minted once and reused for every attempt: if the first request
   * arrived and the response was lost, the retry is recognized and the
   * recorded outcome is returned instead of the work happening twice. A
   * command that fails for a reason the desktop can explain is not retried at
   * all — repeating it would ask the same question and get the same answer.
   */
  async send<T extends { op: string }>(envelope: T, idempotencyKey = mintKey()): Promise<unknown> {
    const signal = this.#operationSignal()
    await this.#renewLease(false, signal)
    const body = {
      ...envelope,
      clientCommandId: idempotencyKey,
      idempotencyKey,
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const result = await this.#client.command(body)
        signal.throwIfAborted()
        return result
      } catch (error) {
        signal.throwIfAborted()
        if (!(error instanceof RemoteError)) throw error
        if (error.code === 'unauthenticated' || error.code === 'authentication_expired') {
          // The token aged out. Renewing it is invisible to the user, and is
          // why the device key exists.
          await this.#reauth(signal)
          continue
        }
        if (error.code === 'unreachable' && attempt === 0) {
          // The request may or may not have arrived. Asking about the key is
          // the only way to tell, and it is what keeps a prompt from being
          // sent twice.
          const outcome = await this.#reconcile(idempotencyKey, signal)
          if (outcome !== undefined) return outcome
          continue
        }
        throw error
      }
    }
    throw new RemoteError('unreachable', 'the desktop did not answer')
  }

  /** A read, renewed once if the token has aged out. */
  async query<T>(op: string, params: Record<string, unknown> = {}): Promise<T> {
    const signal = this.#operationSignal()
    await this.#renewLease(false, signal)
    try {
      const result = await this.#client.query<T>(op, params)
      signal.throwIfAborted()
      return result
    } catch (error) {
      signal.throwIfAborted()
      if (
        error instanceof RemoteError &&
        (error.code === 'unauthenticated' || error.code === 'authentication_expired')
      ) {
        await this.#reauth(signal)
        const result = await this.#client.query<T>(op, params)
        signal.throwIfAborted()
        return result
      }
      throw error
    }
  }

  /** Opens the event stream for a session, renewing the token if it must. */
  subscribe(
    sessionId: string,
    options: {
      fromSeq?: number
      onFrame: (frame: unknown) => void
      onClose: (info: { code: number; reason: string }) => void
    },
  ): () => void {
    let disposed = false
    let close: (() => void) | null = null
    let renewal: ReturnType<typeof setTimeout> | null = null
    const renewalController = new AbortController()
    const signal = this.#operationSignal(renewalController.signal)
    let cursor = options.fromSeq
    const onFrame = (message: RemoteServerMessage): void => {
      if (disposed || signal.aborted) return
      if (message.type === 'events.frame')
        for (const event of message.events) cursor = Math.max(cursor ?? 0, event.seq)
      options.onFrame(message)
    }
    const onClose = (info: { code: number; reason: string }): void => {
      if (disposed || signal.aborted) return
      renewalController.abort()
      if (renewal !== null) clearTimeout(renewal)
      renewal = null
      // A private gateway policy close is a refusal. Other unexpected closes
      // (including a managed lease expiring) need a fresh authorization cycle.
      if (info.code === 1008 && this.#managed === null) this.#set('revoked')
      else if (
        info.code !== 1000 &&
        !['revoked', 'unknown-device', 'version-mismatch', 'unpaired'].includes(this.#state)
      )
        this.#set('reconnecting')
      options.onClose(info)
    }
    const open = (): void => {
      if (disposed || signal.aborted) return
      close = this.#client.subscribe(sessionId, {
        ...(cursor === undefined ? {} : { fromSeq: cursor }),
        onFrame,
        onClose,
      })
      if (this.#managed !== null)
        renewal = setTimeout(() => {
          renewal = null
          void this.#renewLease(true, signal)
            .then(() => {
              if (!disposed && !signal.aborted) {
                close?.()
                open()
              }
            })
            .catch((error: unknown) => {
              if (!disposed && !signal.aborted) {
                close?.()
                onClose({
                  code: 1013,
                  reason: error instanceof Error ? error.message : 'Membership renewal failed.',
                })
              }
            })
        }, 45000)
    }
    open()
    const unsubscribe = (): void => {
      disposed = true
      renewalController.abort()
      close?.()
      if (renewal !== null) clearTimeout(renewal)
      this.#subscriptions.delete(unsubscribe)
    }
    this.#subscriptions.add(unsubscribe)
    return unsubscribe
  }

  #set(state: ConnectionState): ConnectionState {
    if (this.#state !== state) {
      this.#state = state
      this.#onState?.(state)
    }
    for (const listener of this.#listeners) listener()
    return state
  }

  /** Exchanges a signature over a fresh nonce for a new token. */
  async #authorize(deviceId: string, signal?: AbortSignal): Promise<void> {
    signal = this.#operationSignal(signal)
    signal?.throwIfAborted()
    const { nonce } = await this.#client.deviceChallenge(deviceId)
    signal?.throwIfAborted()
    const signature = await this.#keyring.sign(nonce)
    signal?.throwIfAborted()
    const authorized = await this.#client.deviceAuthorize(deviceId, { nonce, signature })
    signal?.throwIfAborted()
    await this.#renewLease(false, signal)
    signal?.throwIfAborted()
    this.#useToken(authorized.token, signal)
    this.#projectIds = authorized.projectIds
    this.#allowTerminal = authorized.allowTerminal === true
  }

  async #renewLease(force = false, signal?: AbortSignal): Promise<void> {
    signal = this.#operationSignal(signal)
    signal?.throwIfAborted()
    if (this.#managed === null) return
    try {
      const lease = await this.#managed.token(force)
      signal?.throwIfAborted()
      this.#client.lease = lease
    } catch (error) {
      signal?.throwIfAborted()
      this.#client.lease = null
      this.#set('unreachable')
      throw error
    }
  }

  /** The one place the token moves, so it cannot be set but not installed. */
  #useToken(token: string, signal: AbortSignal): void {
    signal.throwIfAborted()
    this.#token = token
    this.#client.token = token
  }

  async #reauth(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    const deviceId = this.#keyring.deviceId
    if (deviceId === null) throw new RemoteError('unauthenticated', 'this browser is not paired')
    try {
      await this.#authorize(deviceId, signal)
      signal.throwIfAborted()
      this.#set('connected')
    } catch (error) {
      signal.throwIfAborted()
      this.#set(stateForError(error))
      throw error
    }
  }

  /** Asks the desktop what became of a command whose answer was lost. */
  async #reconcile(idempotencyKey: string, signal: AbortSignal): Promise<unknown> {
    try {
      const result = await this.#client.query('command.status', { idempotencyKey })
      signal.throwIfAborted()
      return result
    } catch (error) {
      signal.throwIfAborted()
      // A key the desktop never saw means the command never arrived, and the
      // caller is free to send it again under the same key.
      if (error instanceof RemoteError && error.code === 'not_found') return undefined
      // Anything still running reports as a conflict; the outcome is not
      // knowable yet, and guessing would be worse than saying so.
      if (error instanceof RemoteError && error.code === 'conflict') {
        throw new RemoteError('conflict', 'the desktop is still working on that')
      }
      throw error
    }
  }

  #operationSignal(signal?: AbortSignal): AbortSignal {
    const lifecycle = this.#lifecycle.signal
    return signal === undefined ? lifecycle : AbortSignal.any([lifecycle, signal])
  }
}

/** Cancelling a computer's lifecycle must also cancel its delayed attempts. */
function waitForRetry(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cancel = (): void => {
      clearTimeout(timer)
      reject(
        signal?.reason instanceof Error
          ? signal.reason
          : new DOMException('Connection cancelled.', 'AbortError'),
      )
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', cancel)
      resolve()
    }, ms)
    signal?.addEventListener('abort', cancel, { once: true })
    if (signal?.aborted === true) cancel()
  })
}

/**
 * Whether trying again could help. A refusal the desktop made on purpose —
 * revoked, unknown device, wrong version — will not change on retry, and
 * neither will a browser without a key.
 */
function retryable(error: unknown): boolean {
  return error instanceof RemoteError && error.retryable
}

function stateForError(error: unknown): ConnectionState {
  if (!(error instanceof RemoteError)) return 'unreachable'
  switch (error.code) {
    case 'access_revoked':
      return 'revoked'
    case 'not_found':
      // The desktop does not know this device id: its records were reset, or
      // this browser's storage outlived them.
      return 'unknown-device'
    case 'unsupported_version':
      return 'version-mismatch'
    case 'unauthenticated':
    case 'authentication_expired':
    case 'invalid_signature':
      return 'unpaired'
    default:
      return 'unreachable'
  }
}

/** High-entropy enough that two commands cannot collide; long enough to pass. */
function mintKey(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}
