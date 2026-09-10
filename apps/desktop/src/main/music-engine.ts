import { execFile } from 'node:child_process'
import { dirname } from 'node:path'
import { promisify } from 'node:util'
import type {
  FocusTrack,
  FocusUrlResolve,
  MusicErrorCode,
  RpcResults,
} from '@ari/contracts/rpc'
import { musicErrorMessage } from '@ari/contracts/rpc'
import { createLogger } from '@ari/shared/logger'
import { classifyYoutubeUrl, youtubePlaylistFromDump, youtubeTrackFromDump } from './focus-youtube'
import { createFocusPlaylistStore, type FocusPlaylistStore } from './focus-playlists'
import { MusicRuntime, type MusicRuntimeEnvironment } from './music-runtime'
import type { RpcRegistry } from './rpc-registry'

const log = createLogger('desktop:music-engine')

const HELPER_TIMEOUT_MS = 45_000
const SEARCH_LIMIT = 8
/** Preferred audio-only format; plain bestaudio reconverges when m4a is absent. */
const STREAM_FORMAT = 'bestaudio[ext=m4a]/bestaudio/best'

const execFileP = promisify(execFile)

const ERROR_CODES: readonly string[] = [
  'TRACK_UNAVAILABLE',
  'NETWORK_ERROR',
  'STREAM_EXPIRED',
  'RUNTIME_MISSING',
  'RUNTIME_UPDATE_REQUIRED',
  'RUNTIME_DOWNLOAD_FAILED',
  'RUNTIME_INTEGRITY_FAILED',
  'RESOLVE_TIMEOUT',
  'PLAYBACK_ERROR',
]

/** Reads back a code attached by the helper runner; unknown throws are playback errors. */
export function errorCodeOf(error: unknown): MusicErrorCode {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' && ERROR_CODES.includes(code)
    ? (code as MusicErrorCode)
    : 'PLAYBACK_ERROR'
}

function codedError(code: MusicErrorCode, detail?: string): Error & { code: MusicErrorCode } {
  return Object.assign(new Error(detail ?? musicErrorMessage(code)), { code })
}

/**
 * Maps helper stderr to a category. Unavailable patterns win over extractor
 * patterns so "video unavailable" never triggers a runtime update; only
 * extractor/format breakage (the YouTube-changed case) does.
 */
export function classifyHelperError(output: string, timedOut: boolean): MusicErrorCode {
  if (timedOut) return 'RESOLVE_TIMEOUT'
  if (
    /private video|video unavailable|this video is unavailable|no longer available|has been removed|has been deleted|login required|sign in to|age[-\s]?restricted|not available in your country|blocked it on copyright|account (terminated|suspended)|requires payment/i.test(
      output,
    )
  ) {
    return 'TRACK_UNAVAILABLE'
  }
  if (
    /unable to download|network is unreachable|connection (reset|refused|aborted)|econn|enotfound|getaddrinfo|socket hang up|temporary failure|tls|certificate|proxy error/i.test(
      output,
    )
  ) {
    return 'NETWORK_ERROR'
  }
  if (
    /unable to extract|nsig|signature|decrypt|extractor|failed to parse|js interpreter|unsupported url|no video formats|requested format|fragment/i.test(
      output,
    )
  ) {
    return 'RUNTIME_UPDATE_REQUIRED'
  }
  return 'PLAYBACK_ERROR'
}

/** Loggable video identity: the public id, never query strings or stream URLs. */
export function videoIdFromUrl(raw: string): string {
  try {
    const url = new URL(raw.trim())
    const v = url.searchParams.get('v')
    if (v) return v.slice(0, 32)
    if (url.hostname.toLowerCase() === 'youtu.be') {
      const last = url.pathname.split('/').filter(Boolean).at(-1)
      if (last) return last.slice(0, 32)
    }
    return `${url.hostname}${url.pathname}`.slice(0, 80)
  } catch {
    return raw.trim().slice(0, 80)
  }
}

export interface MusicEngineOptions {
  env: MusicRuntimeEnvironment
  /** Injectable helper runner; defaults to the verified per-user binary. */
  runHelper?: (args: string[], timeoutMs: number) => Promise<{ stdout: string }>
  playlists?: FocusPlaylistStore | null
  runtime?: MusicRuntime
}

/**
 * Small music backend behind the `focus.music.*` RPC surface.
 *
 * Playback itself runs in the renderer (HTMLAudio over direct stream URLs),
 * so no media stack ships in the installer: the only native piece is a tiny
 * per-user resolver helper, downloaded once on first use and verified by
 * SHA-256 (see ./music-runtime). Playlists store lightweight source records
 * (URL + metadata), never audio. All failures arrive as data — never throws
 * across IPC, never names internal tooling in user-facing strings.
 */
export class MusicEngine {
  readonly #runtime: MusicRuntime
  readonly #runHelper: (args: string[], timeoutMs: number) => Promise<{ stdout: string }>
  readonly #playlists: FocusPlaylistStore | null

  constructor(options: MusicEngineOptions) {
    this.#runtime = options.runtime ?? new MusicRuntime(options.env)
    const runtime = this.#runtime
    this.#runHelper =
      options.runHelper ??
      (async (args, timeoutMs) => {
        const binary = await runtime.ensure()
        if (!binary) throw codedError('RUNTIME_MISSING')
        try {
          const { stdout } = await execFileP(binary, args, {
            timeout: timeoutMs,
            shell: false,
            windowsHide: true,
            encoding: 'utf8',
            cwd: dirname(binary),
          })
          return { stdout }
        } catch (error) {
          // Never propagate stdout: stream calls print signed URLs there.
          const root = error as { message?: unknown; stderr?: unknown; killed?: boolean }
          const stderr = typeof root.stderr === 'string' ? root.stderr.slice(-2000) : ''
          const message = typeof root.message === 'string' ? root.message : String(error)
          throw codedError(classifyHelperError(`${message}\n${stderr}`, root.killed === true))
        }
      })
    this.#playlists =
      options.playlists ?? (options.env.userDataPath
        ? createFocusPlaylistStore(options.env.userDataPath)
        : null)
  }

  /** ready | downloading | missing | unavailable — drives "Preparing…" UI. */
  async runtimeStatus(): Promise<RpcResults['focus.music.runtime']> {
    const state = await this.#runtime.status()
    return {
      state,
      detail:
        state === 'ready'
          ? ''
          : state === 'downloading'
            ? 'Preparing Focus Music…'
            : state === 'missing'
              ? 'Focus Music prepares on first use.'
              : 'Music is unavailable on this device.',
    }
  }

  async #helperJson(args: string[]): Promise<unknown> {
    const { stdout } = await this.#runHelper(args, HELPER_TIMEOUT_MS)
    try {
      return JSON.parse(stdout) as unknown
    } catch {
      throw codedError('PLAYBACK_ERROR')
    }
  }

  /** Ensures the helper, naming the transient state for the UI. */
  async #ready(): Promise<{ binary: boolean; preparing: boolean }> {
    const binary = await this.#runtime.ensure()
    if (binary) return { binary: true, preparing: false }
    return { binary: false, preparing: (await this.#runtime.status()) === 'downloading' }
  }

  /**
   * Runs a helper operation, refreshing a suspect runtime once and retrying
   * a single time. Only extractor/format breakage (the YouTube-changed case)
   * qualifies — per-video and network failures propagate immediately, and a
   * retry runs only against a newly verified binary, never the same one.
   */
  async #healRuntimeOnce<T>(videoId: string, operation: string, op: () => Promise<T>): Promise<T> {
    try {
      return await op()
    } catch (error) {
      if (errorCodeOf(error) !== 'RUNTIME_UPDATE_REQUIRED') throw error
      log.warn('music runtime suspect; forcing manifest refresh', { videoId, operation })
      const updated = await this.#runtime.refreshRuntime().catch(() => false)
      const runtimeVersion = await this.#runtime.installedVersion().catch(() => null)
      if (!updated) {
        log.warn('music runtime unchanged; failing operation', {
          videoId,
          operation,
          runtimeVersion,
        })
        throw error
      }
      log.info('music runtime updated; retrying operation', {
        videoId,
        operation,
        runtimeVersion,
      })
      return op()
    }
  }

  async resolveUrl(url: string): Promise<FocusUrlResolve> {
    const kind = classifyYoutubeUrl(url)
    if (!kind) return { kind: 'invalid', error: 'Paste a YouTube song or playlist link.' }
    const { binary, preparing } = await this.#ready()
    if (!binary) {
      return {
        kind: 'invalid',
        error: preparing ? 'Preparing Focus Music…' : musicErrorMessage('RUNTIME_MISSING'),
        code: 'RUNTIME_MISSING',
      }
    }
    const started = Date.now()
    const videoId = videoIdFromUrl(url)
    const runtimeVersion = await this.#runtime.installedVersion().catch(() => null)
    try {
      const dump = await this.#healRuntimeOnce(videoId, 'resolve', () =>
        this.#helperJson(
          kind === 'playlist'
            ? ['-J', '--flat-playlist', '--no-warnings', '--no-check-certificates', '--yes-playlist', url]
            : ['-J', '--no-playlist', '--no-warnings', '--no-check-certificates', url],
        ),
      )
      if (kind === 'playlist') {
        const playlist = youtubePlaylistFromDump(dump)
        if (!playlist) {
          return { kind: 'invalid', error: musicErrorMessage('TRACK_UNAVAILABLE'), code: 'TRACK_UNAVAILABLE' }
        }
        log.info('music resolve ok', {
          videoId,
          kind,
          tracks: playlist.tracks.length,
          runtimeVersion,
          durationMs: Date.now() - started,
        })
        return { kind: 'playlist', name: playlist.name, tracks: playlist.tracks }
      }
      const track = youtubeTrackFromDump(dump)
      if (!track) {
        return { kind: 'invalid', error: musicErrorMessage('TRACK_UNAVAILABLE'), code: 'TRACK_UNAVAILABLE' }
      }
      log.info('music resolve ok', { videoId, kind, runtimeVersion, durationMs: Date.now() - started })
      return { kind: 'track', track }
    } catch (error) {
      const code = errorCodeOf(error)
      log.warn('music resolve failed', {
        videoId,
        code,
        runtimeVersion,
        durationMs: Date.now() - started,
      })
      return { kind: 'invalid', error: musicErrorMessage(code), code }
    }
  }

  /** Direct audio URL for a track (its id is the YouTube watch URL). */
  async streamTrack(trackId: string): Promise<RpcResults['focus.music.stream']> {
    let url: URL
    try {
      url = new URL(trackId)
    } catch {
      return { url: null, error: musicErrorMessage('PLAYBACK_ERROR'), code: 'PLAYBACK_ERROR' }
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return { url: null, error: musicErrorMessage('PLAYBACK_ERROR'), code: 'PLAYBACK_ERROR' }
    }
    const { binary, preparing } = await this.#ready()
    if (!binary) {
      return {
        url: null,
        error: preparing ? 'Preparing Focus Music…' : musicErrorMessage('RUNTIME_MISSING'),
        code: 'RUNTIME_MISSING',
      }
    }
    const videoId = videoIdFromUrl(trackId)
    try {
      const { stdout } = await this.#healRuntimeOnce(videoId, 'stream', () =>
        this.#runHelper(
          ['-g', '-f', STREAM_FORMAT, '--no-warnings', '--no-check-certificates', trackId],
          HELPER_TIMEOUT_MS,
        ),
      )
      const direct = stdout.split('\n').map((line) => line.trim()).find((line) => line.length > 0)
      if (!direct || (!direct.startsWith('http://') && !direct.startsWith('https://'))) {
        return { url: null, error: musicErrorMessage('TRACK_UNAVAILABLE'), code: 'TRACK_UNAVAILABLE' }
      }
      return { url: direct }
    } catch (error) {
      const code = errorCodeOf(error)
      log.warn('music stream resolve failed', { videoId, code })
      return { url: null, error: musicErrorMessage(code), code }
    }
  }

  /** YouTube search without accounts, via the helper's directory lookup. */
  async search(query: string): Promise<RpcResults['focus.music.search']> {
    const { binary, preparing } = await this.#ready()
    if (!binary) {
      return {
        tracks: [],
        error: preparing ? 'Preparing Focus Music…' : musicErrorMessage('RUNTIME_MISSING'),
        code: 'RUNTIME_MISSING',
      }
    }
    try {
      const dump = await this.#healRuntimeOnce('search', 'search', () =>
        this.#helperJson([
          '-J',
          '--flat-playlist',
          '--no-warnings',
          '--no-check-certificates',
          `ytsearch${SEARCH_LIMIT}:${query}`,
        ]),
      )
      const tracks = youtubePlaylistFromDump(dump)?.tracks ?? []
      return { tracks }
    } catch (error) {
      const code = errorCodeOf(error)
      log.warn('music search failed', { code, queryLength: query.length })
      return { tracks: [], error: musicErrorMessage(code), code }
    }
  }

  /** No radio backend ships with Ari; the UI renders saved content instead. */
  browse(): Promise<RpcResults['focus.music.browse']> {
    return Promise.resolve({ tracks: [] })
  }

  async listPlaylists(): Promise<RpcResults['focus.playlists.list']> {
    if (!this.#playlists) return { playlists: [] }
    return { playlists: await this.#playlists.list() }
  }

  async createPlaylist(
    name: string,
    tracks: FocusTrack[] = [],
  ): Promise<RpcResults['focus.playlists.create']> {
    if (!this.#playlists) return { playlist: null, error: 'Playlists are unavailable right now.' }
    return { playlist: await this.#playlists.create(name, tracks) }
  }

  async getPlaylist(id: string): Promise<RpcResults['focus.playlists.get']> {
    if (!this.#playlists) return { playlist: null }
    const playlist = (await this.#playlists.list()).find((row) => row.id === id) ?? null
    return { playlist }
  }

  async renamePlaylist(id: string, name: string): Promise<RpcResults['focus.playlists.rename']> {
    if (!this.#playlists) return { playlist: null, error: 'Playlists are unavailable right now.' }
    const playlist = await this.#playlists.rename(id, name)
    return playlist ? { playlist } : { playlist: null, error: 'Playlist not found.' }
  }

  async removePlaylist(id: string): Promise<RpcResults['focus.playlists.remove']> {
    if (!this.#playlists) return { ok: false, error: 'Playlists are unavailable right now.' }
    return { ok: await this.#playlists.remove(id) }
  }

  async updatePlaylist(
    id: string,
    tracks: FocusTrack[],
  ): Promise<RpcResults['focus.playlists.update']> {
    if (!this.#playlists) return { playlist: null, error: 'Playlists are unavailable right now.' }
    const playlist = await this.#playlists.replaceTracks(id, tracks)
    return playlist ? { playlist } : { playlist: null, error: 'Playlist not found.' }
  }
}

/** One engine per process; playback state itself lives in the renderer. */
let sharedEngine: MusicEngine | null = null

/** Registers the focus music surface; failures stay data so the ADE never depends on music. */
export function registerMusicEngine(
  registry: RpcRegistry,
  env: MusicRuntimeEnvironment,
): MusicEngine {
  sharedEngine ??= new MusicEngine({ env })
  const engine = sharedEngine
  registry.register('focus.music.runtime', () => engine.runtimeStatus())
  registry.register('focus.music.resolve', (params) => engine.resolveUrl(params.url))
  registry.register('focus.music.stream', (params) => engine.streamTrack(params.trackId))
  registry.register('focus.music.search', (params) => engine.search(params.query))
  registry.register('focus.music.browse', () => engine.browse())
  registry.register('focus.playlists.list', () => engine.listPlaylists())
  registry.register('focus.playlists.get', (params) => engine.getPlaylist(params.id))
  registry.register('focus.playlists.create', (params) =>
    engine.createPlaylist(params.name, params.tracks ?? []),
  )
  registry.register('focus.playlists.rename', (params) =>
    engine.renamePlaylist(params.id, params.name),
  )
  registry.register('focus.playlists.remove', (params) => engine.removePlaylist(params.id))
  registry.register('focus.playlists.update', (params) =>
    engine.updatePlaylist(params.id, params.tracks),
  )
  return engine
}
