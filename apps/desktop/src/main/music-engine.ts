import { execFile } from 'node:child_process'
import { dirname } from 'node:path'
import { promisify } from 'node:util'
import type { FocusTrack, FocusUrlResolve, RpcResults } from '@ari/contracts/rpc'
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
        if (!binary) throw Object.assign(new Error('music helper unavailable'), { code: 'ENOENT' })
        const { stdout } = await execFileP(binary, args, {
          timeout: timeoutMs,
          shell: false,
          windowsHide: true,
          encoding: 'utf8',
          cwd: dirname(binary),
        })
        return { stdout }
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
    try {
      const { stdout } = await this.#runHelper(args, HELPER_TIMEOUT_MS)
      return JSON.parse(stdout) as unknown
    } catch (error) {
      log.warn('music helper call failed', { error: String(error) })
      return null
    }
  }

  /** Ensures the helper, naming the transient state for the UI. */
  async #ready(): Promise<{ binary: boolean; preparing: boolean }> {
    const binary = await this.#runtime.ensure()
    if (binary) return { binary: true, preparing: false }
    return { binary: false, preparing: (await this.#runtime.status()) === 'downloading' }
  }

  async resolveUrl(url: string): Promise<FocusUrlResolve> {
    const kind = classifyYoutubeUrl(url)
    if (!kind) return { kind: 'invalid', error: 'Paste a YouTube song or playlist link.' }
    const { binary, preparing } = await this.#ready()
    if (!binary) {
      return {
        kind: 'invalid',
        error: preparing ? 'Preparing Focus Music…' : 'Music is unavailable right now.',
      }
    }
    const dump = await this.#helperJson(
      kind === 'playlist'
        ? ['-J', '--flat-playlist', '--no-warnings', '--no-check-certificates', '--yes-playlist', url]
        : ['-J', '--no-playlist', '--no-warnings', '--no-check-certificates', url],
    )
    if (kind === 'playlist') {
      const playlist = youtubePlaylistFromDump(dump)
      if (!playlist) return { kind: 'invalid', error: "This playlist can't be played." }
      return { kind: 'playlist', name: playlist.name, tracks: playlist.tracks }
    }
    const track = youtubeTrackFromDump(dump)
    if (!track) return { kind: 'invalid', error: "This track can't be played." }
    return { kind: 'track', track }
  }

  /** Direct audio URL for a track (its id is the YouTube watch URL). */
  async streamTrack(trackId: string): Promise<RpcResults['focus.music.stream']> {
    let url: URL
    try {
      url = new URL(trackId)
    } catch {
      return { url: null, error: "This track can't be played." }
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return { url: null, error: "This track can't be played." }
    }
    const { binary, preparing } = await this.#ready()
    if (!binary) {
      return {
        url: null,
        error: preparing ? 'Preparing Focus Music…' : 'Music is unavailable right now.',
      }
    }
    try {
      const { stdout } = await this.#runHelper(
        ['-g', '-f', STREAM_FORMAT, '--no-warnings', '--no-check-certificates', trackId],
        HELPER_TIMEOUT_MS,
      )
      const direct = stdout.split('\n').map((line) => line.trim()).find((line) => line.length > 0)
      if (!direct || (!direct.startsWith('http://') && !direct.startsWith('https://'))) {
        return { url: null, error: "This track can't be played." }
      }
      return { url: direct }
    } catch (error) {
      log.warn('music stream resolve failed', { error: String(error) })
      return { url: null, error: "This track can't be played." }
    }
  }

  /** YouTube search without accounts, via the helper's directory lookup. */
  async search(query: string): Promise<RpcResults['focus.music.search']> {
    const { binary, preparing } = await this.#ready()
    if (!binary) {
      return {
        tracks: [],
        error: preparing ? 'Preparing Focus Music…' : 'Music is unavailable right now.',
      }
    }
    const dump = await this.#helperJson([
      '-J',
      '--flat-playlist',
      '--no-warnings',
      '--no-check-certificates',
      `ytsearch${SEARCH_LIMIT}:${query}`,
    ])
    const tracks = youtubePlaylistFromDump(dump)?.tracks ?? []
    return { tracks }
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
