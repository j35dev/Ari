import { execFile } from 'node:child_process'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { LookupFunction } from 'node:net'
import WebSocket from 'ws'
import { RemoteError, type GatewayClientOptions } from '@ari/remote-client'
import type { MachineRoute } from '@ari/contracts/machines'

const MAX_RESPONSE_BYTES = 16 * 1024 * 1024
const TIMEOUT_MS = 10_000
const ROUTE_CHECK_TIMEOUT_MS = 2500
const DNS_NAME = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]+\.ts\.net$/i

export function isTailnetAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const parts = address.split('.').map(Number)
    return parts[0] === 100 && (parts[1] ?? -1) >= 64 && (parts[1] ?? 128) < 128
  }
  return isIP(address) === 6 && /^fd7a:115c:a1e0:/i.test(address)
}
function isLoopback(address: string): boolean {
  return address === '127.0.0.1' || address === '::1'
}

/** A manual address is an origin or Ari's fragment pairing link, never a proxy URL. */
export function parseMachineAddress(
  address: string,
  allowLoopback = false,
): { route: MachineRoute; invitationId?: string } {
  let url: URL
  try {
    url = new URL(address.trim())
  } catch {
    throw new Error('Enter this computer’s Tailscale HTTPS address or pairing link.')
  }
  if (url.username || url.password || url.search || (url.pathname !== '/' && url.pathname !== ''))
    throw new Error(
      'Use a computer origin or pairing link without credentials, a query, or a path.',
    )
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  let kind: MachineRoute['kind']
  if (allowLoopback && url.protocol === 'http:' && (isLoopback(host) || host === 'localhost'))
    kind = 'loopback'
  else if (url.protocol === 'https:' && DNS_NAME.test(host)) kind = 'tailscale'
  else
    throw new Error(
      'Production computers require a Tailscale HTTPS hostname. Loopback HTTP is only enabled for tests.',
    )
  const fragment = new URLSearchParams(url.hash.slice(1))
  const invitationId = fragment.get('pair') ?? undefined
  if (
    url.hash &&
    (invitationId === undefined ||
      [...fragment.keys()].some((key) => key !== 'pair') ||
      !/^inv_[\w-]{1,196}$/.test(invitationId))
  )
    throw new Error('This pairing link is invalid.')
  return {
    route: { kind, origin: url.origin },
    ...(invitationId === undefined ? {} : { invitationId }),
  }
}

export interface MachineNetworkOptions {
  allowLoopback?: boolean
  resolve?: (hostname: string) => Promise<{ address: string; family: number }[]>
  timeoutMs?: number
}

/** Pin a verified destination into each TCP connection; redirects never reach another host. */
export class MachineNetwork {
  readonly #options: MachineNetworkOptions
  constructor(options: MachineNetworkOptions = {}) {
    this.#options = options
  }
  async clientOptions(route: MachineRoute): Promise<GatewayClientOptions> {
    const parsed = parseMachineAddress(route.origin, this.#options.allowLoopback)
    if (parsed.route.kind !== route.kind) throw new Error('The saved computer route is invalid.')
    const url = new URL(route.origin)
    const host = url.hostname.replace(/^\[|\]$/g, '')
    const resolve =
      this.#options.resolve ?? ((name: string) => lookup(name, { all: true, verbatim: true }))
    let dnsTimer: ReturnType<typeof setTimeout> | undefined
    const addresses = await Promise.race([
      resolve(host),
      new Promise<never>((_, reject) => {
        dnsTimer = setTimeout(
          () => reject(new RemoteError('unreachable', 'Computer name lookup timed out.')),
          Math.min(this.#options.timeoutMs ?? TIMEOUT_MS, ROUTE_CHECK_TIMEOUT_MS),
        )
        dnsTimer.unref()
      }),
    ]).finally(() => clearTimeout(dnsTimer))
    if (
      addresses.length === 0 ||
      addresses.some((row) =>
        route.kind === 'loopback' ? !isLoopback(row.address) : !isTailnetAddress(row.address),
      )
    )
      throw new Error('This computer address does not resolve exclusively inside Tailscale.')
    const pinned = addresses[0]!
    const pinnedLookup: LookupFunction = (_hostname, options, callback) => {
      if (options.all) callback(null, [{ address: pinned.address, family: pinned.family }])
      else callback(null, pinned.address, pinned.family)
    }
    const timeout = this.#options.timeoutMs ?? TIMEOUT_MS
    const fetchImpl: typeof fetch = async (input, init) => {
      const target = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      )
      if (target.origin !== route.origin || target.username || target.password)
        throw new Error('A computer request cannot change destinations.')
      const headers = Object.fromEntries(new Headers(init?.headers).entries())
      const deadlineMs = ['/info', '/api/identity', '/routes/proof'].includes(target.pathname)
        ? Math.min(timeout, ROUTE_CHECK_TIMEOUT_MS)
        : timeout
      // A desktop main-process request acts as this host's same-origin client.
      // This never relaxes the destination gateway's origin allowlist for browsers.
      headers['origin'] = route.origin
      return await new Promise<Response>((resolveResponse, reject) => {
        const request = (target.protocol === 'https:' ? httpsRequest : httpRequest)(
          target,
          {
            method: init?.method ?? 'GET',
            headers,
            lookup: pinnedLookup,
            agent: false,
            signal: init?.signal ?? undefined,
          },
          (response) => {
            const chunks: Buffer[] = []
            let size = 0
            response.on('data', (chunk: Buffer) => {
              size += chunk.length
              if (size > MAX_RESPONSE_BYTES) {
                response.destroy(new Error('The computer response is too large.'))
                return
              }
              chunks.push(chunk)
            })
            response.on('error', reject)
            response.on('end', () => {
              const status = response.statusCode ?? 500
              if (status >= 300 && status < 400) {
                reject(new Error('Computer redirects are not allowed.'))
                return
              }
              const responseHeaders = new Headers()
              for (const [name, value] of Object.entries(response.headers))
                if (value !== undefined)
                  responseHeaders.set(name, Array.isArray(value) ? value.join(', ') : value)
              resolveResponse(
                new Response([204, 205, 304].includes(status) ? null : Buffer.concat(chunks), {
                  status,
                  headers: responseHeaders,
                }),
              )
            })
          },
        )
        const deadline = setTimeout(
          () => request.destroy(new Error('The computer request timed out.')),
          deadlineMs,
        )
        request.once('close', () => clearTimeout(deadline))
        request.on('error', reject)
        if (typeof init?.body === 'string') request.write(init.body)
        request.end()
      })
    }
    return {
      origin: route.origin,
      fetch: fetchImpl,
      webSocket: (address, protocols) => {
        const target = new URL(address)
        const expected = route.origin.replace(/^http/, 'ws')
        if (target.origin !== expected || target.pathname !== '/events')
          throw new Error('Invalid computer event destination.')
        const socket = new WebSocket(address, protocols, {
          origin: route.origin,
          lookup: pinnedLookup,
          followRedirects: false,
          handshakeTimeout: timeout,
          maxPayload: 2 * 1024 * 1024,
          perMessageDeflate: false,
          rejectUnauthorized: true,
        })
        // ws's error event must be handled even when the caller only listens for close.
        socket.on('error', () => undefined)
        return socket as unknown as globalThis.WebSocket
      },
    }
  }
}

export interface TailnetRunner {
  (args: string[]): Promise<{ code: number; stdout: string }>
}
const defaultTailnetRunner: TailnetRunner = (args) =>
  new Promise((resolve) => {
    execFile(
      'tailscale',
      args,
      { encoding: 'utf8', windowsHide: true, timeout: 10_000, maxBuffer: 2 * 1024 * 1024 },
      (error, stdout) => {
        resolve({ code: error === null ? 0 : 1, stdout })
      },
    )
  })

/** Read-only discovery from the daemon's explicit peers, with no subnet/public scanning. */
export async function tailnetPeerRoutes(
  runner: TailnetRunner = defaultTailnetRunner,
): Promise<MachineRoute[]> {
  const result = await runner(['status', '--json'])
  if (result.code !== 0) return []
  let json: unknown
  try {
    json = JSON.parse(result.stdout)
  } catch {
    return []
  }
  if (typeof json !== 'object' || json === null) return []
  const top = json as Record<string, unknown>
  if (top['BackendState'] !== 'Running' || typeof top['Peer'] !== 'object' || top['Peer'] === null)
    return []
  const peers = Object.values(top['Peer'] as Record<string, unknown>).slice(0, 64)
  const origins = new Set<string>()
  for (const value of peers) {
    if (typeof value !== 'object' || value === null) continue
    const peer = value as Record<string, unknown>
    if (peer['Online'] !== true || typeof peer['DNSName'] !== 'string') continue
    const name = peer['DNSName'].replace(/\.$/, '').toLowerCase()
    if (!DNS_NAME.test(name)) continue
    // Cover Ari's default and non-443 Serve origin without enumerating ports.
    origins.add(`https://${name}`)
    origins.add(`https://${name}:8443`)
    if (origins.size >= 32) break
  }
  return [...origins].map((origin) => ({ kind: 'tailscale', origin }))
}
