import { describe, expect, it, vi } from 'vitest'
import type { FocusTrack } from '@ari/contracts/rpc'
import type { EngineAudioElement } from './ari-music-engine'
import { AriMusicAdapter, clipPlaylistName } from './music-adapter'
import { DISCONNECTED_MUSIC } from './music-types'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('../../lib/rpc', () => ({ rpc: { invoke } }))

const TRACK: FocusTrack = {
  id: 'https://www.youtube.com/watch?v=abc',
  title: 'Nightcall',
  artist: 'Kavinsky',
  station: '',
  sourceUrl: 'https://www.youtube.com/watch?v=abc',
}

class FakeAudio implements EngineAudioElement {
  src = ''
  currentTime = 0
  duration = 213
  volume = 0.5
  paused = true
  readonly #listeners = new Map<string, Set<() => void>>()

  play(): Promise<void> {
    this.paused = false
    this.fire('play')
    return Promise.resolve()
  }

  pause(): void {
    this.paused = true
    this.fire('pause')
  }

  addEventListener(type: string, listener: () => void): void {
    let set = this.#listeners.get(type)
    if (!set) {
      set = new Set()
      this.#listeners.set(type, set)
    }
    set.add(listener)
  }

  removeEventListener(type: string, listener: () => void): void {
    this.#listeners.get(type)?.delete(listener)
  }

  fire(type: string): void {
    for (const listener of this.#listeners.get(type) ?? []) listener()
  }
}

function runtime(state = 'ready', detail = '') {
  invoke.mockImplementation(async (method: string) => {
    if (method === 'focus.music.runtime') return { state, detail }
    if (method === 'focus.music.stream') return { url: `stream:${TRACK.id}` }
    if (method === 'focus.playlists.list') return { playlists: [] }
    return { ok: true }
  })
}

function setup() {
  const audio = new FakeAudio()
  const real = new AriMusicAdapter(undefined, () => audio)
  return { audio, adapter: real }
}

describe('AriMusicAdapter', () => {
  it('clips long playlist names', () => {
    expect(clipPlaylistName('  Abend  ')).toBe('Abend')
    expect(clipPlaylistName('x'.repeat(60))).toHaveLength(48)
    expect(clipPlaylistName('   ')).toBe('Playlist')
  })

  it('maps engine plus runtime state, degrading on IPC failure', async () => {
    runtime()
    const { adapter } = setup()
    await adapter.play(TRACK.id)
    const state = await adapter.getState()
    expect(state).toMatchObject({
      available: true,
      playing: true,
      track: { id: TRACK.id },
      volume: 50,
      supportsSearch: true,
      supportsVolume: true,
    })

    invoke.mockRejectedValueOnce(new Error('ipc down'))
    await expect(new AriMusicAdapter().getState()).resolves.toEqual(DISCONNECTED_MUSIC)
  })

  it('surfaces the preparing state while the helper downloads', async () => {
    runtime('downloading', 'Preparing Focus Music…')
    const { adapter } = setup()
    expect(await adapter.getState()).toMatchObject({
      available: false,
      volume: null,
      detail: 'Preparing Focus Music…',
    })
  })

  it('plays a resolved track through the stream RPC', async () => {
    runtime()
    const { audio, adapter } = setup()
    invoke.mockImplementation(async (method: string) => {
      if (method === 'focus.music.runtime') return { state: 'ready', detail: '' }
      if (method === 'focus.music.resolve') return { kind: 'track', track: TRACK }
      if (method === 'focus.music.stream') return { url: 'https://cdn/audio.m4a' }
      return { ok: true }
    })
    expect(await adapter.resolveUrl(TRACK.id)).toMatchObject({ kind: 'track' })
    expect(await adapter.play(TRACK.id)).toEqual({ ok: true })
    expect(audio.src).toBe('https://cdn/audio.m4a')
    expect((await adapter.getState()).playing).toBe(true)
    expect(await adapter.play()).toEqual({ ok: true })
    await adapter.pause()
    expect((await adapter.getState()).playing).toBe(false)
  })

  it('caches stream URLs per track', async () => {
    runtime()
    const { adapter } = setup()
    let streams = 0
    invoke.mockImplementation(async (method: string) => {
      if (method === 'focus.music.runtime') return { state: 'ready', detail: '' }
      if (method === 'focus.music.stream') {
        streams++
        return { url: 'https://cdn/audio.m4a' }
      }
      return { ok: true }
    })
    await adapter.play(TRACK.id)
    await adapter.play(TRACK.id)
    expect(streams).toBe(1)
  })

  it('re-resolves stream URLs on refresh for expired playback', async () => {
    runtime()
    const { adapter } = setup()
    let streams = 0
    invoke.mockImplementation(async (method: string) => {
      if (method === 'focus.music.runtime') return { state: 'ready', detail: '' }
      if (method === 'focus.music.stream') {
        streams++
        return { url: `https://cdn/audio-${streams}.m4a` }
      }
      return { ok: true }
    })
    expect(await adapter.streamUrl(TRACK)).toBe('https://cdn/audio-1.m4a')
    expect(await adapter.streamUrl(TRACK, true)).toBe('https://cdn/audio-2.m4a')
    expect(streams).toBe(2)
  })

  it('reports unplayable tracks as data', async () => {
    runtime()
    const { adapter } = setup()
    invoke.mockImplementation(async (method: string) => {
      if (method === 'focus.music.runtime') return { state: 'ready', detail: '' }
      if (method === 'focus.music.stream') return { url: null, error: "This track can't be played." }
      return { ok: true }
    })
    expect(await adapter.play(TRACK.id)).toEqual({
      ok: false,
      error: "This track can't be played.",
    })
    // The failed track stays queued, so resume retries instead of idling.
    expect(await adapter.play()).toEqual({ ok: false, error: "This track can't be played." })
  })

  it('plays saved playlists through the engine queue', async () => {
    runtime()
    const { adapter } = setup()
    invoke.mockImplementation(async (method: string) => {
      if (method === 'focus.music.runtime') return { state: 'ready', detail: '' }
      if (method === 'focus.playlists.get') {
        return { playlist: { id: 'fpl_1', name: 'Mix', tracks: [TRACK] } }
      }
      if (method === 'focus.music.stream') return { url: 'https://cdn/audio.m4a' }
      return { ok: true }
    })
    expect(await adapter.playPlaylist('fpl_1')).toEqual({ ok: true })
    expect((await adapter.getState()).track?.id).toBe(TRACK.id)
  })

  it('pushes mapped states to subscribers', async () => {
    runtime()
    const { adapter } = setup()
    const states: boolean[] = []
    const unsubscribe = adapter.subscribe((state) => states.push(state.playing))
    await adapter.play(TRACK.id)
    await adapter.pause()
    unsubscribe()
    expect(states[0]).toBe(false)
    expect(states).toContain(true)
  })
})
