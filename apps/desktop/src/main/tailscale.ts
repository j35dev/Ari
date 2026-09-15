import { execFile } from 'node:child_process'
import type { TailscaleState } from '@ari/contracts/rpc'

/**
 * Tailscale Serve (P3, ADR §18).
 *
 * The gateway listens on loopback; Tailscale Serve is what lets a phone on the
 * user's own tailnet reach it, as `https://<machine>.<tailnet>.ts.net`. Serve
 * is a shared resource — the user may already have mappings for other things —
 * so this module adds exactly one mapping (HTTPS 443 to Ari's loopback port),
 * refuses to touch anything else, and reports what it found rather than what
 * it hoped for. Funnel is never used: it would publish the desktop to the open
 * internet, which is not what "reach my own computer" means.
 *
 * Every public method answers with a {@linkcode TailscaleState}; a failure is a
 * sentence in `error`, never an exception, because the caller is a settings
 * panel that has to render whatever happened.
 */

export type { TailscaleState }

export interface TailscaleRunner {
  (args: string[]): Promise<{ code: number; stdout: string; stderr: string }>
}

/** The exit code the default runner uses for "no such binary". */
const NOT_INSTALLED = 127

/** The HTTPS port Ari serves on. 443 needs no port in a URL, which is why. */
const SERVE_PORT = 443

const defaultRunner: TailscaleRunner = (args) =>
  new Promise((resolve) => {
    execFile(
      'tailscale',
      args,
      { encoding: 'utf8', timeout: 15_000, windowsHide: true },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ code: 0, stdout, stderr })
          return
        }
        const code = (error as NodeJS.ErrnoException).code
        resolve({
          code: code === 'ENOENT' ? NOT_INSTALLED : typeof code === 'number' ? code : 1,
          stdout,
          stderr: stderr.length > 0 ? stderr : error.message,
        })
      },
    )
  })

interface ServeMapping {
  /** HTTPS port the mapping answers on. */
  port: number
  /** The local target it proxies to. */
  proxy: string
}

export class TailscaleServe {
  readonly #runner: TailscaleRunner
  readonly #port: () => number

  constructor(options: { runner?: TailscaleRunner; port: () => number }) {
    this.#runner = options.runner ?? defaultRunner
    this.#port = options.port
  }

  /** What a user sees: installed, on a tailnet, and whether Ari is served. */
  async status(): Promise<TailscaleState> {
    const probe = await this.#probe(this.#port())
    return probe.state
  }

  /**
   * Adds the mapping for `port`, and only that mapping. An unreadable Serve
   * configuration is not a licence to write one, so this fails closed rather
   * than guessing at what it might overwrite.
   */
  async enable(port: number): Promise<TailscaleState> {
    try {
      const probe = await this.#probe(port)
      if (probe.mappings === null || probe.state.error !== null) return probe.state
      if (isOurMapping(probe.mappings, port)) return probe.state
      if (probe.mappings.some((mapping) => mapping.port === SERVE_PORT)) {
        return {
          ...probe.state,
          serving: false,
          error: `Something else is already served at https://${probe.state.dnsName}; Ari left it alone.`,
        }
      }
      const result = await this.#runner([
        'serve',
        '--bg',
        `--https=${SERVE_PORT}`,
        `http://127.0.0.1:${port}`,
      ])
      if (result.code !== 0) {
        const state = (await this.#probe(port)).state
        return { ...state, error: serveFailure(result) }
      }
      return (await this.#probe(port)).state
    } catch (error) {
      return checkFailed(error)
    }
  }

  /** Removes Ari's mapping. A mapping pointing anywhere else is not ours. */
  async disable(): Promise<TailscaleState> {
    try {
      const port = this.#port()
      const probe = await this.#probe(port)
      if (probe.mappings === null || probe.state.error !== null) return probe.state
      if (!isOurMapping(probe.mappings, port)) return probe.state
      const result = await this.#runner(['serve', `--https=${SERVE_PORT}`, 'off'])
      if (result.code !== 0) {
        const state = (await this.#probe(port)).state
        return { ...state, error: serveFailure(result) }
      }
      return (await this.#probe(port)).state
    } catch (error) {
      return checkFailed(error)
    }
  }

  async #probe(port: number): Promise<{ state: TailscaleState; mappings: ServeMapping[] | null }> {
    const status = await this.#readStatus()
    const base: TailscaleState = {
      installed: status.installed,
      dnsName: status.dnsName,
      origin: status.dnsName === null ? null : `https://${status.dnsName}`,
      serving: false,
      error: status.error,
    }
    if (status.error !== null) return { state: base, mappings: null }
    const serve = await this.#readMappings()
    if ('error' in serve) return { state: { ...base, error: serve.error }, mappings: null }
    return {
      state: { ...base, serving: isOurMapping(serve.mappings, port) },
      mappings: serve.mappings,
    }
  }

  async #readStatus(): Promise<{
    installed: boolean
    dnsName: string | null
    error: string | null
  }> {
    const result = await this.#runner(['status', '--json'])
    if (result.code === NOT_INSTALLED) {
      return {
        installed: false,
        dnsName: null,
        error: 'Tailscale is not installed on this computer.',
      }
    }
    if (result.code !== 0) {
      return {
        installed: true,
        dnsName: null,
        error:
          firstSentence(result.stderr) ??
          'Tailscale is installed but not running. Open Tailscale and sign in.',
      }
    }
    const parsed = parseJson(result.stdout)
    const self = parsed === null ? null : asRecord(asRecord(parsed)?.['Self'])
    const dnsName = tailnetName(self?.['DNSName'])
    const backendState = self?.['BackendState']
    if (backendState !== 'Running') {
      return {
        installed: true,
        dnsName,
        error:
          backendState === undefined
            ? "Ari could not read Tailscale's status output."
            : 'Tailscale is installed but not running. Open Tailscale and sign in.',
      }
    }
    if (dnsName === null) {
      return {
        installed: true,
        dnsName: null,
        error: 'Tailscale is running, but this machine has no tailnet name yet.',
      }
    }
    return { installed: true, dnsName, error: null }
  }

  async #readMappings(): Promise<{ mappings: ServeMapping[] } | { error: string }> {
    let result = await this.#runner(['serve', 'status', '--json'])
    if (result.code !== 0 && /unknown flag|unknown shorthand|unrecognized/i.test(result.stderr)) {
      // An older CLI has no JSON output; the plain form is what it offers, and
      // its empty answer is the one that can be read without guessing.
      result = await this.#runner(['serve', 'status'])
    }
    if (result.code !== 0) {
      return { error: unreadableConfiguration(result.stderr) }
    }
    const raw = result.stdout.trim()
    if (raw.length === 0 || /no serve config/i.test(raw)) return { mappings: [] }
    const mappings = serveMappings(parseJson(raw))
    if (mappings === null) {
      return { error: 'Ari could not understand the Serve configuration, so it left it alone.' }
    }
    return { mappings }
  }
}

/**
 * Reads the `Web` section of `tailscale serve status --json`. Returns null for
 * a shape it does not recognize, so the caller refuses to write rather than
 * risk overwriting a mapping it failed to parse.
 */
function serveMappings(parsed: unknown): ServeMapping[] | null {
  const record = asRecord(parsed)
  if (record === null) return null
  const web = record['Web']
  // A valid status with nothing served omits the section or leaves it empty.
  if (web === undefined || web === null) return []
  const entries = asRecord(web)
  if (entries === null) return null
  const mappings: ServeMapping[] = []
  for (const [hostPort, entry] of Object.entries(entries)) {
    const port = httpsPort(hostPort)
    if (port === null) return null
    const handlers = asRecord(asRecord(entry)?.['Handlers'])
    if (handlers === null) return null
    for (const handler of Object.values(handlers)) {
      const proxy = asRecord(handler)?.['Proxy']
      if (typeof proxy === 'string') mappings.push({ port, proxy })
    }
  }
  return mappings
}

/** True when `port` is served on 443 through a loopback target. */
function isOurMapping(mappings: readonly ServeMapping[], port: number): boolean {
  return mappings.some(
    (mapping) => mapping.port === SERVE_PORT && proxyPort(mapping.proxy) === port,
  )
}

function proxyPort(proxy: string): number | null {
  try {
    const url = new URL(proxy)
    if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') return null
    if (url.port.length > 0) return Number(url.port)
    return url.protocol === 'https:' ? 443 : 80
  } catch {
    return null
  }
}

/** The port of a `serve status` key, which is `<host>:<port>` or a bare port. */
function httpsPort(key: string): number | null {
  const match = /(\d+)$/.exec(key)
  if (match === null) return null
  const port = Number(match[1])
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function tailnetName(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const name = value.replace(/\.$/, '')
  return name.length > 0 ? name : null
}

/** The first non-empty line, capped, so a verbose CLI still yields one sentence. */
function firstSentence(text: string): string | null {
  const line = text
    .split('\n')
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0)
  if (line === undefined) return null
  return line.length > 200 ? `${line.slice(0, 197)}...` : line
}

function serveFailure(result: { stdout: string; stderr: string }): string {
  const detail = firstSentence(result.stderr) ?? firstSentence(result.stdout)
  if (detail !== null && /already|in use|conflict/i.test(detail)) {
    return 'Something is already served at that address; Ari did not change it.'
  }
  return detail === null
    ? 'Tailscale refused to change the Serve configuration.'
    : `Tailscale refused to change the Serve configuration: ${detail}`
}

function unreadableConfiguration(stderr: string): string {
  const detail = firstSentence(stderr)
  return detail === null
    ? 'Ari could not read the Serve configuration, so it left it alone.'
    : `Ari could not read the Serve configuration, so it left it alone: ${detail}`
}

/** The shape returned when the runner itself failed, which is a bug, not a state. */
function checkFailed(error: unknown): TailscaleState {
  const detail = error instanceof Error ? error.message : String(error)
  return {
    installed: false,
    dnsName: null,
    origin: null,
    serving: false,
    error: `Ari could not check Tailscale: ${detail}`,
  }
}
