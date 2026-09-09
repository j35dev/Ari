import { execFile } from 'node:child_process'
import { access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { promisify } from 'node:util'
import type { FocusMusicState, FocusTrack, RpcResults } from '@ari/contracts/rpc'
import { spawnCli } from '@ari/providers/spawn-cli'
import { createLogger } from '@ari/shared/logger'
import type { RpcRegistry } from './rpc-registry'

const log = createLogger('desktop:focus-music')

const STATUS_TIMEOUT_MS = 5_000
const CONTROL_TIMEOUT_MS = 8_000
/** Fast liveness probe for an already-running daemon. */
const INSTANCE_PROBE_TIMEOUT_MS = 3_000
/** Post-spawn readiness wait: 8 × 250ms before giving up on our own daemon. */
const DAEMON_READY_ATTEMPTS = 8
const DAEMON_READY_POLL_MS = 250
/** A failed spawn is not retried for 30s so polling cannot respawn-loop. */
const DAEMON_RESPAWN_COOLDOWN_MS = 30_000

const execFileP = promisify(execFile)

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
  const child = spawnCli(binary, args, { stdio: 'ignore', windowsHide: true })
  child.unref()
  return child
}

export interface FocusMusicBackendOptions {
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

/**
 * Locates the Cliamp executable: an explicit `CLIAMP_BIN` override first,
 * then every `PATH` entry (plus `~/.local/bin`). Native executables sort
 * before shell shims so one-shot invocations never need a shell.
 */
export async function locateCliampBinary(): Promise<string | null> {
  const override = process.env['CLIAMP_BIN']?.trim()
  if (override) return override
  const names =
    process.platform === 'win32' ? ['cliamp.exe', 'cliamp', 'cliamp.cmd', 'cliamp.bat'] : ['cliamp']
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

function defaultRunner(binary: () => Promise<string | null>): FocusMusicRunner {
  return {
    locateBinary: binary,
    run: async (args, timeoutMs) => {
      const bin = await binary()
      if (!bin) throw Object.assign(new Error('cliamp not found'), { code: 'ENOENT' })
      const { stdout } = await execFileP(bin, args, {
        timeout: timeoutMs,
        shell: false,
        windowsHide: true,
        encoding: 'utf8',
      })
      return { stdout }
    },
  }
}

function unavailable(detail: string): FocusMusicState {
  return {
    available: false,
    playing: false,
    track: null,
    volume: null,
    supportsSearch: false,
    supportsVolume: false,
    detail,
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

function asTrack(value: unknown): FocusTrack | null {
  const row = asRecord(value)
  if (!row) return null
  const titleRaw = row['title'] ?? row['name'] ?? row['track']
  if (typeof titleRaw !== 'string' || titleRaw.length === 0) return null
  const idRaw = row['id']
  const artistRaw = row['artist'] ?? row['author'] ?? ''
  return {
    id: typeof idRaw === 'string' && idRaw.length > 0 ? idRaw : titleRaw,
    title: titleRaw,
    artist: typeof artistRaw === 'string' ? artistRaw : '',
  }
}

/** Best-effort parse of `cliamp status --json`; null when unrecognized. */
export function parseCliampStatus(
  stdout: string,
): Pick<FocusMusicState, 'playing' | 'track' | 'volume'> | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout) as unknown
  } catch {
    return null
  }
  const root = asRecord(parsed)
  if (!root) return null
  const nested = asRecord(root['track'])
  const playingRaw = root['playing'] ?? root['isPlaying']
  const playing =
    typeof playingRaw === 'boolean'
      ? playingRaw
      : root['state'] === 'playing' || root['status'] === 'playing'
  const titleRaw = root['title'] ?? root['track'] ?? nested?.['title'] ?? nested?.['name']
  const artistRaw = root['artist'] ?? nested?.['artist']
  const artist = typeof artistRaw === 'string' ? artistRaw : ''
  const rootId = root['id']
  const nestedId = nested?.['id']
  const track =
    typeof titleRaw === 'string' && titleRaw.length > 0
      ? {
          id:
            typeof rootId === 'string' && rootId.length > 0
              ? rootId
              : typeof nestedId === 'string' && nestedId.length > 0
                ? nestedId
                : titleRaw,
          title: titleRaw,
          artist,
        }
      : nested
        ? asTrack(nested)
        : null
  if (typeof titleRaw === 'string' && titleRaw.length === 0) return null
  if (!track && playingRaw === undefined && root['state'] === undefined) return null
  const volumeRaw = root['volume']
  const volume =
    typeof volumeRaw === 'number' && Number.isFinite(volumeRaw)
      ? Math.min(100, Math.max(0, Math.round(volumeRaw)))
      : null
  return { playing, track, volume }
}

/** Best-effort parse of `cliamp search <q> --json` (array or {tracks|results}). */
export function parseCliampSearch(stdout: string): FocusTrack[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout) as unknown
  } catch {
    return null
  }
  const list = Array.isArray(parsed)
    ? parsed
    : (asRecord(parsed)?.['tracks'] ?? asRecord(parsed)?.['results'])
  if (!Array.isArray(list)) return null
  return list.flatMap((entry) => {
    const track = asTrack(entry)
    return track ? [track] : []
  })
}

/**
 * Cliamp backend behind the `focus.music.*` RPC surface.
 *
 * Daemon model: one-shot commands (`status --json`, `play`, `pause`, …)
 * talk to the daemon over Cliamp's own IPC socket, so Ari stays decoupled
 * from the raw protocol. On first use the backend probes for an already
 * running instance and only spawns `cliamp --daemon` when none answers;
 * `close()` terminates solely the daemon Ari spawned, never a user's own.
 * (Spectrum `visstream` exists but V1 deliberately uses a lightweight CSS
 * pulse keyed to playing state instead.)
 *
 * All control failures return `{ ok: false, error }` data — nothing throws
 * across IPC — so the renderer degrades to the timer alone.
 */
export class FocusMusicBackend {
  readonly #runner: FocusMusicRunner
  readonly #spawner: DaemonSpawner
  readonly #delay: (ms: number) => Promise<void>
  #binary: string | undefined
  #capabilities: { search: boolean; volume: boolean } | null = null
  /** Non-null only while Ari's own spawned daemon is the live instance. */
  #daemon: DaemonHandle | null = null
  #lastSpawnFailedAt: number | null = null

  constructor(options: FocusMusicBackendOptions = {}) {
    let cached: string | undefined
    this.#runner =
      options.runner ??
      defaultRunner(async () => {
        cached ??= (await locateCliampBinary()) ?? undefined
        return cached ?? null
      })
    this.#spawner = options.spawnDaemon ?? defaultDaemonSpawner
    this.#delay = options.delay ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  }

  /**
   * Resolves the binary, caching only positive hits so a mid-session
   * install is picked up on the next attempt instead of staying invisible
   * until restart.
   */
  async #binaryPath(): Promise<string | null> {
    this.#binary ??= (await this.#runner.locateBinary()) ?? undefined
    return this.#binary ?? null
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
   * daemon, adopts an already-running (user) instance without claiming it,
   * and spawns `cliamp --daemon` only when nothing answers.
   */
  async #ensureDaemon(): Promise<boolean> {
    if (this.#daemon && this.#daemon.exitCode === null) return true
    if (
      this.#lastSpawnFailedAt !== null &&
      Date.now() - this.#lastSpawnFailedAt < DAEMON_RESPAWN_COOLDOWN_MS
    ) {
      return false
    }
    if (await this.#instanceAlive()) {
      // Our handle is dead or absent: whatever answers now is not ours to
      // stop, so drop the handle rather than risk killing it on exit.
      this.#daemon = null
      return true
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

  /** Successful `--help` probes are cached; failures retry next time. */
  async #capabilitiesOf(): Promise<{ search: boolean; volume: boolean }> {
    if (!this.#capabilities) {
      try {
        const { stdout } = await this.#runner.run(['--help'], INSTANCE_PROBE_TIMEOUT_MS)
        this.#capabilities = {
          search: /search/i.test(stdout),
          volume: /vol/i.test(stdout),
        }
      } catch {
        return { search: false, volume: false }
      }
    }
    return this.#capabilities
  }

  async status(): Promise<FocusMusicState> {
    if ((await this.#binaryPath()) === null) {
      return unavailable('Cliamp is not installed — install it, then reopen this panel.')
    }
    if (!(await this.#ensureDaemon())) {
      return unavailable('Cliamp did not start — try running `cliamp --daemon` yourself.')
    }
    const caps = await this.#capabilitiesOf()
    try {
      const { stdout } = await this.#runner.run(['status', '--json'], STATUS_TIMEOUT_MS)
      const parsed = parseCliampStatus(stdout)
      if (!parsed) return unavailable('Cliamp answered, but its status was unreadable.')
      return {
        available: true,
        ...parsed,
        supportsSearch: caps.search,
        supportsVolume: caps.volume,
        detail: '',
      }
    } catch (error) {
      log.warn('cliamp status failed', { error: String(error) })
      return unavailable('Cliamp stopped answering — is it still running?')
    }
  }

  async control(args: string[]): Promise<RpcResults['focus.music.play']> {
    if ((await this.#binaryPath()) === null) {
      return { ok: false, error: 'Cliamp is not installed.' }
    }
    if (!(await this.#ensureDaemon())) {
      return { ok: false, error: 'Cliamp did not start.' }
    }
    try {
      await this.#runner.run(args, CONTROL_TIMEOUT_MS)
      return { ok: true }
    } catch (error) {
      log.warn('cliamp control failed', { args: args[0], error: String(error) })
      return { ok: false, error: 'Cliamp did not respond to that command.' }
    }
  }

  async search(query: string): Promise<RpcResults['focus.music.search']> {
    if ((await this.#binaryPath()) === null) {
      return { tracks: [], error: 'Cliamp is not installed.' }
    }
    if (!(await this.#ensureDaemon())) {
      return { tracks: [], error: 'Cliamp did not start.' }
    }
    if (!(await this.#capabilitiesOf()).search) {
      return { tracks: [], error: 'Search is not supported by this music backend.' }
    }
    try {
      const { stdout } = await this.#runner.run(['search', query, '--json'], STATUS_TIMEOUT_MS)
      return { tracks: parseCliampSearch(stdout) ?? [] }
    } catch (error) {
      log.warn('cliamp search failed', { error: String(error) })
      return { tracks: [], error: 'Search failed — the backend did not answer.' }
    }
  }

  async setVolume(volume: number): Promise<RpcResults['focus.music.volume']> {
    if ((await this.#binaryPath()) === null) {
      return { ok: false, error: 'Cliamp is not installed.' }
    }
    if (!(await this.#ensureDaemon())) {
      return { ok: false, error: 'Cliamp did not start.' }
    }
    if (!(await this.#capabilitiesOf()).volume) {
      return { ok: false, error: 'Volume is not supported by this music backend.' }
    }
    return this.control(['volume', String(volume)])
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

/** Registers the focus music surface; failures stay data so the ADE never depends on Cliamp. */
export function registerFocusMusic(registry: RpcRegistry): FocusMusicBackend {
  const backend = new FocusMusicBackend()
  registry.register('focus.music.status', () => backend.status())
  registry.register('focus.music.play', (params) =>
    backend.control(params.trackId !== undefined ? ['play', params.trackId] : ['play']),
  )
  registry.register('focus.music.pause', () => backend.control(['pause']))
  registry.register('focus.music.next', () => backend.control(['next']))
  registry.register('focus.music.previous', () => backend.control(['previous']))
  registry.register('focus.music.search', (params) => backend.search(params.query))
  registry.register('focus.music.volume', (params) => backend.setVolume(params.volume))
  return backend
}
