import { execFile } from 'node:child_process'
import { access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { promisify } from 'node:util'
import type { FocusMusicState, FocusTrack, RpcResults } from '@ari/contracts/rpc'
import { createLogger } from '@ari/shared/logger'
import type { RpcRegistry } from './rpc-registry'

const log = createLogger('desktop:focus-music')

const STATUS_TIMEOUT_MS = 5_000
const CONTROL_TIMEOUT_MS = 8_000

const execFileP = promisify(execFile)

/** Seams for tests; the default drives the real `cliamp` executable. */
export interface FocusMusicRunner {
  locateBinary(): Promise<string | null>
  run(args: string[], timeoutMs: number): Promise<{ stdout: string }>
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
 * then every `PATH` entry. Cliamp publishes no stable headless/socket API
 * in this environment, so the adapter below drives it through
 * timeout-bounded one-shot invocations and never embeds its TUI — there is
 * no long-lived child to leak, and every failure degrades to data.
 */
export async function locateCliampBinary(): Promise<string | null> {
  const override = process.env['CLIAMP_BIN']?.trim()
  if (override) return override
  const names =
    process.platform === 'win32' ? ['cliamp.exe', 'cliamp.cmd', 'cliamp.bat', 'cliamp'] : ['cliamp']
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
 * Cliamp backend behind the `focus.music.*` RPC surface. All control
 * failures return `{ ok: false, error }` data — nothing throws across IPC —
 * so the renderer can degrade to the timer alone.
 */
export class FocusMusicBackend {
  readonly #runner: FocusMusicRunner
  #binary: string | null | undefined
  #capabilities: { search: boolean; volume: boolean } | null = null

  constructor(runner?: FocusMusicRunner) {
    let cached: string | null | undefined
    this.#runner =
      runner ??
      defaultRunner(async () => {
        cached ??= await locateCliampBinary()
        return cached
      })
  }

  async #binaryPath(): Promise<string | null> {
    this.#binary ??= await this.#runner.locateBinary()
    return this.#binary
  }

  async #capabilitiesOf(): Promise<{ search: boolean; volume: boolean }> {
    if (this.#capabilities) return this.#capabilities
    try {
      const { stdout } = await this.#runner.run(['--help'], STATUS_TIMEOUT_MS)
      this.#capabilities = {
        search: /search/i.test(stdout),
        volume: /vol/i.test(stdout),
      }
    } catch {
      this.#capabilities = { search: false, volume: false }
    }
    return this.#capabilities
  }

  async status(): Promise<FocusMusicState> {
    if ((await this.#binaryPath()) === null) {
      return unavailable('Cliamp is not installed — the timer still works.')
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
      return unavailable('Cliamp is unreachable — is its backend running?')
    }
  }

  async control(args: string[]): Promise<RpcResults['focus.music.play']> {
    if ((await this.#binaryPath()) === null) {
      return { ok: false, error: 'Cliamp is not installed.' }
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
    if (!(await this.#capabilitiesOf()).volume) {
      return { ok: false, error: 'Volume is not supported by this music backend.' }
    }
    return this.control(['volume', String(volume)])
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
