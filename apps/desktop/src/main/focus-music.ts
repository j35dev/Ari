import { execFile } from 'node:child_process'
import { access, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { promisify } from 'node:util'
import type { FocusMusicState, FocusTrack, RpcResults } from '@ari/contracts/rpc'
import { spawnCli } from '@ari/providers/spawn-cli'
import { createLogger } from '@ari/shared/logger'
import type { RpcRegistry } from './rpc-registry'

const log = createLogger('desktop:focus-music')

const STATUS_TIMEOUT_MS = 5_000
const CONTROL_TIMEOUT_MS = 8_000
/** Provider search is network-bound (directory lookups); allow headroom. */
const SEARCH_TIMEOUT_MS = 20_000
/** Fast liveness probe for an already-running daemon. */
const INSTANCE_PROBE_TIMEOUT_MS = 3_000
/** Post-spawn readiness wait: 8 × 250ms before giving up on our own daemon. */
const DAEMON_READY_ATTEMPTS = 8
const DAEMON_READY_POLL_MS = 250
/** A failed spawn is not retried for 30s so polling cannot respawn-loop. */
const DAEMON_RESPAWN_COOLDOWN_MS = 30_000
const SEARCH_LIMIT_PER_PROVIDER = 4
const SEARCH_RESULT_CAP = 8
const BROWSE_RESULT_CAP = 8

/** Cliamp volume range in dB (`volume <dB>` sets an absolute value). */
const VOLUME_DB_MIN = -30
const VOLUME_DB_SPAN = 36

const execFileP = promisify(execFile)

/** Where the bundled binary lives; all Cliamp path logic stays in this module. */
export interface CliampEnvironment {
  isPackaged: boolean
  resourcesPath: string
  appPath: string
}

/** Seams for tests; the default drives the real `cliamp` executable. */
export interface FocusMusicRunner {
  locateBinary(): Promise<string | null>
  run(args: string[], timeoutMs: number): Promise<{ stdout: string }>
}

/**
 * Minimal owned-process handle: lifecycle tracking only needs liveness and
 * kill. The real `ChildProcess` satisfies this; tests use fakes.
 */
export interface DaemonHandle {
  readonly exitCode: number | null
  kill(): boolean
}

export type DaemonSpawner = (binary: string, args: string[]) => DaemonHandle

function defaultDaemonSpawner(binary: string, args: string[]): DaemonHandle {
  // spawnCli keeps argv arrays structural on every OS (cmd.exe escaping on
  // Windows shims) — user input such as search text is never shell-parsed.
  // cwd is the binary's own directory so Windows codec DLLs beside the exe
  // resolve even when Ari's cwd is elsewhere (spaces in the install path
  // are fine: this is an argv spawn, not a shell string).
  const child = spawnCli(binary, args, {
    stdio: 'ignore',
    windowsHide: true,
    cwd: dirname(binary),
  })
  child.unref()
  return child
}

export interface FocusMusicBackendOptions {
  env: CliampEnvironment
  runner?: FocusMusicRunner
  spawnDaemon?: DaemonSpawner
  /** Injectable for tests; defaults to a setTimeout sleep. */
  delay?: (ms: number) => Promise<void>
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/** Manifest key for this runtime, or null where upstream publishes nothing. */
export function cliampTargetKey(
  platform: string = process.platform,
  arch: string = process.arch,
): string | null {
  const normalizedArch = arch === 'x64' ? 'x64' : arch === 'arm64' ? 'arm64' : null
  if (!normalizedArch) return null
  if (platform !== 'win32' && platform !== 'darwin' && platform !== 'linux') return null
  return `${platform}-${normalizedArch}`
}

function cliampBinaryName(targetKey: string): string {
  return targetKey.startsWith('win32') ? 'cliamp.exe' : 'cliamp'
}

/**
 * Directory holding the vendored binary: `<resources>/cliamp/bin/<target>`
 * in both packaged and development layouts (see resources/cliamp/README).
 */
export function cliampBundleDir(env: CliampEnvironment, targetKey: string): string {
  const root = env.isPackaged ? env.resourcesPath : join(env.appPath, 'resources')
  return join(root, 'cliamp', 'bin', targetKey)
}

interface CliampPin {
  version: string
}

/** Reads the pinned version; null when the manifest is absent (never fatal). */
async function readCliampPin(env: CliampEnvironment): Promise<CliampPin | null> {
  const root = env.isPackaged ? env.resourcesPath : join(env.appPath, 'resources')
  try {
    const raw = await readFile(join(root, 'cliamp', 'cliamp.json'), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as { version?: unknown }).version === 'string'
    ) {
      return { version: (parsed as { version: string }).version }
    }
    return null
  } catch {
    return null
  }
}

/**
 * Locates a developer-installed Cliamp on PATH. Development fallback only —
 * production resolves the bundle and never depends on user configuration.
 */
export async function locateCliampBinary(): Promise<string | null> {
  // Native executables only: one-shot `execFile` cannot run .cmd/.bat with
  // `shell: false`, and production never depends on a user PATH install.
  const names = process.platform === 'win32' ? ['cliamp.exe', 'cliamp'] : ['cliamp']
  const dirs = (process.env['PATH'] ?? '').split(delimiter).filter((d) => d.length > 0)
  dirs.push(join(homedir(), '.local', 'bin'))
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = join(dir, name)
      if (await exists(candidate)) return candidate
    }
  }
  return null
}

/** Neutral unavailable state: users are never asked to configure anything. */
function unavailable(): FocusMusicState {
  return {
    available: false,
    playing: false,
    track: null,
    volume: null,
    supportsSearch: false,
    supportsVolume: false,
    detail: 'Music is unavailable right now.',
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

/**
 * Best-effort parse of `cliamp status --json`
 * (`{ok, state, track?: {title, artist?, station?, stream_title?, path?}}`).
 * Null when unrecognized; the backend degrades instead of throwing.
 */
export function parseCliampStatus(
  stdout: string,
): Pick<FocusMusicState, 'playing' | 'track'> | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout) as unknown
  } catch {
    return null
  }
  const root = asRecord(parsed)
  if (!root || root['ok'] === false) return null
  if (typeof root['state'] !== 'string') return null
  const playing = root['state'] === 'playing'
  const raw = asRecord(root['track'])
  if (!raw) return { playing, track: null }
  const title = asString(raw['stream_title']) ?? asString(raw['title'])
  if (!title || title.length === 0) return { playing, track: null }
  const path = asString(raw['path'])
  return {
    playing,
    track: {
      // The path round-trips through play(); titles alone are not playable.
      id: path && path.length > 0 ? path : title,
      title,
      artist: asString(raw['artist']) ?? '',
      station: asString(raw['station']) ?? '',
    },
  }
}

/** Unwraps a V2 `remote call` envelope to its job result; null on any failure shape. */
export function parseRemoteResult(stdout: string): unknown {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout) as unknown
  } catch {
    return null
  }
  const root = asRecord(parsed)
  if (!root || root['ok'] !== true) return null
  const job = asRecord(root['job'])
  if (job) {
    if (job['state'] !== 'succeeded') return null
    return job['result'] ?? null
  }
  return root['result'] ?? null
}

export interface CliampProvider {
  key: string
  name: string
  searchable: boolean
}

function parseProviderList(result: unknown): CliampProvider[] {
  const providers = asRecord(result)?.['providers']
  if (!Array.isArray(providers)) return []
  return providers.flatMap((entry) => {
    const row = asRecord(entry)
    const key = row ? asString(row['key']) : null
    if (!key) return []
    return [
      {
        key,
        name: asString(row?.['name']) ?? key,
        searchable: row?.['searchable'] === true,
      },
    ]
  })
}

function asFocusTrack(value: unknown): { track: FocusTrack; raw: unknown } | null {
  const row = asRecord(value)
  if (!row) return null
  const title = asString(row['title'])
  if (!title || title.length === 0) return null
  const path = asString(row['path'])
  return {
    track: {
      id: path && path.length > 0 ? path : title,
      title,
      artist: asString(row['artist']) ?? '',
      station: asString(row['station']) ?? '',
    },
    raw: value,
  }
}

function parseProviderTracks(result: unknown): { track: FocusTrack; raw: unknown }[] {
  const tracks = asRecord(result)?.['tracks']
  if (!Array.isArray(tracks)) return []
  return tracks.flatMap((entry) => {
    const track = asFocusTrack(entry)
    return track ? [track] : []
  })
}

export function parseProviderPlaylists(result: unknown): { id: string; name: string }[] {
  const list = asRecord(result)?.['playlists'] ?? asRecord(result)?.['items']
  if (!Array.isArray(list)) return []
  return list.flatMap((entry) => {
    const row = asRecord(entry)
    const id = row ? (asString(row['id']) ?? asString(row['key'])) : null
    const name = row ? (asString(row['name']) ?? asString(row['title'])) : null
    if (!id || !name) return []
    return [{ id, name }]
  })
}

/** UI slider (0–100) to absolute dB for `volume <dB>`. */
export function sliderToDb(volume: number): number {
  return VOLUME_DB_MIN + (Math.min(100, Math.max(0, Math.round(volume))) / 100) * VOLUME_DB_SPAN
}

/** Absolute dB back to the UI slider. */
export function dbToSlider(db: number): number {
  return Math.min(100, Math.max(0, Math.round(((db - VOLUME_DB_MIN) / VOLUME_DB_SPAN) * 100)))
}

export function formatDb(db: number): string {
  return String(Number(db.toFixed(1)))
}

/**
 * Cliamp backend behind the `focus.music.*` RPC surface.
 *
 * Bundling model: Ari ships a pinned Cliamp release inside its own package
 * (see resources/cliamp). Production resolves that bundle only; development
 * falls back to a PATH install when the bundle is absent. Cliamp publishes
 * no usable version without its daemon, so one-shot commands (`status
 * --json`, `play`, `pause`, `next`, `prev`, `volume <dB>`, and
 * `remote call … --wait`) talk to the daemon over its own IPC socket and Ari
 * stays decoupled from the raw protocol. (Spectrum `visstream` exists but V1
 * deliberately uses a lightweight CSS pulse keyed to playing state.)
 *
 * Daemon model: at most one Cliamp instance runs per user (shared socket).
 * The backend reuses a live owned daemon, adopts an already-running (user)
 * instance without claiming it, and spawns `cliamp --daemon` only when
 * nothing answers. `close()` terminates solely the daemon Ari spawned.
 *
 * All control failures return `{ ok: false, error }` data with neutral
 * wording — nothing throws across IPC and the UI never mentions Cliamp.
 */
export class FocusMusicBackend {
  readonly #env: CliampEnvironment
  readonly #runner: FocusMusicRunner
  readonly #spawner: DaemonSpawner
  readonly #delay: (ms: number) => Promise<void>
  #binary: string | undefined
  #pin: CliampPin | null | undefined
  #providers: CliampProvider[] | null = null
  /** Search/browse hits by playable id so play() can replay the full provider object. */
  #searchCache = new Map<string, unknown>()
  #browseCache: FocusTrack[] | null = null
  /** Last volume Ari set (dB); the daemon exposes no volume getter. Starts at the documented default. */
  #volumeDb: number | null = null
  /** Non-null only while Ari's own spawned daemon is the live instance. */
  #daemon: DaemonHandle | null = null
  #lastSpawnFailedAt: number | null = null
  /** In-flight spawn so concurrent RPC calls cannot start a second daemon. */
  #starting: Promise<boolean> | null = null

  constructor(options: FocusMusicBackendOptions) {
    this.#env = options.env
    this.#runner = options.runner ?? {
      locateBinary: () => locateCliampBinary(),
      run: async (args, timeoutMs) => {
        const bin = await this.#binaryPath()
        if (!bin) throw Object.assign(new Error('cliamp not found'), { code: 'ENOENT' })
        const { stdout } = await execFileP(bin, args, {
          timeout: timeoutMs,
          shell: false,
          windowsHide: true,
          encoding: 'utf8',
          cwd: dirname(bin),
        })
        return { stdout }
      },
    }
    this.#spawner = options.spawnDaemon ?? defaultDaemonSpawner
    this.#delay =
      options.delay ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  }

  /**
   * Bundled binary first (verified against the pin), then — development
   * only — a PATH install. Positive hits are cached; misses re-resolve so a
   * mid-session fetch or install is picked up without a restart.
   */
  async #resolveBinary(): Promise<string | null> {
    const override = process.env['CLIAMP_BIN']?.trim()
    if (override && (await exists(override))) return override
    const key = cliampTargetKey()
    if (key) {
      const candidate = join(cliampBundleDir(this.#env, key), cliampBinaryName(key))
      if (await exists(candidate) && (await this.#verifyBundle(candidate))) return candidate
    }
    if (!this.#env.isPackaged) return this.#runner.locateBinary()
    return null
  }

  async #binaryPath(): Promise<string | null> {
    this.#binary ??= (await this.#resolveBinary()) ?? undefined
    return this.#binary ?? null
  }

  /**
   * Refuses a bundled binary whose `--version` disagrees with the pin, so a
   * stale or corrupt vendor directory degrades instead of misbehaving. The
   * check runs once per process; PATH fallbacks skip it by design.
   */
  async #verifyBundle(binary: string): Promise<boolean> {
    this.#pin ??= await readCliampPin(this.#env)
    if (!this.#pin) return true
    try {
      const { stdout } = await execFileP(binary, ['--version'], {
        timeout: INSTANCE_PROBE_TIMEOUT_MS,
        shell: false,
        windowsHide: true,
        encoding: 'utf8',
        cwd: dirname(binary),
      })
      if (stdout.includes(this.#pin.version)) return true
      log.warn('bundled cliamp version mismatch', { stdout: stdout.trim() })
      return false
    } catch (error) {
      log.warn('bundled cliamp failed to run', { error: String(error) })
      return false
    }
  }

  /** True when any Cliamp instance — ours or the user's — answers. */
  async #instanceAlive(): Promise<boolean> {
    try {
      await this.#runner.run(['status', '--json'], INSTANCE_PROBE_TIMEOUT_MS)
      return true
    } catch {
      return false
    }
  }

  /**
   * Ensures a daemon answers before any command runs. Reuses a live owned
   * daemon, adopts an already-running instance without claiming it, and
   * spawns `cliamp --daemon` only when nothing answers. Concurrent callers
   * share one in-flight attempt so Ari never starts two of its own.
   */
  async #ensureDaemon(): Promise<boolean> {
    if (this.#daemon && this.#daemon.exitCode === null) return true
    if (this.#starting) return this.#starting
    const attempt = this.#startDaemon()
    this.#starting = attempt
    try {
      return await attempt
    } finally {
      if (this.#starting === attempt) this.#starting = null
    }
  }

  async #startDaemon(): Promise<boolean> {
    if (this.#daemon && this.#daemon.exitCode === null) return true
    // Probe before applying the spawn cooldown so a daemon that appeared
    // independently (user-started, or a sibling Ari) is adopted immediately.
    if (await this.#instanceAlive()) {
      // Our handle is dead or absent: whatever answers now is not ours to
      // stop, so drop the handle rather than risk killing it on exit.
      this.#daemon = null
      return true
    }
    if (
      this.#lastSpawnFailedAt !== null &&
      Date.now() - this.#lastSpawnFailedAt < DAEMON_RESPAWN_COOLDOWN_MS
    ) {
      return false
    }
    const binary = await this.#binaryPath()
    if (!binary) return false
    let handle: DaemonHandle
    try {
      handle = this.#spawner(binary, ['--daemon'])
    } catch (error) {
      log.warn('cliamp daemon spawn failed', { error: String(error) })
      return false
    }
    this.#daemon = handle
    for (let attempt = 0; attempt < DAEMON_READY_ATTEMPTS; attempt++) {
      if (handle.exitCode !== null) break
      if (await this.#instanceAlive()) return true
      await this.#delay(DAEMON_READY_POLL_MS)
    }
    // Never became ready: do not leave an orphan we own behind.
    this.#daemon = null
    this.#lastSpawnFailedAt = Date.now()
    try {
      handle.kill()
    } catch (error) {
      log.warn('cliamp daemon cleanup failed', { error: String(error) })
    }
    log.warn('cliamp daemon failed to become ready')
    return false
  }

  /** Submits a V2 operation through the one-shot client; null on any failure. */
  async #remoteCall(operation: string, params: unknown, timeoutMs: number): Promise<unknown> {
    try {
      const { stdout } = await this.#runner.run(
        ['remote', 'call', operation, '--params', JSON.stringify(params), '--wait'],
        timeoutMs,
      )
      return parseRemoteResult(stdout)
    } catch (error) {
      log.warn('cliamp remote call failed', { operation, error: String(error) })
      return null
    }
  }

  /** Configured providers; cached once read (setup changes need a restart anyway). */
  async #providerList(): Promise<CliampProvider[]> {
    if (!this.#providers) {
      const result = await this.#remoteCall('provider.list', {}, STATUS_TIMEOUT_MS)
      const providers = result ? parseProviderList(result) : []
      if (providers.length > 0) this.#providers = providers
      return providers
    }
    return this.#providers
  }

  async status(): Promise<FocusMusicState> {
    if ((await this.#binaryPath()) === null) return unavailable()
    if (!(await this.#ensureDaemon())) {
      log.warn('cliamp daemon unavailable')
      return unavailable()
    }
    // The daemon exposes no volume getter; report the last value Ari set
    // (the documented default until the user moves the slider).
    this.#volumeDb ??= 0
    const providers = await this.#providerList()
    try {
      const { stdout } = await this.#runner.run(['status', '--json'], STATUS_TIMEOUT_MS)
      const parsed = parseCliampStatus(stdout)
      if (!parsed) {
        log.warn('cliamp status unreadable')
        return unavailable()
      }
      return {
        available: true,
        ...parsed,
        volume: dbToSlider(this.#volumeDb),
        supportsSearch: providers.some((provider) => provider.searchable),
        supportsVolume: true,
        detail: '',
      }
    } catch (error) {
      log.warn('cliamp status failed', { error: String(error) })
      return unavailable()
    }
  }

  async control(args: string[]): Promise<RpcResults['focus.music.play']> {
    if ((await this.#binaryPath()) === null) {
      return { ok: false, error: 'Music is unavailable right now.' }
    }
    if (!(await this.#ensureDaemon())) {
      return { ok: false, error: 'Music is unavailable right now.' }
    }
    try {
      await this.#runner.run(args, CONTROL_TIMEOUT_MS)
      return { ok: true }
    } catch (error) {
      log.warn('cliamp control failed', { args: args[0], error: String(error) })
      return { ok: false, error: 'Music did not respond. Please try again.' }
    }
  }

  /**
   * Searches every searchable configured provider (radio, podcasts, and the
   * local library need no accounts) and merges the hits. Anything failing —
   * including providers needing tools Ari does not bundle — is skipped, so
   * search degrades instead of erroring.
   */
  async search(query: string): Promise<RpcResults['focus.music.search']> {
    if ((await this.#binaryPath()) === null) {
      return { tracks: [], error: 'Music is unavailable right now.' }
    }
    if (!(await this.#ensureDaemon())) {
      return { tracks: [], error: 'Music is unavailable right now.' }
    }
    const searchable = (await this.#providerList()).filter((provider) => provider.searchable)
    if (searchable.length === 0) {
      return { tracks: [], error: 'Search is not available right now.' }
    }
    const settled = await Promise.all(
      searchable.map(async (provider) => {
        const result = await this.#remoteCall(
          'provider.search',
          { provider: provider.key, query, limit: SEARCH_LIMIT_PER_PROVIDER },
          SEARCH_TIMEOUT_MS,
        )
        return result ? parseProviderTracks(result) : []
      }),
    )
    const hits = settled.flat().slice(0, SEARCH_RESULT_CAP)
    for (const hit of hits) this.#searchCache.set(hit.track.id, hit.raw)
    return { tracks: hits.map((hit) => hit.track) }
  }

  /**
   * Built-in radio channels (the credential-free station list). Cached after
   * the first successful read so opening the popover does not refetch.
   */
  async browse(): Promise<RpcResults['focus.music.browse']> {
    if ((await this.#binaryPath()) === null) {
      return { tracks: [], error: 'Music is unavailable right now.' }
    }
    if (!(await this.#ensureDaemon())) {
      return { tracks: [], error: 'Music is unavailable right now.' }
    }
    if (this.#browseCache) return { tracks: this.#browseCache }
    const playlists = parseProviderPlaylists(
      await this.#remoteCall('provider.playlists', { provider: 'radio' }, STATUS_TIMEOUT_MS),
    )
    const builtin =
      playlists.find((entry) => /cliamp radio/i.test(entry.name)) ??
      playlists.find((entry) => entry.id.startsWith('l:'))
    if (!builtin) return { tracks: [] }
    const hits = parseProviderTracks(
      await this.#remoteCall(
        'provider.tracks',
        { provider: 'radio', id: builtin.id },
        SEARCH_TIMEOUT_MS,
      ),
    ).slice(0, BROWSE_RESULT_CAP)
    for (const hit of hits) this.#searchCache.set(hit.track.id, hit.raw)
    const tracks = hits.map((hit) => hit.track)
    if (tracks.length > 0) this.#browseCache = tracks
    return { tracks }
  }

  /**
   * Queues next/prev without waiting for the new stream to connect. Live
   * radio has to reconnect either way; blocking the RPC on that is what
   * made skip hitch the UI for a second.
   */
  async skip(operation: 'next' | 'prev'): Promise<RpcResults['focus.music.next']> {
    if ((await this.#binaryPath()) === null) {
      return { ok: false, error: 'Music is unavailable right now.' }
    }
    if (!(await this.#ensureDaemon())) {
      return { ok: false, error: 'Music is unavailable right now.' }
    }
    try {
      await this.#runner.run(['remote', 'call', operation], INSTANCE_PROBE_TIMEOUT_MS)
      return { ok: true }
    } catch (error) {
      log.warn('cliamp skip failed', { operation, error: String(error) })
      return { ok: false, error: 'Music did not respond. Please try again.' }
    }
  }

  /** Plays a search hit with its full provider object; unknown ids resume instead. */
  async playTrack(trackId?: string): Promise<RpcResults['focus.music.play']> {
    if (trackId === undefined) return this.control(['play'])
    if ((await this.#binaryPath()) === null) {
      return { ok: false, error: 'Music is unavailable right now.' }
    }
    if (!(await this.#ensureDaemon())) {
      return { ok: false, error: 'Music is unavailable right now.' }
    }
    const cached = this.#searchCache.get(trackId)
    const track = cached ?? { title: trackId, path: trackId }
    const result = await this.#remoteCall('track.play', { track }, CONTROL_TIMEOUT_MS)
    if (!result) return { ok: false, error: 'Music did not respond. Please try again.' }
    return { ok: true }
  }

  async setVolume(volume: number): Promise<RpcResults['focus.music.volume']> {
    if ((await this.#binaryPath()) === null) {
      return { ok: false, error: 'Music is unavailable right now.' }
    }
    if (!(await this.#ensureDaemon())) {
      return { ok: false, error: 'Music is unavailable right now.' }
    }
    const db = sliderToDb(volume)
    const result = await this.control(['volume', formatDb(db)])
    if (result.ok) this.#volumeDb = db
    return result
  }

  /**
   * Stops the daemon Ari spawned, if it is still alive. A user's own
   * instance (adopted, never owned) is never touched. Wired to
   * `before-quit` in `./rpc`.
   */
  close(): void {
    const owned = this.#daemon
    this.#daemon = null
    if (owned && owned.exitCode === null) {
      try {
        owned.kill()
        log.info('stopped owned cliamp daemon')
      } catch (error) {
        log.warn('cliamp daemon stop failed', { error: String(error) })
      }
    }
  }
}

/** One backend per process so window recreation cannot spawn a second daemon. */
let sharedBackend: FocusMusicBackend | null = null

/** Registers the focus music surface; failures stay data so the ADE never depends on music. */
export function registerFocusMusic(
  registry: RpcRegistry,
  env: CliampEnvironment,
): FocusMusicBackend {
  sharedBackend ??= new FocusMusicBackend({ env })
  const backend = sharedBackend
  registry.register('focus.music.status', () => backend.status())
  registry.register('focus.music.play', (params) => backend.playTrack(params.trackId))
  registry.register('focus.music.pause', () => backend.control(['pause']))
  registry.register('focus.music.next', () => backend.skip('next'))
  registry.register('focus.music.previous', () => backend.skip('prev'))
  registry.register('focus.music.search', (params) => backend.search(params.query))
  registry.register('focus.music.browse', () => backend.browse())
  registry.register('focus.music.volume', (params) => backend.setVolume(params.volume))
  return backend
}
