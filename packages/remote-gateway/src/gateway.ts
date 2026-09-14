import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import { z } from 'zod'
import {
  REMOTE_PROTOCOL_VERSION,
  remoteClientMessageSchema,
  remoteCommandEnvelopeSchema,
  remoteErrorCodeSchema,
  remoteQuerySchema,
  requiresAuthentication,
  type RemoteErrorCode,
} from '@ari/contracts/remote'
import type { RemoteCaller, RemoteHost } from './host'
import { IdempotencyStore } from './idempotency'
import { isOriginAllowed, requestOrigin } from './origin'
import { PairingService, type PairedDevice } from './pairing'
import { acceptUpgrade, isWebSocketUpgrade } from './ws'

/**
 * The remote gateway (ADR §3, §5, §19).
 *
 * Listens on loopback only. Every request is checked against the origin
 * allowlist before anything else, then against the operation allowlist, then
 * against the device's credential — three independent refusals, and a request
 * has to survive all of them to reach the host. Remote clients are not the
 * renderer: the host they reach through {@linkcode RemoteHost} is narrower
 * than the engine's RPC, and the agent control socket is not reachable here at
 * all.
 */

/** Commands carry text and attachment ids; a megabyte is far more than one. */
const MAX_BODY_BYTES = 1024 * 1024

export interface RemoteGatewayOptions {
  host: RemoteHost
  /** Exact origins, never a wildcard. A gateway with none refuses everything. */
  allowedOrigins: readonly string[]
  /** 0 asks the OS for a free port, which is what tests want. */
  port?: number
  pairing?: PairingService
  now?: () => number
}

export interface RemoteGateway {
  readonly port: number
  /** The origin clients should talk to, as the desktop would display it. */
  readonly origin: string
  /**
   * Exposed for the desktop's own use — minting an invitation and approving a
   * device happen in-process, deliberately, and have no HTTP route.
   */
  readonly pairing: PairingService
  close(): Promise<void>
}

export async function createRemoteGateway(options: RemoteGatewayOptions): Promise<RemoteGateway> {
  const host = options.host
  const allowedOrigins = [...options.allowedOrigins]
  const pairing = options.pairing ?? new PairingService()
  const idempotency = new IdempotencyStore<unknown>({ now: options.now })
  const sockets = new Set<Socket>()

  const server = createServer((req, res) => {
    handle(req, res).catch(() => {
      // A handler that throws has already lost the request; answering now is
      // better than leaving the client waiting for a socket timeout.
      if (!res.headersSent) send(res, 500, fail('internal_error', 'the gateway failed'))
      else res.end()
    })
  })

  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname !== '/events' || !isWebSocketUpgrade(req)) {
      return refuseUpgrade(socket, 404)
    }
    // Checked here as well as in `handle`, because node routes an upgrade to
    // this listener instead once one is registered — the request handler's
    // check no longer sees it.
    if (!isOriginAllowed(requestOrigin(req.headers), allowedOrigins)) {
      return refuseUpgrade(socket, 403)
    }
    const protocols = offeredProtocols(req)
    const token = bearerToken(protocols)
    const device = token === undefined ? undefined : pairing.authenticate(token)
    if (device === undefined) return refuseUpgrade(socket, 401)
    pairing.touch(device.deviceId)

    const connection = acceptUpgrade(
      req,
      socket,
      head,
      protocols.includes(WIRE_PROTOCOL) ? WIRE_PROTOCOL : undefined,
    )
    attachEvents(connection, callerOf(device))
  })

  function attachEvents(
    connection: ReturnType<typeof acceptUpgrade>,
    caller: RemoteCaller,
  ): void {
    const subscriptions = new Map<string, () => void>()

    const teardown = (): void => {
      for (const unsubscribe of subscriptions.values()) unsubscribe()
      subscriptions.clear()
      connection.close(1000, 'unsubscribed')
    }

    const send = (message: unknown): void => connection.send(JSON.stringify(message))

    connection.onMessage((text) => {
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        return send(errorMessage('unsupported_capability', 'malformed message'))
      }
      const message = remoteClientMessageSchema.safeParse(parsed)
      if (!message.success) {
        return send(errorMessage('unsupported_capability', 'unsupported message'))
      }

      if (message.data.type === 'events.unsubscribe') {
        subscriptions.get(message.data.sessionId)?.()
        subscriptions.delete(message.data.sessionId)
        return
      }
      if (message.data.type === 'events.ack') return // flow control, not state
      if (subscriptions.has(message.data.sessionId)) return // already subscribed

      const { sessionId } = message.data
      if (!host.capabilities().includes('events.subscribe')) {
        return send(errorMessage('unsupported_capability', 'this host cannot stream events'))
      }
      subscriptions.set(
        sessionId,
        host.subscribe(caller, sessionId, (event) => {
          // A subscription outlives the moment it was authorised, so liveness
          // is re-checked at delivery: a device revoked mid-stream must stop
          // receiving the user's transcript, not finish the session first.
          if (!pairing.isDeviceActive(caller.deviceId)) return teardown()
          if (!connection.open) return teardown()
          send({ type: 'events.frame', sessionId, events: [{ seq: event.seq, event }] })
        }),
      )
    })

    connection.onClose(() => {
      for (const unsubscribe of subscriptions.values()) unsubscribe()
      subscriptions.clear()
    })
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')

    if (!isOriginAllowed(requestOrigin(req.headers), allowedOrigins)) {
      return send(res, 403, fail('origin_not_allowed', 'origin is not allowed'))
    }

    if (url.pathname === '/info') {
      return send(res, 200, {
        protocolVersion: REMOTE_PROTOCOL_VERSION,
        capabilities: [...host.capabilities()],
      })
    }

    const body = await readBody(req, res)
    if (body === undefined) return

    switch (url.pathname) {
      case '/pair/request':
        return pairRequest(res, body)
      case '/pair/status':
        return pairStatus(res, body)
      case '/pair/redeem':
        return pairRedeem(res, body)
      case '/command':
        return command(req, res, body)
      case '/query':
        return query(req, res, body)
      default:
        return send(res, 404, fail('not_found', 'no such route'))
    }
  }

  function pairRequest(res: ServerResponse, body: unknown): void {
    const parsed = pairingRequestSchema.safeParse(body)
    if (!parsed.success) return send(res, 400, fail('unsupported_capability', 'malformed request'))
    const result = pairing.request(parsed.data.invitationId, {
      displayName: parsed.data.displayName,
      publicKey: parsed.data.publicKey,
    })
    if (!result.ok) return send(res, statusFor(result.code), fail(result.code, 'pairing refused'))
    return send(res, 200, { ok: true, result: { confirmationCode: result.pending.confirmationCode } })
  }

  function pairStatus(res: ServerResponse, body: unknown): void {
    const parsed = pairingStatusQuery.safeParse(body)
    if (!parsed.success) return send(res, 400, fail('unsupported_capability', 'malformed request'))
    const status = pairing.status(parsed.data.invitationId)
    if (status === undefined) return send(res, 404, fail('not_found', 'unknown invitation'))
    return send(res, 200, { ok: true, result: { status } })
  }

  function pairRedeem(res: ServerResponse, body: unknown): void {
    const parsed = pairingRedeemSchema.safeParse(body)
    if (!parsed.success) return send(res, 400, fail('unsupported_capability', 'malformed request'))
    const result = pairing.redeem(parsed.data.invitationId, {
      nonce: parsed.data.nonce,
      signature: parsed.data.signature,
    })
    if (!result.ok) return send(res, statusFor(result.code), fail(result.code, 'redemption refused'))
    return send(res, 200, {
      ok: true,
      result: { deviceId: result.device.deviceId, token: result.token },
    })
  }

  async function command(req: IncomingMessage, res: ServerResponse, body: unknown): Promise<void> {
    const parsed = remoteCommandEnvelopeSchema.safeParse(body)
    if (!parsed.success) {
      // Covers an operation with no schema, and a field the envelope does not
      // declare: both are "this gateway does not do that", and neither may
      // reach the host to be quietly ignored.
      return send(res, 400, fail('unsupported_capability', 'unsupported command'))
    }
    const command = parsed.data

    // No command operation is anonymous — a contracts test pins that — so an
    // envelope that parsed has no route without a device.
    const device = authenticate(req)
    if (device === undefined) {
      return send(res, 401, fail('unauthenticated', 'a device credential is required'))
    }
    if (!host.capabilities().includes(command.op)) {
      return send(res, 400, fail('unsupported_capability', 'this host cannot do that'))
    }

    const outcome = idempotency.begin(command.idempotencyKey, command)
    if (outcome.outcome === 'conflict') {
      return send(res, 409, fail('idempotency_conflict', 'that key was used for another command'))
    }
    if (outcome.outcome === 'in_flight') {
      return send(res, 409, fail('conflict', 'that command is still running'))
    }
    if (outcome.outcome === 'replay') {
      // A replayed failure carries no result — the store records that it
      // failed, not what it said. Reporting the refusal is the honest answer;
      // a bodyless 200 would read as success to a client that lost the first
      // response, which is the only client that asks.
      if (outcome.result === undefined) {
        return send(res, 409, fail('conflict', 'that command already failed; retry under a new key'))
      }
      return send(res, 200, outcome.result)
    }

    const result = await host.execute(callerOf(device), command)
    if (result.ok) {
      idempotency.complete(command.idempotencyKey, result)
      return send(res, 200, result)
    }
    // Recorded, so a retry sees the same refusal rather than re-running a
    // command that already failed for a reason that has not changed.
    idempotency.fail(command.idempotencyKey)
    const code = asErrorCode(result.code)
    return send(res, statusFor(code), { ok: false, error: { code, message: result.message } })
  }

  async function query(req: IncomingMessage, res: ServerResponse, body: unknown): Promise<void> {
    const parsed = remoteQuerySchema.safeParse(body)
    if (!parsed.success) {
      return send(res, 400, fail('unsupported_capability', 'unsupported query'))
    }
    const requested = parsed.data

    const device = authenticate(req)
    if (device === undefined && requiresAuthentication(requested.op)) {
      return send(res, 401, fail('unauthenticated', 'a device credential is required'))
    }

    // Answered here rather than by the host: the protocol version is the
    // gateway's own, and the capabilities are asked of the host directly. This
    // is the one operation that has to work before anyone holds a credential,
    // and it carries no user content — a version and a list of operation
    // names, so a client can tell what it is speaking to without learning
    // anything about the machine.
    if (requested.op === 'gateway.info') {
      return send(res, 200, {
        ok: true,
        result: {
          protocolVersion: REMOTE_PROTOCOL_VERSION,
          capabilities: [...host.capabilities()],
        },
      })
    }

    if (requested.op === 'command.status') {
      const record = idempotency.lookup(requested.idempotencyKey)
      if (record === undefined) return send(res, 404, fail('not_found', 'no such key'))
      // Only the outcome goes back, not the store's own bookkeeping — when the
      // record was written is the gateway's business.
      if (record.failed) {
        return send(res, 409, fail('conflict', 'that command already failed'))
      }
      if (record.result === undefined) {
        return send(res, 409, fail('conflict', 'that command is still running'))
      }
      return send(res, 200, { ok: true, result: record.result })
    }
    // Everything past this point reaches the host, which is the user's data.
    // `gateway.info` and every anonymous operation are answered above, so a
    // device that is missing here is missing because the operation is guarded.
    if (device === undefined) {
      return send(res, 401, fail('unauthenticated', 'a device credential is required'))
    }
    if (!host.capabilities().includes(requested.op)) {
      return send(res, 400, fail('unsupported_capability', 'this host cannot do that'))
    }

    const { op, ...params } = requested
    const result = await host.query(callerOf(device), op, params)
    return send(res, 200, { ok: true, result })
  }

  function authenticate(req: IncomingMessage): PairedDevice | undefined {
    const header = req.headers.authorization
    if (typeof header !== 'string' || !header.toLowerCase().startsWith('bearer ')) return undefined
    const token = header.slice(7).trim()
    if (token.length === 0) return undefined
    const device = pairing.authenticate(token)
    if (device === undefined) return undefined
    pairing.touch(device.deviceId)
    return device
  }

  async function readBody(req: IncomingMessage, res: ServerResponse): Promise<unknown> {
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of req) {
      const buffer = chunk as Buffer
      size += buffer.length
      if (size > MAX_BODY_BYTES) {
        send(res, 413, fail('unsupported_capability', 'request body is too large'))
        return undefined
      }
      chunks.push(buffer)
    }
    if (size === 0) {
      send(res, 400, fail('unsupported_capability', 'a JSON body is required'))
      return undefined
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
    } catch {
      send(res, 400, fail('unsupported_capability', 'malformed JSON'))
      return undefined
    }
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    // Loopback only (ADR §19): never a routable bind by default. Reaching a
    // phone is Tailscale's or the tunnel's job, not this socket's.
    server.listen(options.port ?? 0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const { port } = server.address() as AddressInfo

  return {
    port,
    origin: `http://127.0.0.1:${port}`,
    pairing,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
        // Keep-alive connections would otherwise hold the server open.
        server.closeAllConnections()
        for (const socket of sockets) socket.destroy()
        sockets.clear()
      }),
  }
}

const pairingRequestSchema = z.object({
  invitationId: z.string().min(1),
  displayName: z.string().min(1).max(80),
  publicKey: z.object({
    kty: z.literal('EC'),
    crv: z.literal('P-256'),
    x: z.string().min(1),
    y: z.string().min(1),
  }),
})

const pairingStatusQuery = z.object({ invitationId: z.string().min(1) })

/**
 * The protocol version the client names in `Sec-WebSocket-Protocol`. A browser
 * cannot set headers on a WebSocket, so the subprotocol list is the one place
 * a credential can travel that is not the URL — which matters because the
 * managed tunnel in front of this gateway logs request URLs.
 */
const WIRE_PROTOCOL = 'ari-remote.v1'
const BEARER_PREFIX = 'bearer.'

function offeredProtocols(req: IncomingMessage): string[] {
  const raw = req.headers['sec-websocket-protocol']
  if (typeof raw !== 'string') return []
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
}

function bearerToken(protocols: readonly string[]): string | undefined {
  const entry = protocols.find((protocol) => protocol.startsWith(BEARER_PREFIX))
  if (entry === undefined) return undefined
  const token = entry.slice(BEARER_PREFIX.length)
  return token.length === 0 ? undefined : token
}

/** Answers an upgrade the gateway will not complete, then drops the socket. */
function refuseUpgrade(socket: Duplex, status: number): void {
  const reason = status === 401 ? 'Unauthorized' : status === 403 ? 'Forbidden' : 'Not Found'
  socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
  socket.destroy()
}

/**
 * Narrows a paired device to what the host may know about it. Constructed
 * field by field rather than passed whole, so a record that later grows a
 * provider token or a key does not start travelling into the host with it.
 */
function callerOf(device: PairedDevice): RemoteCaller {
  return { deviceId: device.deviceId, projectIds: [...device.projectIds] }
}

function errorMessage(code: RemoteErrorCode, message: string): unknown {
  return { type: 'error', error: { code, message } }
}

const pairingRedeemSchema = z.object({
  invitationId: z.string().min(1),
  nonce: z.string().min(1),
  signature: z.string().min(1),
})

function fail(code: RemoteErrorCode, message: string): { ok: false; error: { code: string; message: string } } {
  return { ok: false, error: { code, message } }
}

function asErrorCode(code: string): RemoteErrorCode {
  const parsed = remoteErrorCodeSchema.safeParse(code)
  return parsed.success ? parsed.data : 'internal_error'
}

/** The status is a coarse hint; the error code is what a client switches on. */
function statusFor(code: RemoteErrorCode): number {
  switch (code) {
    case 'unauthenticated':
    case 'authentication_expired':
      return 401
    case 'access_revoked':
    case 'origin_not_allowed':
      return 403
    case 'not_found':
      return 404
    case 'conflict':
    case 'idempotency_conflict':
    case 'stale_snapshot':
    case 'invitation_used':
      return 409
    case 'invitation_expired':
      return 410
    case 'rate_limited':
      return 429
    case 'internal_error':
      return 500
    default:
      return 400
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  // `JSON.stringify` returns undefined for a body that is not serializable,
  // and sizing that throws inside a header write turns a response into a
  // dropped connection. `null` is a body the client can parse.
  const payload = JSON.stringify(body) ?? 'null'
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
    // No wildcard, and no credentials for a cross-origin caller: the origin
    // allowlist above is the only thing that decides, and it never echoes.
    'cache-control': 'no-store',
  })
  res.end(payload)
}
