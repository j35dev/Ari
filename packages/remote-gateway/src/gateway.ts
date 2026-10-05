import { createReadStream } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { extname, join, resolve, sep } from 'node:path'
import type { Duplex } from 'node:stream'
import { z } from 'zod'
import {
  REMOTE_PROTOCOL_VERSION,
  MAX_REMOTE_IMAGE_BYTES,
  pairingResolveSchema,
  remoteClientMessageSchema,
  remoteCommandEnvelopeSchema,
  remoteErrorCodeSchema,
  remoteQuerySchema,
  requiresAuthentication,
  type RemoteErrorCode,
} from '@ari/contracts/remote'
import type { RemoteCaller, RemoteHost } from './host'
import type { JournalEvent } from '@ari/contracts/events'
import type { ConnectLeaseVerifier } from './connect-lease'
export { ConnectLeaseVerifier } from './connect-lease'
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
const MAX_IMAGE_BODY_BYTES = Math.ceil(MAX_REMOTE_IMAGE_BYTES / 3) * 4 + 4096

export interface RemoteGatewayOptions {
  host: RemoteHost
  /**
   * Exact origins, never a wildcard. A gateway with none refuses everything.
   * A function form is for a set that grows while the gateway runs — the
   * tailnet address of a wizard that has not run yet, say.
   */
  allowedOrigins: readonly string[] | (() => readonly string[])
  /** 0 asks the OS for a free port, which is what tests want. */
  port?: number
  /**
   * Directory holding the built PWA. Present, the gateway serves it from its
   * own origin, which is what makes the phone's app same-origin with the API
   * it calls under Tailscale (ADR §18); absent, the gateway serves only the
   * API and the managed layout serves the PWA from `connect.<domain>`.
   */
  webRoot?: string
  pairing?: PairingService
  now?: () => number
  /** Dedicated managed listener: absent verification fails closed. Local/Tailscale listeners omit this. */
  managedAccess?: { verifier: () => ConnectLeaseVerifier | null }
  /**
   * Where command deduplication records go if they are to outlive the
   * process. Absent, they live as long as the gateway does, which is exactly
   * as long as a client that retries after a crash needs them — the crash
   * that loses them is the one that also loses the gateway.
   */
  idempotency?: {
    restore?: string
    persist?: (json: string) => void
  }
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

interface RecordedOutcome {
  reply: { ok: true; result: unknown }
  sessionId?: string
  projectId?: string
}

export async function createRemoteGateway(options: RemoteGatewayOptions): Promise<RemoteGateway> {
  const host = options.host
  const pairing = options.pairing ?? new PairingService()
  const idempotency =
    options.idempotency?.restore === undefined
      ? new IdempotencyStore<RecordedOutcome>({ now: options.now })
      : IdempotencyStore.fromJSON<RecordedOutcome>(options.idempotency.restore)
  const remember = (): void => options.idempotency?.persist?.(idempotency.toJSON())
  // Shell handles cannot survive this gateway lifetime. Keep their high-volume
  // receipts separate so keyboard input cannot evict durable prompt receipts.
  const terminalReceipts = new IdempotencyStore<RecordedOutcome>({
    now: options.now,
    maxEntries: 10_000,
  })
  const sockets = new Set<Socket>()
  /**
   * The address this gateway is reachable at itself. Added to the allowlist
   * because the PWA it serves is same-origin with it, and a browser sends
   * `Origin` on a same-origin POST. Still one exact string, never a wildcard.
   */
  let selfOrigin: string | null = null
  /** The built PWA to serve, or null when this gateway serves only the API. */
  const webRoot = options.webRoot === undefined ? null : resolve(options.webRoot)

  const originAllowed = (origin: string | undefined): boolean => {
    if (typeof origin === 'string' && selfOrigin !== null && origin.toLowerCase() === selfOrigin) {
      return true
    }
    return isOriginAllowed(origin, allowedOriginsNow())
  }

  function allowedOriginsNow(): readonly string[] {
    return typeof options.allowedOrigins === 'function'
      ? options.allowedOrigins()
      : options.allowedOrigins
  }

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
    if (!originAllowed(requestOrigin(req.headers))) {
      return refuseUpgrade(socket, 403)
    }
    const protocols = offeredProtocols(req)
    const token = bearerToken(protocols)
    const device = token === undefined ? undefined : pairing.authenticate(token)
    if (device === undefined) return refuseUpgrade(socket, 401)
    pairing.touch(device.deviceId)

    const lease = authorizeManaged(
      protocols.find((value) => value.startsWith('lease.'))?.slice(6),
      device,
    )
    if (lease === null) return refuseUpgrade(socket, 403)
    const connection = acceptUpgrade(
      req,
      socket,
      head,
      protocols.includes(WIRE_PROTOCOL) ? WIRE_PROTOCOL : undefined,
    )
    attachEvents(connection, lease?.caller ?? callerOf(device), token, lease?.expiresAt)
  })

  function attachEvents(
    connection: ReturnType<typeof acceptUpgrade>,
    caller: RemoteCaller,
    token: string | undefined,
    expiresAt?: number,
  ): void {
    const subscriptions = new Map<string, () => void>()

    const teardown = (): void => {
      for (const unsubscribe of subscriptions.values()) unsubscribe()
      subscriptions.clear()
      connection.close(1000, 'unsubscribed')
    }
    const expiryTimer =
      expiresAt === undefined
        ? undefined
        : setTimeout(teardown, Math.max(0, expiresAt - (options.now?.() ?? Date.now())))
    expiryTimer?.unref()
    const credentialTimer = setInterval(() => {
      if (token === undefined || pairing.authenticate(token) === undefined) teardown()
    }, 1000)
    credentialTimer.unref()

    const send = (message: unknown): void => connection.send(JSON.stringify(message))

    async function subscribe(sessionId: string, fromSeq?: number): Promise<void> {
      if (subscriptions.size >= 8)
        return send(errorMessage('rate_limited', 'at most eight sessions may be streamed'))
      const buffered: JournalEvent[] = []
      let bytes = 0
      let ready = false
      let lastSeq = fromSeq ?? -1
      let unsubscribe = (): void => {}
      const current = (): boolean =>
        subscriptions.get(sessionId) === unsubscribe &&
        connection.open &&
        token !== undefined &&
        pairing.authenticate(token) !== undefined &&
        (expiresAt === undefined || expiresAt > (options.now?.() ?? Date.now()))
      const stop = (): void => {
        unsubscribe()
        subscriptions.delete(sessionId)
      }
      const deliver = (event: JournalEvent, caughtUp?: boolean): void => {
        if (!current()) return teardown()
        if (event.seq <= lastSeq) return
        lastSeq = event.seq
        send({
          type: 'events.frame',
          sessionId,
          events: [{ seq: event.seq, event }],
          ...(caughtUp === true ? { caughtUp: true } : {}),
        })
      }
      unsubscribe = host.subscribe(caller, sessionId, (event) => {
        if (!pairing.isDeviceActive(caller.deviceId) || !connection.open) return teardown()
        if (ready) return deliver(event)
        bytes += Buffer.byteLength(JSON.stringify(event))
        if (buffered.length >= 2000 || bytes > 4 * 1024 * 1024) {
          stop()
          return send({
            type: 'events.desync',
            sessionId,
            reason: 'replay buffer exceeded; refresh the session',
          })
        }
        buffered.push(event)
      })
      subscriptions.set(sessionId, unsubscribe)
      try {
        const snapshot = await host.getSession(caller, sessionId)
        if (!current()) return
        if (snapshot === undefined) {
          stop()
          return send(errorMessage('not_found', 'no such session'))
        }
        if (fromSeq !== undefined) {
          const events = await host.replay(caller, sessionId, fromSeq)
          if (!current()) return
          if (events === undefined || fromSeq > snapshot.seq || events.length > 2000) {
            stop()
            return send({
              type: 'events.desync',
              sessionId,
              reason: 'history is unavailable; refresh the session',
            })
          }
          events.forEach((event, index) => deliver(event, index === events.length - 1))
        }
        ready = true
        for (const event of buffered) deliver(event)
      } catch {
        stop()
        send(errorMessage('internal_error', 'the event subscription failed'))
      }
    }

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
      void subscribe(sessionId, message.data.fromSeq)
    })

    connection.onClose(() => {
      if (expiryTimer !== undefined) clearTimeout(expiryTimer)
      clearInterval(credentialTimer)
      for (const unsubscribe of subscriptions.values()) unsubscribe()
      subscriptions.clear()
    })
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const origin = requestOrigin(req.headers)

    // The PWA is served before the allowlist check, because a browser sends no
    // `Origin` on a navigation. These are the app's own public files — no
    // project name, path, or transcript is reachable through them — but an
    // `Origin` that is present is still checked, so a page on another origin
    // cannot fetch them. API routes are excluded and keep their own handling.
    if (webRoot !== null && req.method === 'GET' && !isApiPath(url.pathname)) {
      if (origin !== undefined && !originAllowed(origin)) {
        return send(res, 403, fail('origin_not_allowed', 'origin is not allowed'))
      }
      return serveWeb(webRoot, url.pathname, res)
    }

    if (!originAllowed(origin)) {
      return send(res, 403, fail('origin_not_allowed', 'origin is not allowed'))
    }
    // From here on the origin is one of the allowed strings, so echoing it
    // back is safe. Every response carries it, including refusals: a browser
    // blocks a response without it, and an error the client cannot read is an
    // error the user never sees.
    const reply: Reply = (status, body) => send(res, status, body, origin)

    if (req.method === 'OPTIONS') {
      // A preflight carries no body and names the method it intends to use.
      // Answered from the allowlist alone, because there is nothing else to
      // check it against and a preflight that reaches the body reader would
      // be rejected for having no body at all.
      return preflight(res, origin)
    }

    if (url.pathname === '/info') {
      // The same envelope every other route answers with, so a client has one
      // shape to parse rather than a special case for the first request it
      // ever makes.
      return reply(200, {
        ok: true,
        result: {
          protocolVersion: REMOTE_PROTOCOL_VERSION,
          capabilities: [...host.capabilities()],
        },
      })
    }

    const body = await readBody(req, reply)
    if (body === undefined) return

    switch (url.pathname) {
      case '/pair/request':
        return pairRequest(reply, body)
      case '/pair/status':
        return pairStatus(reply, body)
      case '/pair/redeem':
        return pairRedeem(reply, body)
      case '/pair/resolve':
        return pairResolve(reply, body)
      case '/device/challenge':
        return deviceChallenge(reply, body)
      case '/device/authorize':
        return deviceAuthorize(reply, body)
      case '/command':
        return command(req, reply, body)
      case '/query':
        return query(req, reply, body)
      default:
        return reply(404, fail('not_found', 'no such route'))
    }
  }

  function pairRequest(reply: Reply, body: unknown): void {
    const parsed = pairingRequestSchema.safeParse(body)
    if (!parsed.success) return reply(400, fail('unsupported_capability', 'malformed request'))
    const result = pairing.request(parsed.data.invitationId, {
      displayName: parsed.data.displayName,
      publicKey: parsed.data.publicKey,
    })
    if (!result.ok) return reply(statusFor(result.code), fail(result.code, 'pairing refused'))
    return reply(200, {
      ok: true,
      // The nonce travels with the confirmation code: the client displays one
      // and signs the other, and neither is something it chose.
      result: { confirmationCode: result.pending.confirmationCode, nonce: result.nonce },
    })
  }

  function deviceChallenge(reply: Reply, body: unknown): void {
    const parsed = deviceChallengeSchema.safeParse(body)
    if (!parsed.success) return reply(400, fail('unsupported_capability', 'malformed request'))
    return reply(200, { ok: true, result: pairing.challenge(parsed.data.deviceId) })
  }

  function deviceAuthorize(reply: Reply, body: unknown): void {
    const parsed = deviceAuthorizeSchema.safeParse(body)
    if (!parsed.success) return reply(400, fail('unsupported_capability', 'malformed request'))
    const result = pairing.authorize(parsed.data.deviceId, {
      nonce: parsed.data.nonce,
      signature: parsed.data.signature,
    })
    if (!result.ok) return reply(statusFor(result.code), fail(result.code, 'authorization refused'))
    return reply(200, {
      ok: true,
      result: {
        deviceId: result.device.deviceId,
        token: result.token,
        projectIds: result.device.projectIds,
        allowTerminal: result.device.allowTerminal === true,
      },
    })
  }

  function pairStatus(reply: Reply, body: unknown): void {
    const parsed = pairingStatusQuery.safeParse(body)
    if (!parsed.success) return reply(400, fail('unsupported_capability', 'malformed request'))
    const status = pairing.status(parsed.data.invitationId)
    if (status === undefined) return reply(404, fail('not_found', 'unknown invitation'))
    return reply(200, { ok: true, result: { status } })
  }

  function pairResolve(reply: Reply, body: unknown): void {
    const parsed = pairingResolveSchema.safeParse(body)
    if (!parsed.success) return reply(400, fail('unsupported_capability', 'malformed request'))
    const result = pairing.resolve(parsed.data.code)
    if (!result.ok) return reply(statusFor(result.code), fail(result.code, 'unknown code'))
    return reply(200, { ok: true, result: { invitationId: result.invitationId } })
  }

  function pairRedeem(reply: Reply, body: unknown): void {
    const parsed = pairingRedeemSchema.safeParse(body)
    if (!parsed.success) return reply(400, fail('unsupported_capability', 'malformed request'))
    const result = pairing.redeem(parsed.data.invitationId, {
      nonce: parsed.data.nonce,
      signature: parsed.data.signature,
    })
    if (!result.ok) return reply(statusFor(result.code), fail(result.code, 'redemption refused'))
    return reply(200, {
      ok: true,
      result: {
        deviceId: result.device.deviceId,
        token: result.token,
        allowTerminal: result.device.allowTerminal === true,
      },
    })
  }

  async function command(req: IncomingMessage, reply: Reply, body: unknown): Promise<void> {
    const parsed = remoteCommandEnvelopeSchema.safeParse(body)
    if (!parsed.success) {
      // Covers an operation with no schema, and a field the envelope does not
      // declare: both are "this gateway does not do that", and neither may
      // reach the host to be quietly ignored.
      return reply(400, fail('unsupported_capability', 'unsupported command'))
    }
    const command = parsed.data

    // No command operation is anonymous — a contracts test pins that — so an
    // envelope that parsed has no route without a device.
    const device = authenticate(req)
    if (device === undefined) {
      return reply(401, fail('unauthenticated', 'a device credential is required'))
    }
    const managed = authorizeManaged(headerLease(req), device)
    if (managed === null)
      return reply(
        403,
        fail('access_revoked', 'a current Ari Connect membership lease is required'),
      )
    const caller = managed?.caller ?? callerOf(device)
    if (!host.capabilities().includes(command.op)) {
      return reply(400, fail('unsupported_capability', 'this host cannot do that'))
    }

    const key = JSON.stringify([device.deviceId, command.idempotencyKey])
    if (idempotency.lookup(command.idempotencyKey) !== undefined) {
      return reply(
        409,
        fail(
          'conflict',
          'this command predates device-scoped receipts; inspect the session before sending again',
        ),
      )
    }
    const terminal = command.op.startsWith('terminal.')
    if (!terminal && terminalReceipts.lookup(key) !== undefined)
      return reply(409, fail('idempotency_conflict', 'that key was used for another command'))
    const receipts =
      terminal && idempotency.lookup(key) === undefined ? terminalReceipts : idempotency
    const durable = receipts === idempotency
    const outcome = receipts.begin(key, command)
    if (outcome.outcome === 'conflict') {
      return reply(409, fail('idempotency_conflict', 'that key was used for another command'))
    }
    if (outcome.outcome === 'in_flight') {
      return reply(409, fail('conflict', 'that command is still running'))
    }
    if (outcome.outcome === 'replay') {
      // A replayed failure carries no result — the store records that it
      // failed, not what it said. Reporting the refusal is the honest answer;
      // a bodyless 200 would read as success to a client that lost the first
      // response, which is the only client that asks.
      if (outcome.result === undefined) {
        return reply(409, fail('conflict', 'that command already failed; retry under a new key'))
      }
      if (!(await outcomeVisible(caller, outcome.result))) {
        return reply(404, fail('not_found', 'no such command'))
      }
      return reply(200, outcome.result.reply)
    }
    // Written before the command runs: a desktop that dies mid-command must
    // leave the key claimed, so the retry after the restart sees "still
    // running" instead of running the prompt a second time.
    if (durable) remember()

    const result = await host.execute(caller, command)
    if (result.ok) {
      receipts.complete(key, {
        reply: result,
        ...(command.op === 'session.create'
          ? { projectId: command.projectId }
          : { sessionId: command.sessionId }),
      })
      if (durable) remember()
      return reply(200, result)
    }
    // Recorded, so a retry sees the same refusal rather than re-running a
    // command that already failed for a reason that has not changed.
    receipts.fail(key)
    if (durable) remember()
    const code = asErrorCode(result.code)
    return reply(statusFor(code), { ok: false, error: { code, message: result.message } })
  }

  async function query(req: IncomingMessage, reply: Reply, body: unknown): Promise<void> {
    const parsed = remoteQuerySchema.safeParse(body)
    if (!parsed.success) {
      return reply(400, fail('unsupported_capability', 'unsupported query'))
    }
    const requested = parsed.data

    const device = authenticate(req)
    if (device === undefined && requiresAuthentication(requested.op)) {
      return reply(401, fail('unauthenticated', 'a device credential is required'))
    }

    // Answered here rather than by the host: the protocol version is the
    // gateway's own, and the capabilities are asked of the host directly. This
    // is the one operation that has to work before anyone holds a credential,
    // and it carries no user content — a version and a list of operation
    // names, so a client can tell what it is speaking to without learning
    // anything about the machine.
    if (requested.op === 'gateway.info') {
      return reply(200, {
        ok: true,
        result: {
          protocolVersion: REMOTE_PROTOCOL_VERSION,
          capabilities: [...host.capabilities()],
        },
      })
    }
    const managed = device === undefined ? undefined : authorizeManaged(headerLease(req), device)
    if (managed === null)
      return reply(
        403,
        fail('access_revoked', 'a current Ari Connect membership lease is required'),
      )
    const caller = device === undefined ? undefined : (managed?.caller ?? callerOf(device))

    if (requested.op === 'command.status') {
      if (device === undefined)
        return reply(401, fail('unauthenticated', 'a device credential is required'))
      const receiptKey = JSON.stringify([device.deviceId, requested.idempotencyKey])
      const record = idempotency.lookup(receiptKey) ?? terminalReceipts.lookup(receiptKey)
      if (record === undefined) return reply(404, fail('not_found', 'no such key'))
      // Only the outcome goes back, not the store's own bookkeeping — when the
      // record was written is the gateway's business.
      if (record.failed) {
        return reply(409, fail('conflict', 'that command already failed'))
      }
      if (record.result === undefined) {
        return reply(409, fail('conflict', 'that command is still running'))
      }
      if (caller === undefined || !(await outcomeVisible(caller, record.result))) {
        return reply(404, fail('not_found', 'no such command'))
      }
      return reply(200, { ok: true, result: record.result.reply })
    }
    // Everything past this point reaches the host, which is the user's data.
    // `gateway.info` and every anonymous operation are answered above, so a
    // device that is missing here is missing because the operation is guarded.
    if (device === undefined) {
      return reply(401, fail('unauthenticated', 'a device credential is required'))
    }
    if (!host.capabilities().includes(requested.op)) {
      return reply(400, fail('unsupported_capability', 'this host cannot do that'))
    }

    const { op, ...params } = requested
    const result = await host.query(caller ?? callerOf(device), op, params)
    return reply(200, { ok: true, result })
  }

  async function outcomeVisible(caller: RemoteCaller, outcome: RecordedOutcome): Promise<boolean> {
    if (outcome.sessionId !== undefined)
      return (await host.getSession(caller, outcome.sessionId)) !== undefined
    return outcome.projectId !== undefined && caller.projectIds.includes(outcome.projectId)
  }

  function authorizeManaged(
    token: string | undefined,
    device: PairedDevice,
  ): { caller: RemoteCaller; expiresAt: number } | null | undefined {
    if (options.managedAccess === undefined) return undefined
    const registered = pairing
      .toPersisted()
      .devices.find((entry) => entry.deviceId === device.deviceId)
    const lease =
      token === undefined || registered === undefined
        ? undefined
        : options.managedAccess.verifier()?.validate(token, registered)
    return lease === undefined
      ? null
      : {
          caller: {
            deviceId: device.deviceId,
            projectIds: lease.projectIds,
            allowTerminal: device.allowTerminal === true,
          },
          expiresAt: lease.expiresAt,
        }
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

  async function readBody(req: IncomingMessage, reply: Reply): Promise<unknown> {
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of req) {
      const buffer = chunk as Buffer
      size += buffer.length
      if (size > (req.url === '/command' ? MAX_IMAGE_BODY_BYTES : MAX_BODY_BYTES)) {
        reply(413, fail('unsupported_capability', 'request body is too large'))
        return undefined
      }
      chunks.push(buffer)
    }
    if (size === 0) {
      reply(400, fail('unsupported_capability', 'a JSON body is required'))
      return undefined
    }
    try {
      const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (
        size > MAX_BODY_BYTES &&
        (typeof parsed !== 'object' ||
          parsed === null ||
          !('op' in parsed) ||
          parsed.op !== 'attachments.stage')
      ) {
        reply(413, fail('unsupported_capability', 'request body is too large'))
        return undefined
      }
      return parsed
    } catch {
      reply(400, fail('unsupported_capability', 'malformed JSON'))
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
  selfOrigin = `http://127.0.0.1:${port}`

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

const deviceChallengeSchema = z.object({ deviceId: z.string().min(1).max(200) })

const deviceAuthorizeSchema = z.object({
  deviceId: z.string().min(1).max(200),
  nonce: z.string().min(1),
  signature: z.string().min(1),
})

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

function headerLease(req: IncomingMessage): string | undefined {
  const value = req.headers['x-ari-connect-lease']
  return typeof value === 'string' ? value : undefined
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
  return {
    deviceId: device.deviceId,
    projectIds: [...device.projectIds],
    allowTerminal: device.allowTerminal === true,
  }
}

function errorMessage(code: RemoteErrorCode, message: string): unknown {
  return { type: 'error', error: { code, message } }
}

const pairingRedeemSchema = z.object({
  invitationId: z.string().min(1),
  nonce: z.string().min(1),
  signature: z.string().min(1),
})

function fail(
  code: RemoteErrorCode,
  message: string,
): { ok: false; error: { code: string; message: string } } {
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
    case 'invalid_signature':
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

function send(res: ServerResponse, status: number, body: unknown, origin?: string): void {
  // `JSON.stringify` returns undefined for a body that is not serializable,
  // and sizing that throws inside a header write turns a response into a
  // dropped connection. `null` is a body the client can parse.
  const payload = JSON.stringify(body) ?? 'null'
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
    // No wildcard, and no credentials for a cross-origin caller: the origin
    // allowlist above is the only thing that decides, and it never echoes
    // anything that was not already on it.
    'cache-control': 'no-store',
    ...corsHeaders(origin),
  })
  res.end(payload)
}

/**
 * The CORS headers for an allowed origin, or none at all.
 *
 * The origin is echoed back exactly as the allowlist holds it rather than
 * reflected from the request: a reflected header is how an allowlist quietly
 * becomes a wildcard. `vary` keeps a cache from serving one origin's response
 * to another, and credentials stay off because nothing here uses cookies —
 * a token travels in a header the client sets deliberately.
 */
function corsHeaders(origin: string | undefined): Record<string, string> {
  if (origin === undefined) return {}
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-credentials': 'false',
    vary: 'origin',
  }
}

/** Answers a CORS preflight without touching the body or the host. */
function preflight(res: ServerResponse, origin: string | undefined): void {
  res.writeHead(204, {
    ...corsHeaders(origin),
    'access-control-allow-methods': 'POST, GET, OPTIONS',
    // Only what the PWA sends: a JSON body and a device token.
    'access-control-allow-headers': 'content-type, authorization, x-ari-connect-lease',
    'access-control-max-age': '600',
    'content-length': '0',
  })
  res.end()
}

/** Writes a response for one request, with that request's CORS headers. */
type Reply = (status: number, body: unknown) => void

/**
 * Routes the gateway answers itself. Everything else it did not declare, so a
 * GET without an extension is a client route rather than an unknown API call.
 */
const API_PATHS = new Set(['/info', '/command', '/query', '/events'])

function isApiPath(pathname: string): boolean {
  return API_PATHS.has(pathname) || pathname.startsWith('/pair/') || pathname.startsWith('/device/')
}

/**
 * The extensions a built PWA emits. Anything else is refused rather than
 * guessed at, so a stray file in `webRoot` — a key, a backup, a `.env` — does
 * not become reachable by landing there.
 */
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
}

/**
 * Serves the built app. A path with an extension is a file the build emitted;
 * everything else is one of the app's own routes, answered by the shell.
 */
async function serveWeb(root: string, pathname: string, res: ServerResponse): Promise<void> {
  const extension = extname(pathname).toLowerCase()
  if (extension.length === 0) return sendFile(res, join(root, 'index.html'), 'no-cache')
  const type = CONTENT_TYPES[extension]
  if (type === undefined) return notFound(res)
  const target = await withinRoot(root, pathname)
  if (target === null) return notFound(res)
  // Public shell assets may be retained for offline use but must revalidate;
  // the worker itself and all API replies remain outside the HTTP cache.
  const publicShell = [
    '/index.html',
    '/manifest.webmanifest',
    '/icon-192.png',
    '/icon-512.png',
    '/icon-maskable.png',
    '/icon.svg',
    '/icon-maskable.svg',
    '/apple-touch-icon.png',
  ].includes(pathname)
  const cacheControl = pathname.startsWith('/assets/')
    ? 'public, max-age=31536000, immutable'
    : publicShell
      ? 'no-cache'
      : 'no-store'
  return sendFile(res, target, cacheControl, type)
}

/**
 * Resolves a URL path inside `root`, refusing anything that leaves it —
 * `..`, an absolute path, or a symlink pointing elsewhere (ADR §19: fail
 * closed, and the comparison is on canonical paths).
 */
async function withinRoot(root: string, pathname: string): Promise<string | null> {
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return null
  }
  const target = resolve(root, `.${decoded}`)
  if (!inside(root, target)) return null
  try {
    const [real, realRoot] = await Promise.all([realpath(target), realpath(root)])
    return inside(realRoot, real) ? real : null
  } catch {
    return null
  }
}

function inside(root: string, target: string): boolean {
  return target === root || target.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)
}

async function sendFile(
  res: ServerResponse,
  path: string,
  cacheControl: string,
  type: string = 'text/html; charset=utf-8',
): Promise<void> {
  let size: number
  try {
    size = (await stat(path)).size
  } catch {
    return notFound(res)
  }
  res.writeHead(200, {
    'content-type': type,
    'content-length': size,
    'cache-control': cacheControl,
  })
  const stream = createReadStream(path)
  stream.on('error', () => res.destroy())
  res.on('close', () => stream.destroy())
  stream.pipe(res)
}

function notFound(res: ServerResponse): void {
  send(res, 404, fail('not_found', 'no such file'))
}
