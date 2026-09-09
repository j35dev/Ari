import type { FocusMusicState, FocusTrack } from '@ari/contracts/rpc'

export type { FocusMusicState, FocusTrack }

/** Disconnected snapshot used before the first status lands and on IPC failure. */
export const DISCONNECTED_MUSIC: FocusMusicState = {
  available: false,
  playing: false,
  track: null,
  volume: null,
  supportsSearch: false,
  supportsVolume: false,
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
  setVolume(volume: number): Promise<{ ok: boolean; error?: string }>
}
