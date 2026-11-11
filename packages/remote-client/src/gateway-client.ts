import type { GatewayInfo, PairingStatus, RemoteErrorCode } from '@ari/contracts/remote'
import type { RemoteClientMessage, RemoteServerMessage } from '@ari/contracts/remote'

/**
 * The client half of the remote protocol.
 *
 * Deliberately thin: it turns the gateway's JSON envelopes into values and
 * named failures, and does nothing else. Every decision about *when* to retry,
 * re-authorize, or ask the user belongs to the session layer above it, which
 * is the part that has to reason about a phone that was asleep for an hour.
 *
 * The wire shapes come from `@ari/contracts/remote` — the same module the
 * gateway validates with — so a protocol change breaks this at compile time
 * rather than at the user's expense.
 */

/**
 * A failure the gateway named, or one this client has to name itself.
 *
 * `unreachable` is the transport's: nothing answered, so nothing is known.
 * `pairing_denied` is the user's: the desktop said no, which is a decision
 * rather than an error worth retrying.
 */
export type RemoteFailure = RemoteErrorCode | 'unreachable' | 'pairing_denied'

/** A failure with a name, so the UI can say what happened, not merely that it failed. */
export class RemoteError extends Error {
  readonly code: RemoteFailure
  readonly status: number

  constructor(code: RemoteFailure, message: string, status = 0) {
    super(message)
    this.name = 'RemoteError'
    this.code = code
    this.status = status
  }

  /** Whether asking again could work: the request never reached a decision. */
  get retryable(): boolean {
    return (
      this.code === 'unreachable' || this.code === 'internal_error' || this.code === 'rate_limited'
    )
  }
}

export interface GatewayClientOptions {
  /** Origin the gateway is reached at, e.g. `https://ari.tailnet.ts.net`. */
  origin: string
  /** Injected for tests; defaults to the platform fetch. */
  fetch?: typeof fetch
  /** Injected for tests; defaults to the platform WebSocket. */
  webSocket?: (url: string, protocols: string[]) => WebSocket
}

interface Envelope<T> {
  ok: boolean
  result?: T
  error?: { code: RemoteErrorCode; message: string }
}

const WIRE_PROTOCOL = 'ari-remote.v1'

export class GatewayClient {
  readonly #origin: string
  readonly #fetch: typeof fetch
  readonly #webSocket: (url: string, protocols: string[]) => WebSocket
  /** Held in memory only: the device key, not this, is the durable credential. */
  #token: string | null = null
  #lease: string | null = null

  constructor(options: GatewayClientOptions) {
    this.#origin = options.origin.replace(/\/+$/, '')
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init))
    this.#webSocket =
      options.webSocket ??
      ((url, protocols) => {
        // The credential rides in the subprotocol list because a browser
        // cannot set headers on a WebSocket handshake, and the managed tunnel
        // in front of the gateway logs request URLs.
        return new WebSocket(url, protocols)
      })
  }

  get origin(): string {
    return this.#origin
  }

  /**
   * The operational token, set by the session layer. Deliberately a property
   * rather than a constructor argument: it changes over the life of a phone
   * session, and a getter captured at startup would keep sending the first one.
   */
  set token(value: string | null) {
    this.#token = value
  }

  /** Managed access requires both the paired-device token and this short-lived lease. */
  set lease(value: string | null) {
    this.#lease = value
  }

  /** Unauthenticated and content-free: what protocol is this, what can it do. */
  async info(): Promise<GatewayInfo> {
    return this.#post<GatewayInfo>('/info', {})
  }

  async pairRequest(
    invitationId: string,
    displayName: string,
    publicKey: { kty: 'EC'; crv: 'P-256'; x: string; y: string },
  ): Promise<{ confirmationCode: string; nonce: string }> {
    return this.#post('/pair/request', { invitationId, displayName, publicKey })
  }

  /** The invitation behind a code the user typed because the app cannot scan a QR. */
  async pairResolve(code: string): Promise<string> {
    const { invitationId } = await this.#post<{ invitationId: string }>('/pair/resolve', { code })
    return invitationId
  }

  async pairStatus(invitationId: string): Promise<PairingStatus> {
    const { status } = await this.#post<{ status: PairingStatus }>('/pair/status', { invitationId })
    return status
  }

  async pairRedeem(
    invitationId: string,
    proof: { nonce: string; signature: string },
  ): Promise<{ deviceId: string; token: string }> {
    return this.#post('/pair/redeem', { invitationId, ...proof })
  }

  /** A nonce for a remembered device to sign. Issued whether or not it exists. */
  async deviceChallenge(deviceId: string): Promise<{ nonce: string }> {
    return this.#post('/device/challenge', { deviceId })
  }

  async deviceAuthorize(
    deviceId: string,
    proof: { nonce: string; signature: string },
  ): Promise<{ deviceId: string; token: string; projectIds: string[]; allowTerminal?: boolean }> {
    return this.#post('/device/authorize', { deviceId, ...proof })
  }

  /** A read. Carries no idempotency key, because it changes nothing. */
  async query<T>(op: string, params: Record<string, unknown> = {}): Promise<T> {
    return this.#post<T>('/query', { op, ...params }, true)
  }

  /** A mutation. The envelope carries the key that makes a retry safe. */
  async command<T>(envelope: {
    op: string
    clientCommandId: string
    idempotencyKey: string
    [key: string]: unknown
  }): Promise<T> {
    return this.#post<T>('/command', envelope, true)
  }

  /**
   * Opens the event stream for one session. Returns a close function.
   *
   * `fromSeq` is the resume point: the snapshot the caller took carries the
   * sequence it was taken at, so subscribing from it shows neither a gap nor a
   * duplicate. The caller handles reconnection; this only reports what
   * arrived, including the server saying the client has fallen too far behind.
   */
  subscribe(
    sessionId: string,
    options: {
      fromSeq?: number
      onFrame: (message: RemoteServerMessage) => void
      onClose?: (event: { code: number; reason: string }) => void
    },
  ): () => void {
    const token = this.#token
    const protocols = token === null ? [WIRE_PROTOCOL] : [WIRE_PROTOCOL, `bearer.${token}`]
    if (this.#lease !== null) protocols.push(`lease.${this.#lease}`)
    const url = `${this.#origin.replace(/^http/, 'ws')}/events`
    const socket = this.#webSocket(url, protocols)
    let closed = false

    socket.addEventListener('open', () => {
      const subscribe: RemoteClientMessage = {
        type: 'events.subscribe',
        sessionId,
        ...(options.fromSeq === undefined ? {} : { fromSeq: options.fromSeq }),
      }
      socket.send(JSON.stringify(subscribe))
    })
    socket.addEventListener('message', (event) => {
      const data = typeof event.data === 'string' ? event.data : ''
      try {
        options.onFrame(JSON.parse(data) as RemoteServerMessage)
      } catch (error) {
        console.warn('Ari received an unreadable activity frame', error)
      }
    })
    socket.addEventListener('close', (event) => {
      if (closed) return
      options.onClose?.({ code: event.code, reason: event.reason })
    })

    return () => {
      closed = true
      socket.close()
    }
  }

  async #post<T>(path: string, body: unknown, authenticated = false): Promise<T> {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (authenticated) {
      const token = this.#token
      if (token === null) throw new RemoteError('unauthenticated', 'this device has no session yet')
      headers['authorization'] = `Bearer ${token}`
      if (this.#lease !== null) headers['x-ari-connect-lease'] = this.#lease
    }

    let response: Response
    try {
      response = await this.#fetch(`${this.#origin}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      })
    } catch (error) {
      // No response at all: the phone cannot tell a sleeping desktop from a
      // dropped connection, and the caller is the one that knows how long it
      // has been trying.
      throw new RemoteError('unreachable', error instanceof Error ? error.message : 'unreachable')
    }

    const envelope = (await response.json().catch(() => null)) as Envelope<T> | null
    if (envelope === null) {
      throw new RemoteError('internal_error', 'the gateway sent nothing readable', response.status)
    }
    if (envelope.ok) return envelope.result as T

    const code = envelope.error?.code ?? 'internal_error'
    throw new RemoteError(code, envelope.error?.message ?? 'the gateway refused', response.status)
  }
}
