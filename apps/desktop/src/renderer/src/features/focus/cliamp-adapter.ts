import type { AriPlaylist, FocusMusicState, FocusTrack, FocusUrlResolve } from '@ari/contracts/rpc'
import { createLogger } from '@ari/shared/logger'
import { rpc } from '../../lib/rpc'
import { DISCONNECTED_MUSIC, type MusicService } from './music-types'

const log = createLogger('ui:focus-music')

/**
 * Cliamp-backed {@link MusicService}. The UI owns 100% of the presentation;
 * every Cliamp/RPC detail (method names, failure shapes) is contained here.
 * Any IPC failure degrades to a disconnected snapshot — never a throw — so
 * the pill and the rest of the ADE keep working when Cliamp is absent.
 */
export class CliampAdapter implements MusicService {
  async getState(): Promise<FocusMusicState> {
    try {
      return await rpc.invoke('focus.music.status')
    } catch (error) {
      log.warn('music status failed', error)
      return DISCONNECTED_MUSIC
    }
  }

  async play(trackId?: string): Promise<{ ok: boolean; error?: string }> {
    try {
      return await rpc.invoke('focus.music.play', trackId ? { trackId } : {})
    } catch (error) {
      log.warn('music play failed', error)
      return { ok: false, error: 'Music backend is unreachable.' }
    }
  }

  async pause(): Promise<{ ok: boolean; error?: string }> {
    try {
      return await rpc.invoke('focus.music.pause')
    } catch (error) {
      log.warn('music pause failed', error)
      return { ok: false, error: 'Music backend is unreachable.' }
    }
  }

  async next(): Promise<{ ok: boolean; error?: string }> {
    try {
      return await rpc.invoke('focus.music.next')
    } catch (error) {
      log.warn('music next failed', error)
      return { ok: false, error: 'Music backend is unreachable.' }
    }
  }

  async previous(): Promise<{ ok: boolean; error?: string }> {
    try {
      return await rpc.invoke('focus.music.previous')
    } catch (error) {
      log.warn('music previous failed', error)
      return { ok: false, error: 'Music backend is unreachable.' }
    }
  }

  async search(query: string): Promise<{ tracks: FocusTrack[]; error?: string }> {
    try {
      return await rpc.invoke('focus.music.search', { query })
    } catch (error) {
      log.warn('music search failed', error)
      return { tracks: [], error: 'Music backend is unreachable.' }
    }
  }

  async browse(): Promise<{ tracks: FocusTrack[]; error?: string }> {
    try {
      return await rpc.invoke('focus.music.browse')
    } catch (error) {
      log.warn('music browse failed', error)
      return { tracks: [], error: 'Music backend is unreachable.' }
    }
  }

  async setVolume(volume: number): Promise<{ ok: boolean; error?: string }> {
    try {
      return await rpc.invoke('focus.music.volume', { volume })
    } catch (error) {
      log.warn('music volume failed', error)
      return { ok: false, error: 'Music backend is unreachable.' }
    }
  }

  async shuffle(enabled: boolean): Promise<{ ok: boolean; error?: string }> {
    try {
      return await rpc.invoke('focus.music.shuffle', { enabled })
    } catch (error) {
      log.warn('music shuffle failed', error)
      return { ok: false, error: 'Music backend is unreachable.' }
    }
  }

  async queue(trackId: string): Promise<{ ok: boolean; error?: string }> {
    try {
      return await rpc.invoke('focus.music.queue', { trackId })
    } catch (error) {
      log.warn('music queue failed', error)
      return { ok: false, error: 'Music backend is unreachable.' }
    }
  }

  async resolveUrl(url: string): Promise<FocusUrlResolve> {
    try {
      return await rpc.invoke('focus.music.resolve', { url })
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
      return await rpc.invoke('focus.playlists.create', { name, tracks })
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
      return await rpc.invoke('focus.playlists.rename', { id, name })
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
      return await rpc.invoke('focus.playlists.play', { id, shuffle })
    } catch (error) {
      log.warn('playlists play failed', error)
      return { ok: false, error: 'Playlists are unavailable right now.' }
    }
  }
}
