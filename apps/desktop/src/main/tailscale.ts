import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { join } from 'node:path'
import type { z } from 'zod'
import type { rpcParams, TailscaleServeMapping, TailscaleState } from '@ari/contracts/rpc'

export type { TailscaleState }
export type TailscaleEnableOptions = z.infer<(typeof rpcParams)['remote.tailscale.enable']>
export interface TailscaleRunner {
  (args: string[]): Promise<{ code: number; stdout: string; stderr: string }>
}

const NOT_INSTALLED = 127
const DEFAULT_HTTPS_PORT = 443
const UNREADABLE = 'Ari could not understand the Serve configuration, so it left it alone.'
const defaultRunner: TailscaleRunner = (args) =>
  new Promise((resolve) => {
    execFile(
      'tailscale',
      args,
      { encoding: 'utf8', timeout: 15_000, windowsHide: true },
      (error, stdout, stderr) => {
        const code = (error as NodeJS.ErrnoException | null)?.code
        resolve({
          code:
            error === null
              ? 0
              : code === 'ENOENT'
                ? NOT_INSTALLED
                : typeof code === 'number'
                  ? code
                  : 1,
          stdout,
          stderr: stderr || error?.message || '',
        })
      },
    )
  })

/** TCP connectivity is diagnostic only. A dead target never confers ownership. */
export type TailscaleListeningProbe = (target: string) => Promise<boolean | null>
const defaultListening: TailscaleListeningProbe = async (target) => {
  const endpoint = loopbackEndpoint(target)
  if (endpoint === null) return null
  return new Promise((resolve) => {
    const socket = createConnection(endpoint)
    const finish = (listening: boolean | null): void => {
      socket.destroy()
      resolve(listening)
    }
    socket.setTimeout(500, () => finish(null))
    socket.once('connect', () => finish(true))
    socket.once('error', (error: NodeJS.ErrnoException) =>
      finish(error.code === 'ECONNREFUSED' ? false : null),
    )
  })
}

interface Ownership {
  version: 1
  httpsPort: number
  origin: string
  target: string
  enabled: boolean
}
interface ServeConfig {
  mappings: TailscaleServeMapping[]
  occupied: Set<number>
  incompatible: Set<number>
  funnel: Set<number>
}
interface Probe {
  state: TailscaleState
  config: ServeConfig | null
}

/**
 * Serve is shared with other applications. Ownership is a separate profile file,
 * never inferred from a matching gateway port. Every mutation rechecks its mount
 * immediately before invoking the CLI. No reset/Funnel/global removal is used.
 */
export class TailscaleServe {
  readonly #runner: TailscaleRunner
  readonly #port: () => number
  readonly #listening: TailscaleListeningProbe
  readonly #profilePath: string | null
  readonly #profileDir: string | null
  #ownership: Ownership | null = null
  #operations: Promise<unknown> = Promise.resolve()

  constructor(options: {
    runner?: TailscaleRunner
    port: () => number
    profileDir?: string
    listening?: TailscaleListeningProbe
  }) {
    this.#runner = options.runner ?? defaultRunner
    this.#port = options.port
    this.#listening = options.listening ?? defaultListening
    this.#profileDir = options.profileDir ?? null
    this.#profilePath =
      options.profileDir === undefined ? null : join(options.profileDir, 'tailscale-serve.json')
  }

  status(): Promise<TailscaleState> {
    return this.#queue(async () => (await this.#probe(this.#port())).state)
  }

  /** Restore only a previously enabled Ari mapping after the gateway binds. */
  resume(port: number): Promise<TailscaleState> {
    return this.#queue(async () => {
      await this.#readOwnership()
      return this.#ownership?.enabled
        ? this.#enable(port, undefined, true)
        : (await this.#probe(port)).state
    })
  }

  enable(port: number, options?: TailscaleEnableOptions): Promise<TailscaleState> {
    return this.#queue(() => this.#enable(port, options))
  }

  disable(): Promise<TailscaleState> {
    return this.#queue(async () => {
      const port = this.#port()
      const probe = await this.#probe(port)
      if (probe.config === null || probe.state.error !== null) return probe.state
      const ownership = this.#ownership
      if (ownership === null || !ownership.enabled) return probe.state
      const mount = rootMount(probe.config, ownership.httpsPort)
      if (mount !== undefined && !owns(ownership, mount))
        return {
          ...probe.state,
          error: 'The saved Ari mount changed; Ari left the current mapping alone.',
        }
      if (probe.config.incompatible.has(ownership.httpsPort))
        return {
          ...probe.state,
          error: 'The saved Ari port changed to another listener; Ari left it alone.',
        }
      await this.#prepareProfile()
      const checked = await this.#recheck(probe, ownership.httpsPort, ownership)
      if (checked !== null) return checked
      if (mount !== undefined) {
        // Explicit root path and original background flag remove just this handler.
        const result = await this.#runner([
          'serve',
          '--bg',
          `--https=${ownership.httpsPort}`,
          '--set-path=/',
          'off',
        ])
        if (result.code !== 0)
          return { ...(await this.#probe(port)).state, error: serveFailure(result) }
        const after = await this.#readMappings(probe.state.dnsName!)
        if ('error' in after) return { ...probe.state, error: after.error }
        if (
          rootMount(after, ownership.httpsPort) !== undefined ||
          !sameOtherMounts(probe.config, after, ownership.httpsPort)
        )
          return {
            ...probe.state,
            serving: false,
            error:
              'Tailscale did not confirm removal of only Ari’s root mount. Check Serve status.',
          }
      }
      await this.#saveOwnership({ ...ownership, enabled: false })
      return (await this.#probe(port)).state
    })
  }

  #queue(task: () => Promise<TailscaleState>): Promise<TailscaleState> {
    const done = this.#operations.then(task).catch((error: unknown) => ({
      ...emptyState(this.#ownership?.httpsPort ?? DEFAULT_HTTPS_PORT),
      error: `Ari could not check Tailscale: ${error instanceof Error ? error.message : String(error)}`,
    }))
    this.#operations = done
    return done
  }

  async #enable(
    port: number,
    options?: TailscaleEnableOptions,
    restoring = false,
  ): Promise<TailscaleState> {
    const probe = await this.#probe(port)
    if (probe.config === null || probe.state.error !== null) return probe.state
    if (!validPort(port))
      return { ...probe.state, error: 'Start the remote gateway before enabling Tailscale Serve.' }
    const ownership = this.#ownership
    const replace = options?.replace
    const replacementPort = replace === undefined ? null : originPort(replace.origin)
    let httpsPort =
      options?.httpsPort ?? replacementPort ?? ownership?.httpsPort ?? DEFAULT_HTTPS_PORT
    if (
      !validPort(httpsPort) ||
      (replace !== undefined &&
        (replacementPort === null ||
          httpsPort !== replacementPort ||
          replace.origin !== originFor(probe.state.dnsName!, httpsPort)))
    )
      return {
        ...probe.state,
        error: 'Choose a valid HTTPS port and confirm the exact current tailnet origin.',
      }
    let mount = rootMount(probe.config, httpsPort)
    if (replace !== undefined) {
      if (
        replace.mountPath !== '/' ||
        mount === undefined ||
        replace.origin !== mount.origin ||
        replace.target !== mount.target ||
        replace.kind !== mount.kind
      )
        return {
          ...probe.state,
          error: 'That Serve mapping changed. Refresh its status before confirming replacement.',
        }
    } else if (
      options?.httpsPort === undefined &&
      !owns(ownership, mount) &&
      probe.config.occupied.has(httpsPort) &&
      !(
        ownership?.httpsPort === httpsPort &&
        mount === undefined &&
        !probe.config.incompatible.has(httpsPort) &&
        !probe.config.funnel.has(httpsPort)
      )
    ) {
      // A restart must not silently change the URL saved on paired devices.
      if (restoring)
        return {
          ...probe.state,
          error:
            'Ari’s saved Serve address is now used by another mapping. Choose a new HTTPS port or confirm replacement.',
        }
      const free = suggestedPort(probe.config)
      if (free === null)
        return {
          ...probe.state,
          error:
            'No free HTTPS port was found. Choose a port or confirm replacement of the displayed root mount.',
        }
      httpsPort = free
      mount = undefined
    }
    if (probe.config.incompatible.has(httpsPort) || probe.config.funnel.has(httpsPort))
      return {
        ...probe.state,
        error:
          'That port is used by HTTP, TCP forwarding or Funnel. Choose a different HTTPS port.',
      }
    if (mount !== undefined && !owns(ownership, mount) && replace === undefined)
      return {
        ...probe.state,
        error: `Something else is served at ${mount.origin}: ${mount.target}. Choose a different HTTPS port or confirm this exact replacement.`,
      }
    // Changing addresses while owning a live mount would orphan it. Disable first.
    if (
      ownership?.enabled &&
      ownership.httpsPort !== httpsPort &&
      owns(ownership, rootMount(probe.config, ownership.httpsPort))
    )
      return {
        ...probe.state,
        error: 'Disable Ari’s current Serve mount before choosing a different HTTPS port.',
      }
    const target = `http://127.0.0.1:${port}`
    if (owns(ownership, mount) && mount?.target === target) return probe.state
    await this.#prepareProfile()
    const checked = await this.#recheck(probe, httpsPort, ownership)
    if (checked !== null) return checked
    const result = await this.#runner([
      'serve',
      '--bg',
      `--https=${httpsPort}`,
      '--set-path=/',
      ...(mount === undefined ? [] : ['--yes']),
      target,
    ])
    if (result.code !== 0)
      return { ...(await this.#probe(port)).state, error: serveFailure(result) }
    const after = await this.#readMappings(probe.state.dnsName!)
    if ('error' in after) return { ...probe.state, error: after.error }
    const added = rootMount(after, httpsPort)
    if (
      added?.target !== target ||
      added.kind !== 'proxy' ||
      after.incompatible.has(httpsPort) ||
      after.funnel.has(httpsPort) ||
      !sameOtherMounts(probe.config, after, httpsPort)
    )
      return {
        ...probe.state,
        serving: false,
        error:
          'Tailscale did not confirm Ari’s root mount while preserving the other mounts. Check Serve status.',
      }
    await this.#saveOwnership({
      version: 1,
      httpsPort,
      origin: added.origin,
      target,
      enabled: true,
    })
    return (await this.#probe(port)).state
  }

  /** The last subprocess before mutation is always a fresh configuration read. */
  async #recheck(
    probe: Probe,
    httpsPort: number,
    ownership: Ownership | null,
  ): Promise<TailscaleState | null> {
    await this.#readOwnership()
    const current = await this.#readMappings(probe.state.dnsName!)
    if ('error' in current) return { ...probe.state, error: current.error }
    if (
      JSON.stringify(ownership) !== JSON.stringify(this.#ownership) ||
      signature(current, httpsPort) !== signature(probe.config!, httpsPort)
    )
      return {
        ...(await this.#probe(this.#port())).state,
        error: 'The Serve configuration changed before Ari could update it. Refresh and try again.',
      }
    return null
  }

  async #probe(port: number): Promise<Probe> {
    await this.#readOwnership()
    const httpsPort = this.#ownership?.httpsPort ?? DEFAULT_HTTPS_PORT
    const status = await this.#readStatus()
    const base: TailscaleState = {
      ...emptyState(httpsPort),
      ...status,
      origin: status.dnsName === null ? null : originFor(status.dnsName, httpsPort),
    }
    if (status.error !== null) return { state: base, config: null }
    const config = await this.#readMappings(status.dnsName!)
    if ('error' in config) return { state: { ...base, error: config.error }, config: null }
    // Bound diagnostic work as well as concurrency; configuration parsing still
    // accounts for every mount, including ones beyond the probe budget.
    const targets = new Map<string, boolean | null>()
    const localTargets = [
      ...new Set(
        config.mappings
          .filter(
            (mapping) =>
              (mapping.kind === 'proxy' || mapping.kind === 'tcp') &&
              loopbackEndpoint(mapping.target) !== null,
          )
          .map((mapping) => mapping.target),
      ),
    ].slice(0, 16)
    for (let index = 0; index < localTargets.length; index += 2) {
      await Promise.all(
        localTargets.slice(index, index + 2).map(async (target) => {
          targets.set(target, await this.#listening(target).catch(() => null))
        }),
      )
    }
    for (const mapping of config.mappings) mapping.listening = targets.get(mapping.target) ?? null
    const mount = rootMount(config, httpsPort)
    const owned = owns(this.#ownership, mount)
    return {
      state: {
        ...base,
        target: mount?.target ?? null,
        targetListening: mount?.listening ?? null,
        owned,
        serving:
          owned &&
          mount?.target === `http://127.0.0.1:${port}` &&
          mount.listening !== false &&
          !config.funnel.has(httpsPort) &&
          !config.incompatible.has(httpsPort),
        conflicts: config.mappings.filter((mapping) => !owns(this.#ownership, mapping)),
        suggestedHttpsPort: suggestedPort(config),
      },
      config,
    }
  }

  async #readOwnership(): Promise<void> {
    if (this.#profilePath === null) return
    let raw: string
    try {
      raw = await readFile(this.#profilePath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.#ownership = null
        return
      }
      throw new Error('Ari could not read its saved Serve ownership; it left Serve alone.', {
        cause: error,
      })
    }
    const value = asRecord(parseJson(raw))
    if (
      value === null ||
      value['version'] !== 1 ||
      !validPort(value['httpsPort']) ||
      typeof value['origin'] !== 'string' ||
      originPort(value['origin']) !== value['httpsPort'] ||
      typeof value['target'] !== 'string' ||
      !/^http:\/\/127\.0\.0\.1:\d+$/.test(value['target']) ||
      loopbackEndpoint(value['target']) === null ||
      typeof value['enabled'] !== 'boolean'
    )
      throw new Error('Ari could not understand its saved Serve ownership; it left Serve alone.')
    this.#ownership = {
      version: 1,
      httpsPort: value['httpsPort'],
      origin: value['origin'],
      target: value['target'],
      enabled: value['enabled'],
    }
  }

  async #prepareProfile(): Promise<void> {
    if (this.#profileDir === null) return
    await mkdir(this.#profileDir, { recursive: true })
    const temporary = join(this.#profileDir, `tailscale-serve-${randomUUID()}.tmp`)
    await writeFile(temporary, '', { mode: 0o600, flag: 'wx' })
    await rm(temporary)
  }

  async #saveOwnership(ownership: Ownership): Promise<void> {
    if (this.#profilePath !== null) {
      await mkdir(this.#profileDir!, { recursive: true })
      const temporary = `${this.#profilePath}.${randomUUID()}.tmp`
      try {
        await writeFile(temporary, JSON.stringify(ownership), { mode: 0o600, flag: 'wx' })
        await rename(temporary, this.#profilePath)
      } finally {
        await rm(temporary, { force: true })
      }
    }
    this.#ownership = ownership
  }

  async #readStatus(): Promise<{
    installed: boolean
    dnsName: string | null
    error: string | null
  }> {
    const result = await this.#runner(['status', '--json'])
    if (result.code === NOT_INSTALLED)
      return {
        installed: false,
        dnsName: null,
        error: 'Tailscale is not installed on this computer.',
      }
    if (result.code !== 0)
      return {
        installed: true,
        dnsName: null,
        error:
          firstSentence(result.stderr) ??
          'Tailscale is installed but not running. Open Tailscale and sign in.',
      }
    const top = asRecord(parseJson(result.stdout))
    const self = asRecord(top?.['Self'])
    const dnsName =
      typeof self?.['DNSName'] === 'string'
        ? self['DNSName'].replace(/\.$/, '').toLowerCase()
        : null
    const backendState = top?.['BackendState'] ?? self?.['BackendState']
    if (backendState !== 'Running')
      return {
        installed: true,
        dnsName,
        error:
          backendState === undefined
            ? "Ari could not read Tailscale's status output."
            : 'Tailscale is installed but not running. Open Tailscale and sign in.',
      }
    if (dnsName === null || !/^[a-z0-9.-]+\.ts\.net$/.test(dnsName))
      return {
        installed: true,
        dnsName: null,
        error: 'Tailscale is running, but this machine has no tailnet name yet.',
      }
    return { installed: true, dnsName, error: null }
  }

  async #readMappings(dnsName: string): Promise<ServeConfig | { error: string }> {
    let result = await this.#runner(['serve', 'status', '--json'])
    if (result.code !== 0 && /unknown flag|unknown shorthand|unrecognized/i.test(result.stderr))
      result = await this.#runner(['serve', 'status'])
    if (result.code !== 0)
      return {
        error: `Ari could not read the Serve configuration, so it left it alone${firstSentence(result.stderr) === null ? '.' : `: ${firstSentence(result.stderr)}`}`,
      }
    const raw = result.stdout.trim()
    return (
      serveConfig(/^no serve config\.?$/i.test(raw) ? {} : parseJson(raw), dnsName) ?? {
        error: UNREADABLE,
      }
    )
  }
}

function emptyState(httpsPort: number): TailscaleState {
  return {
    installed: false,
    dnsName: null,
    origin: null,
    serving: false,
    error: null,
    httpsPort,
    target: null,
    targetListening: null,
    owned: false,
    conflicts: [],
    suggestedHttpsPort: null,
  }
}

/** Parse every handler and listener. An unknown shape is never an empty port. */
function serveConfig(parsed: unknown, dnsName: string): ServeConfig | null {
  const top = asRecord(parsed)
  if (
    top === null ||
    Object.keys(top).some(
      (key) => !['TCP', 'Web', 'AllowFunnel', 'Foreground', 'Services'].includes(key),
    )
  )
    return null
  for (const key of ['Foreground', 'Services']) {
    if (
      top[key] !== undefined &&
      top[key] !== null &&
      (asRecord(top[key]) === null || Object.keys(top[key]).length > 0)
    )
      return null
  }
  const config: ServeConfig = {
    mappings: [],
    occupied: new Set(),
    incompatible: new Set(),
    funnel: new Set(),
  }
  const tcp = optionalRecord(top['TCP'])
  const web = optionalRecord(top['Web'])
  const funnel = optionalRecord(top['AllowFunnel'])
  if (tcp === null || web === null || funnel === null) return null
  for (const [key, enabled] of Object.entries(funnel)) {
    const port = hostPort(key, dnsName)
    if (port === null || typeof enabled !== 'boolean') return null
    if (enabled) {
      config.funnel.add(port)
      config.occupied.add(port)
    }
  }
  for (const [key, value] of Object.entries(tcp)) {
    const port = /^\d+$/.test(key) ? Number(key) : null
    const handler = asRecord(value)
    if (
      !validPort(port) ||
      handler === null ||
      Object.keys(handler).some(
        (field) => !['HTTPS', 'HTTP', 'TCPForward', 'TerminateTLS'].includes(field),
      ) ||
      (handler['HTTPS'] !== undefined && typeof handler['HTTPS'] !== 'boolean') ||
      (handler['HTTP'] !== undefined && typeof handler['HTTP'] !== 'boolean')
    )
      return null
    config.occupied.add(port)
    if (
      handler['HTTPS'] === true &&
      handler['HTTP'] !== true &&
      handler['TCPForward'] === undefined &&
      handler['TerminateTLS'] === undefined
    )
      continue
    config.incompatible.add(port)
    if (
      handler['HTTP'] === true &&
      handler['TCPForward'] === undefined &&
      handler['TerminateTLS'] === undefined
    )
      continue
    if (
      typeof handler['TCPForward'] !== 'string' ||
      handler['TCPForward'].length === 0 ||
      (handler['TerminateTLS'] !== undefined && typeof handler['TerminateTLS'] !== 'string')
    )
      return null
    config.mappings.push({
      origin: originFor(dnsName, port),
      httpsPort: port,
      mountPath: null,
      target: handler['TCPForward'],
      kind: 'tcp',
      listening: null,
    })
  }
  for (const [key, value] of Object.entries(web)) {
    const port = hostPort(key, dnsName)
    const entry = asRecord(value)
    const handlers = asRecord(entry?.['Handlers'])
    const listener = port === null ? null : asRecord(tcp[String(port)])
    if (
      port === null ||
      handlers === null ||
      listener === null ||
      (listener['HTTPS'] !== true && listener['HTTP'] !== true) ||
      listener['TCPForward'] !== undefined ||
      listener['TerminateTLS'] !== undefined ||
      Object.keys(entry!).some((field) => field !== 'Handlers')
    )
      return null
    config.occupied.add(port)
    for (const [mountPath, value] of Object.entries(handlers)) {
      const handler = asRecord(value)
      if (!mountPath.startsWith('/') || handler === null || Object.keys(handler).length !== 1)
        return null
      const field = Object.keys(handler)[0]!
      const kind =
        field === 'Proxy' ? 'proxy' : field === 'Path' ? 'path' : field === 'Text' ? 'text' : null
      const target = handler[field]
      if (kind === null || typeof target !== 'string' || (kind !== 'text' && target.length === 0))
        return null
      config.mappings.push({
        origin: originFor(
          dnsName,
          port,
          asRecord(tcp[String(port)])?.['HTTP'] === true ? 'http' : 'https',
        ),
        httpsPort: port,
        mountPath,
        target,
        kind,
        listening: null,
      })
    }
  }
  return config.mappings.length <= 256 ? config : null
}

function owns(ownership: Ownership | null, mapping: TailscaleServeMapping | undefined): boolean {
  return (
    ownership?.enabled === true &&
    mapping !== undefined &&
    mapping.mountPath === '/' &&
    mapping.kind === 'proxy' &&
    mapping.origin === ownership.origin &&
    mapping.httpsPort === ownership.httpsPort &&
    mapping.target === ownership.target
  )
}
function rootMount(config: ServeConfig, port: number): TailscaleServeMapping | undefined {
  return config.mappings.find((mapping) => mapping.httpsPort === port && mapping.mountPath === '/')
}
function suggestedPort(config: ServeConfig): number | null {
  for (const port of [8443, 10000, ...Array.from({ length: 100 }, (_, index) => 10443 + index)])
    if (!config.occupied.has(port)) return port
  return null
}
function signature(config: ServeConfig, port: number): string {
  return JSON.stringify({
    occupied: config.occupied.has(port),
    incompatible: config.incompatible.has(port),
    funnel: config.funnel.has(port),
    mappings: mappingSignatures(config.mappings.filter((mapping) => mapping.httpsPort === port)),
  })
}
function mappingSignatures(mappings: TailscaleServeMapping[]): string[] {
  return mappings
    .map((mapping) =>
      JSON.stringify({
        origin: mapping.origin,
        httpsPort: mapping.httpsPort,
        mountPath: mapping.mountPath,
        target: mapping.target,
        kind: mapping.kind,
      }),
    )
    .sort()
}
function sameOtherMounts(before: ServeConfig, after: ServeConfig, port: number): boolean {
  const others = (config: ServeConfig) =>
    mappingSignatures(
      config.mappings.filter(
        (mapping) => !(mapping.httpsPort === port && mapping.mountPath === '/'),
      ),
    )
  return JSON.stringify(others(before)) === JSON.stringify(others(after))
}
function originFor(dnsName: string, port: number, protocol = 'https'): string {
  return new URL(`${protocol}://${dnsName}:${port}`).origin
}
function originPort(origin: string): number | null {
  try {
    const url = new URL(origin)
    return url.protocol === 'https:' &&
      url.origin === origin &&
      /^[a-z0-9.-]+\.ts\.net$/.test(url.hostname)
      ? Number(url.port || 443)
      : null
  } catch {
    return null
  }
}
function hostPort(key: string, dnsName: string): number | null {
  const match = /^(.*):(\d+)$/.exec(key)
  return match !== null && match[1]?.toLowerCase() === dnsName && validPort(Number(match[2]))
    ? Number(match[2])
    : null
}
function loopbackEndpoint(target: string): { host: string; port: number } | null {
  try {
    const url = new URL(
      target.includes('://') ? target.replace(/^https\+insecure:/, 'https:') : `tcp://${target}`,
    )
    if (
      !['http:', 'https:', 'tcp:'].includes(url.protocol) ||
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      url.username ||
      url.password
    )
      return null
    const port = Number(
      url.port || (url.protocol === 'https:' ? 443 : url.protocol === 'http:' ? 80 : 0),
    )
    return validPort(port) ? { host: url.hostname === '[::1]' ? '::1' : url.hostname, port } : null
  } catch {
    return null
  }
}
function validPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 65535
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
function optionalRecord(value: unknown): Record<string, unknown> | null {
  return value === undefined || value === null ? {} : asRecord(value)
}
function firstSentence(text: string): string | null {
  const line = text
    .split('\n')
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0)
  return line === undefined ? null : line.length > 200 ? `${line.slice(0, 197)}...` : line
}
function serveFailure(result: { stdout: string; stderr: string }): string {
  const detail = firstSentence(result.stderr) ?? firstSentence(result.stdout)
  if (detail !== null && /already|in use|conflict/i.test(detail))
    return 'Something is already served at that address; Ari did not change it.'
  const adminUrl = /https:\/\/\S+/.exec(result.stderr)?.[0]
  const action =
    adminUrl !== undefined && (detail === null || !detail.includes(adminUrl))
      ? ` See ${adminUrl}`
      : ''
  return detail === null
    ? `Tailscale refused to change the Serve configuration.${action}`
    : `Tailscale refused to change the Serve configuration: ${detail}${action}`
}
