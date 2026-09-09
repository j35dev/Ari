import type { AriPlaylist, FocusMusicState, FocusTrack, FocusUrlResolve } from '@ari/contracts/rpc'

export type { AriPlaylist, FocusMusicState, FocusTrack, FocusUrlResolve }

/** Disconnected snapshot used before the first status lands and on IPC failure. */
export const DISCONNECTED_MUSIC: FocusMusicState = {
  available: false,
  playing: false,
  track: null,
  volume: null,
  positionMs: null,
  durationMs: null,
  supportsSearch: false,
  supportsVolume: false,
  shuffle: false,
  detail: '',
}

/** Minimal music surface the Focus pill needs; Cliamp details stay in the adapter. */
export interface MusicService {
  getState(): Promise<FocusMusicState>
  play(trackId?: string): Promise<{ ok: boolean; error?: string }>
  pause(): Promise<{ ok: boolean; error?: string }>
  next(): Promise<{ ok: boolean; error?: string }>
  previous(): Promise<{ ok: boolean; error?: string }>
  search(query: string): Promise<{ tracks: FocusTrack[]; error?: string }>
  browse(): Promise<{ tracks: FocusTrack[]; error?: string }>
  setVolume(volume: number): Promise<{ ok: boolean; error?: string }>
  seek(positionMs: number): Promise<{ ok: boolean; error?: string }>
  shuffle(enabled: boolean): Promise<{ ok: boolean; error?: string }>
  queue(trackId: string): Promise<{ ok: boolean; error?: string }>
  resolveUrl(url: string): Promise<FocusUrlResolve>
  listPlaylists(): Promise<{ playlists: AriPlaylist[] }>
  createPlaylist(
    name: string,
    tracks?: FocusTrack[],
  ): Promise<{ playlist: AriPlaylist | null; error?: string }>
  renamePlaylist(
    id: string,
    name: string,
  ): Promise<{ playlist: AriPlaylist | null; error?: string }>
  removePlaylist(id: string): Promise<{ ok: boolean; error?: string }>
  updatePlaylist(
    id: string,
    tracks: FocusTrack[],
  ): Promise<{ playlist: AriPlaylist | null; error?: string }>
  playPlaylist(id: string, shuffle?: boolean): Promise<{ ok: boolean; error?: string }>
}
