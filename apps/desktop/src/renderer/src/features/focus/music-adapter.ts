import type { AriPlaylist, FocusMusicState, FocusTrack, FocusUrlResolve } from '@ari/contracts/rpc'
import { createLogger } from '@ari/shared/logger'
import { rpc } from '../../lib/rpc'
import { AriMusicEngine, type EngineAudioElement } from './ari-music-engine'
import { DISCONNECTED_MUSIC, type MusicService } from './music-types'

const log = createLogger('ui:focus-music')

/** RPC `focus.playlists.create` rejects names over 48 chars (YouTube titles often are). */
const PLAYLIST_NAME_MAX = 48

export function clipPlaylistName(name: string): string {
  const trimmed = name.trim().slice(0, PLAYLIST_NAME_MAX)
  return trimmed.length > 0 ? trimmed : 'Playlist'
}

function synthesizeTrack(id: string): FocusTrack {
  return { id, title: id, artist: '', station: '', sourceUrl: id }
}

/**
 * Ari music backend behind {@link MusicService}. Playback runs locally in the
 * engine (HTMLAudio over direct stream URLs); the main process only resolves
 * metadata, stream URLs, and saved playlists over RPC. Any IPC failure
 * degrades to a disconnected snapshot — never a throw — so the pill and the
 * rest of the ADE keep working when music is not ready.
 */
export class AriMusicAdapter implements MusicService {
  readonly #engine: AriMusicEngine
  /** Metadata by track id so queue/play can replay full records. */
  readonly #tracks = new Map<string, FocusTrack>()
  readonly #streams = new Map<string, string>()

  constructor(engine?: AriMusicEngine, createAudio?: () => EngineAudioElement) {
    this.#engine =
      engine ??
      new AriMusicEngine({ createAudio, resolveStream: (track) => this.streamUrl(track) })
  }

  async #runtime(): Promise<{ available: boolean; detail: string }> {
    try {
      const status = await rpc.invoke('focus.music.runtime')
      return {
        available: status.state === 'ready',
        detail: status.detail,
      }
    } catch (error) {
      log.warn('music runtime failed', error)
      return { available: false, detail: '' }
    }
  }

  async streamUrl(track: FocusTrack): Promise<string> {
    const cached = this.#streams.get(track.id)
    if (cached) return cached
    const result = await rpc.invoke('focus.music.stream', { trackId: track.sourceUrl || track.id })
    if (!result.url) throw new Error(result.error ?? "This track can't be played.")
    this.#streams.set(track.id, result.url)
    return result.url
  }

  #remember(tracks: FocusTrack[]): void {
    for (const track of tracks) this.#tracks.set(track.id, track)
  }

  #trackFor(id: string): FocusTrack {
    return this.#tracks.get(id) ?? synthesizeTrack(id)
  }

  subscribe(listener: (state: FocusMusicState) => void): () => void {
    return this.#engine.subscribe(() => {
      void this.getState().then(listener)
    })
  }

  async getState(): Promise<FocusMusicState> {
    try {
      const snapshot = this.#engine.getSnapshot()
      const runtime = await this.#runtime()
      if (!runtime.available) {
        return {
          ...DISCONNECTED_MUSIC,
          detail: runtime.detail || snapshot.detail,
        }
      }
      return {
        available: true,
        playing: snapshot.playing,
        track: snapshot.track,
        volume: snapshot.volume,
        positionMs: snapshot.positionMs,
        durationMs: snapshot.durationMs,
        supportsSearch: true,
        supportsVolume: true,
        shuffle: snapshot.shuffle,
        detail: snapshot.detail,
      }
    } catch (error) {
      log.warn('music status failed', error)
      return DISCONNECTED_MUSIC
    }
  }

  async play(trackId?: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const result =
        trackId === undefined
          ? await this.#engine.play()
          : await this.#engine.playTrack(this.#trackFor(trackId))
      return result.ok ? { ok: true } : { ok: false, error: result.error }
    } catch (error) {
      log.warn('music play failed', error)
      return { ok: false, error: 'Music backend is unreachable.' }
    }
  }

  pause(): Promise<{ ok: boolean; error?: string }> {
    try {
      this.#engine.pause()
      return Promise.resolve({ ok: true })
    } catch (error) {
      log.warn('music pause failed', error)
      return Promise.resolve({ ok: false, error: 'Music backend is unreachable.' })
    }
  }

  async next(): Promise<{ ok: boolean; error?: string }> {
    try {
      const result = await this.#engine.next()
      return result.ok ? { ok: true } : { ok: false, error: result.error }
    } catch (error) {
      log.warn('music next failed', error)
      return { ok: false, error: 'Music backend is unreachable.' }
    }
  }

  async previous(): Promise<{ ok: boolean; error?: string }> {
    try {
      const result = await this.#engine.previous()
      return result.ok ? { ok: true } : { ok: false, error: result.error }
    } catch (error) {
      log.warn('music previous failed', error)
      return { ok: false, error: 'Music backend is unreachable.' }
    }
  }

  async search(query: string): Promise<{ tracks: FocusTrack[]; error?: string }> {
    try {
      const result = await rpc.invoke('focus.music.search', { query })
      if (result.error) return { tracks: [], error: result.error }
      this.#remember(result.tracks)
      return { tracks: result.tracks }
    } catch (error) {
      log.warn('music search failed', error)
      return { tracks: [], error: 'Music backend is unreachable.' }
    }
  }

  /** No radio backend ships with Ari; the UI renders saved content instead. */
  browse(): Promise<{ tracks: FocusTrack[]; error?: string }> {
    return Promise.resolve({ tracks: [] })
  }

  setVolume(volume: number): Promise<{ ok: boolean; error?: string }> {
    try {
      this.#engine.setVolume(volume)
      return Promise.resolve({ ok: true })
    } catch (error) {
      log.warn('music volume failed', error)
      return Promise.resolve({ ok: false, error: 'Music backend is unreachable.' })
    }
  }

  seek(positionMs: number): Promise<{ ok: boolean; error?: string }> {
    try {
      this.#engine.seek(positionMs)
      return Promise.resolve({ ok: true })
    } catch (error) {
      log.warn('music seek failed', error)
      return Promise.resolve({ ok: false, error: 'Music backend is unreachable.' })
    }
  }

  shuffle(enabled: boolean): Promise<{ ok: boolean; error?: string }> {
    try {
      this.#engine.setShuffle(enabled)
      return Promise.resolve({ ok: true })
    } catch (error) {
      log.warn('music shuffle failed', error)
      return Promise.resolve({ ok: false, error: 'Music backend is unreachable.' })
    }
  }

  queue(trackId: string): Promise<{ ok: boolean; error?: string }> {
    try {
      this.#engine.queueTrack(this.#trackFor(trackId))
      return Promise.resolve({ ok: true })
    } catch (error) {
      log.warn('music queue failed', error)
      return Promise.resolve({ ok: false, error: 'Music backend is unreachable.' })
    }
  }

  async resolveUrl(url: string): Promise<FocusUrlResolve> {
    try {
      const resolved = await rpc.invoke('focus.music.resolve', { url })
      if (resolved.kind === 'track') this.#remember([resolved.track])
      if (resolved.kind === 'playlist') this.#remember(resolved.tracks)
      return resolved
    } catch (error) {
      log.warn('music resolve failed', error)
      return { kind: 'invalid', error: 'Music backend is unreachable.' }
    }
  }

  async listPlaylists(): Promise<{ playlists: AriPlaylist[] }> {
    try {
      return await rpc.invoke('focus.playlists.list')
    } catch (error) {
      log.warn('playlists list failed', error)
      return { playlists: [] }
    }
  }

  async createPlaylist(
    name: string,
    tracks?: FocusTrack[],
  ): Promise<{ playlist: AriPlaylist | null; error?: string }> {
    try {
      return await rpc.invoke('focus.playlists.create', { name: clipPlaylistName(name), tracks })
    } catch (error) {
      log.warn('playlists create failed', error)
      return { playlist: null, error: 'Playlists are unavailable right now.' }
    }
  }

  async renamePlaylist(
    id: string,
    name: string,
  ): Promise<{ playlist: AriPlaylist | null; error?: string }> {
    try {
      return await rpc.invoke('focus.playlists.rename', { id, name: clipPlaylistName(name) })
    } catch (error) {
      log.warn('playlists rename failed', error)
      return { playlist: null, error: 'Playlists are unavailable right now.' }
    }
  }

  async removePlaylist(id: string): Promise<{ ok: boolean; error?: string }> {
    try {
      return await rpc.invoke('focus.playlists.remove', { id })
    } catch (error) {
      log.warn('playlists remove failed', error)
      return { ok: false, error: 'Playlists are unavailable right now.' }
    }
  }

  async updatePlaylist(
    id: string,
    tracks: FocusTrack[],
  ): Promise<{ playlist: AriPlaylist | null; error?: string }> {
    try {
      return await rpc.invoke('focus.playlists.update', { id, tracks })
    } catch (error) {
      log.warn('playlists update failed', error)
      return { playlist: null, error: 'Playlists are unavailable right now.' }
    }
  }

  async playPlaylist(id: string, shuffle?: boolean): Promise<{ ok: boolean; error?: string }> {
    try {
      const { playlist } = await rpc.invoke('focus.playlists.get', { id })
      if (!playlist || playlist.tracks.length === 0) {
        return { ok: false, error: 'Nothing to play.' }
      }
      this.#remember(playlist.tracks)
      const result = await this.#engine.setQueue(playlist.tracks, {
        shuffle,
        autoplay: true,
      })
      return result.ok ? { ok: true } : { ok: false, error: result.error }
    } catch (error) {
      log.warn('playlists play failed', error)
      return { ok: false, error: 'Playlists are unavailable right now.' }
    }
  }
}
