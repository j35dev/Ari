import { GatewayClient, RemoteError } from './gateway-client'
import type { DeviceKeyring } from './device-key'

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
  keyring: DeviceKeyring
  /** Called whenever the state changes, for the UI banner. */
  onState?: (state: ConnectionState) => void
  /** How often to ask whether the desktop has decided. Tests shorten it. */
  decisionPollMs?: number
  /** How long to wait for that decision before giving up. */
  decisionTimeoutMs?: number
}

/** The protocol this build speaks; the gateway answers with its own. */
export const CLIENT_PROTOCOL_VERSION = 1

/** An invitation lives five minutes; the wait must not outlast it. */
const DECISION_POLL_MS = 1000
const DECISION_TIMEOUT_MS = 5 * 60 * 1000

export class MobileSession {
  readonly #client: GatewayClient
  readonly #keyring: DeviceKeyring
  readonly #onState: ((state: ConnectionState) => void) | undefined
  readonly #decisionPollMs: number
  readonly #decisionTimeoutMs: number
  #state: ConnectionState = 'unpaired'
  #token: string | null = null
  /** Resolved project ids the desktop reported at the last authorization. */
  #projectIds: string[] = []
  #listeners = new Set<() => void>()

  constructor(deps: SessionDeps) {
    this.#client = deps.client
    this.#keyring = deps.keyring
    this.#onState = deps.onState
    this.#decisionPollMs = deps.decisionPollMs ?? DECISION_POLL_MS
    this.#decisionTimeoutMs = deps.decisionTimeoutMs ?? DECISION_TIMEOUT_MS
  }

  get state(): ConnectionState {
    return this.#state
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
   * user cannot fix.
   */
  async connect(): Promise<ConnectionState> {
    await this.#keyring.load()
    const deviceId = this.#keyring.deviceId
    if (deviceId === null) return this.#set('unpaired')

    this.#set('connecting')
    try {
      // Asked before anything else is sent: a client that speaks a different
      // protocol should say so, not discover it from a failed command.
      const info = await this.#client.info()
      if (info.protocolVersion !== CLIENT_PROTOCOL_VERSION) {
        return this.#set('version-mismatch')
      }
      await this.#authorize(deviceId)
      this.#set('connected')
    } catch (error) {
      this.#set(stateForError(error))
    }
    return this.#state
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
  async pair(invitationId: string, displayName: string): Promise<void> {
    const publicKey = await this.#keyring.publicKey()
    const { nonce } = await this.#client.pairRequest(invitationId, displayName, publicKey)
    await this.#awaitDecision(invitationId)
    const signature = await this.#keyring.sign(nonce)
    const redeemed = await this.#client.pairRedeem(invitationId, { nonce, signature })
    this.#useToken(redeemed.token)
    await this.#keyring.remember({ deviceId: redeemed.deviceId, displayName, projectIds: [] })
    this.#set('connected')
  }

  /** Waits for the desktop's decision, and reports it as the user would see it. */
  async #awaitDecision(invitationId: string): Promise<void> {
    const deadline = Date.now() + this.#decisionTimeoutMs
    for (;;) {
      const status = await this.#client.pairStatus(invitationId)
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
      await new Promise((resolve) => setTimeout(resolve, this.#decisionPollMs))
    }
  }

  /** What the desktop currently thinks of this device's registration. */
  async pairingStatus(invitationId: string): Promise<string> {
    return this.#client.pairStatus(invitationId)
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
  async send<T extends { op: string }>(
    envelope: T,
  ): Promise<unknown> {
    const idempotencyKey = mintKey()
    const body = {
      ...envelope,
      clientCommandId: idempotencyKey,
      idempotencyKey,
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await this.#client.command(body)
      } catch (error) {
        if (!(error instanceof RemoteError)) throw error
        if (error.code === 'unauthenticated' || error.code === 'authentication_expired') {
          // The token aged out. Renewing it is invisible to the user, and is
          // why the device key exists.
          await this.#reauth()
          continue
        }
        if (error.code === 'unreachable' && attempt === 0) {
          // The request may or may not have arrived. Asking about the key is
          // the only way to tell, and it is what keeps a prompt from being
          // sent twice.
          const outcome = await this.#reconcile(idempotencyKey)
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
    try {
      return await this.#client.query<T>(op, params)
    } catch (error) {
      if (error instanceof RemoteError && error.code === 'unauthenticated') {
        await this.#reauth()
        return await this.#client.query<T>(op, params)
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
    return this.#client.subscribe(sessionId, {
      ...(options.fromSeq === undefined ? {} : { fromSeq: options.fromSeq }),
      onFrame: (message) => options.onFrame(message),
      onClose: (info) => {
        // 1006 is an abnormal close — the phone lost the network, or the
        // desktop went away. Anything the gateway closed deliberately is
        // reported as it was, because the reason is on screen.
        if (info.code === 1006) this.#set('reconnecting')
        else if (info.code === 1008) this.#set('revoked')
        options.onClose(info)
      },
    })
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
  async #authorize(deviceId: string): Promise<void> {
    const { nonce } = await this.#client.deviceChallenge(deviceId)
    const signature = await this.#keyring.sign(nonce)
    const authorized = await this.#client.deviceAuthorize(deviceId, { nonce, signature })
    this.#useToken(authorized.token)
    this.#projectIds = authorized.projectIds
  }

  /** The one place the token moves, so it cannot be set but not installed. */
  #useToken(token: string): void {
    this.#token = token
    this.#client.token = token
  }

  async #reauth(): Promise<void> {
    const deviceId = this.#keyring.deviceId
    if (deviceId === null) throw new RemoteError('unauthenticated', 'this browser is not paired')
    try {
      await this.#authorize(deviceId)
      this.#set('connected')
    } catch (error) {
      this.#set(stateForError(error))
      throw error
    }
  }

  /** Asks the desktop what became of a command whose answer was lost. */
  async #reconcile(idempotencyKey: string): Promise<unknown | undefined> {
    try {
      return await this.#client.query('command.status', { idempotencyKey })
    } catch (error) {
      // A key the desktop never saw means the command never arrived, and the
      // caller is free to send it again under the same key.
      if (error instanceof RemoteError && error.code === 'not_found') return undefined
      // Anything still running reports as a conflict; the outcome is not
      // knowable yet, and guessing would be worse than saying so.
      if (error instanceof RemoteError && error.code === 'conflict') {
        throw new RemoteError('conflict', 'the desktop is still working on that')
      }
      return undefined
    }
  }
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
