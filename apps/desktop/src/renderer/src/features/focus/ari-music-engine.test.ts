import { describe, expect, it, vi } from 'vitest'
import type { FocusTrack } from '@ari/contracts/rpc'
import { AriMusicEngine, type EngineAudioElement, type EngineSnapshot } from './ari-music-engine'

function track(id: string, title = `Title ${id}`): FocusTrack {
  return { id, title, artist: 'Artist', station: '', sourceUrl: id }
}

class FakeAudio implements EngineAudioElement {
  src = ''
  currentTime = 0
  duration = Number.NaN
  volume = 0.5
  paused = true
  readonly played: string[] = []
  readonly #listeners = new Map<string, Set<() => void>>()

  play(): Promise<void> {
    this.played.push(this.src)
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

  /** Pretend metadata arrived for the current src. */
  load(durationSeconds: number): void {
    this.duration = durationSeconds
    this.fire('loadedmetadata')
  }
}

function setup(resolver?: (track: FocusTrack) => Promise<string>) {
  const audio = new FakeAudio()
  const resolveStream = vi.fn(resolver ?? (async (track: FocusTrack) => `stream:${track.id}`))
  const engine = new AriMusicEngine({ createAudio: () => audio, resolveStream })
  const snapshots: EngineSnapshot[] = []
  const unsubscribe = engine.subscribe((snapshot) => snapshots.push(snapshot))
  return { audio, engine, resolveStream, snapshots, unsubscribe }
}

/** Lets pending microtasks and short timers settle between event injections. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

describe('AriMusicEngine', () => {
  it('starts idle with the default volume', () => {
    const { engine } = setup()
    expect(engine.getSnapshot()).toMatchObject({
      playing: false,
      track: null,
      positionMs: 0,
      durationMs: null,
      volume: 50,
      shuffle: false,
      loading: false,
    })
  })

  it('plays a track through the resolved stream URL', async () => {
    const { audio, engine, resolveStream } = setup()
    const result = await engine.playTrack(track('a'))
    expect(result).toEqual({ ok: true })
    expect(resolveStream).toHaveBeenCalledTimes(1)
    expect(audio.src).toBe('stream:a')
    expect(engine.getSnapshot()).toMatchObject({ playing: true, track: { id: 'a' } })
  })

  it('emits snapshots to subscribers on every change', async () => {
    const { audio, engine, snapshots } = setup()
    expect(snapshots).toHaveLength(1)
    await engine.playTrack(track('a'))
    audio.load(200)
    audio.currentTime = 12
    audio.fire('timeupdate')
    const last = snapshots.at(-1)
    expect(last).toMatchObject({ playing: true, positionMs: 12_000, durationMs: 200_000 })
    expect(snapshots.length).toBeGreaterThan(3)
  })

  it('unsubscribes cleanly', async () => {
    const { engine, snapshots, unsubscribe } = setup()
    unsubscribe()
    await engine.playTrack(track('a'))
    expect(snapshots).toHaveLength(1)
  })

  it('walks the queue with next and previous', async () => {
    const { engine } = setup()
    await engine.setQueue([track('a'), track('b'), track('c')])
    expect(engine.getSnapshot().track?.id).toBe('a')
    await engine.next()
    expect(engine.getSnapshot().track?.id).toBe('b')
    await engine.previous()
    expect(engine.getSnapshot().track?.id).toBe('a')
    expect(await engine.next()).toEqual({ ok: true })
    expect(await engine.next()).toEqual({ ok: true })
    expect(await engine.next()).toEqual({ ok: false, error: 'End of queue.' })
  })

  it('previous at the start restarts the track', async () => {
    const { audio, engine } = setup()
    await engine.playTrack(track('a'))
    audio.currentTime = 30
    expect(await engine.previous()).toEqual({ ok: true })
    expect(audio.currentTime).toBe(0)
  })

  it('appends queued tracks without interrupting playback', async () => {
    const { engine } = setup()
    await engine.playTrack(track('a'))
    engine.queueTrack(track('b'))
    expect(engine.getSnapshot().track?.id).toBe('a')
    await engine.next()
    expect(engine.getSnapshot().track?.id).toBe('b')
  })

  it('keeps the current track when shuffle toggles', async () => {
    const { engine } = setup()
    const tracks = [track('a'), track('b'), track('c'), track('d')]
    await engine.setQueue(tracks)
    engine.setShuffle(true)
    expect(engine.getSnapshot()).toMatchObject({ shuffle: true, track: { id: 'a' } })
    engine.setShuffle(false)
    expect(engine.getSnapshot()).toMatchObject({ shuffle: false, track: { id: 'a' } })
  })

  it('advances automatically when a track ends', async () => {
    const { audio, engine } = setup()
    await engine.setQueue([track('a'), track('b')])
    audio.fire('ended')
    await Promise.resolve()
    await Promise.resolve()
    expect(engine.getSnapshot().track?.id).toBe('b')
  })

  it('pauses and resumes without re-resolving', async () => {
    const { engine, resolveStream } = setup()
    await engine.playTrack(track('a'))
    engine.pause()
    expect(engine.getSnapshot().playing).toBe(false)
    expect(await engine.play()).toEqual({ ok: true })
    expect(engine.getSnapshot().playing).toBe(true)
    expect(resolveStream).toHaveBeenCalledTimes(1)
  })

  it('applies seek and volume to the element', async () => {
    const { audio, engine } = setup()
    await engine.playTrack(track('a'))
    engine.seek(72_000)
    expect(audio.currentTime).toBe(72)
    engine.setVolume(33)
    expect(audio.volume).toBeCloseTo(0.33)
    expect(engine.getSnapshot().volume).toBe(33)
  })

  it('reports stream failures as data with a neutral detail', async () => {
    const { engine } = setup(async () => {
      throw new Error('nope')
    })
    const result = await engine.playTrack(track('a'))
    expect(result).toEqual({ ok: false, error: "This track can't be played." })
    expect(engine.getSnapshot().detail).toBe("This track can't be played.")
  })

  it('ignores a stale resolve when a newer track wins the race', async () => {
    let release!: (url: string) => void
    const gate = new Promise<string>((resolve) => {
      release = resolve
    })
    const { audio, engine } = setup(() => gate)
    const first = engine.playTrack(track('a'))
    const second = engine.playTrack(track('b'))
    release('stream:b')
    expect(await second).toEqual({ ok: true })
    release('stream:a')
    expect(await first).toEqual({ ok: false })
    expect(audio.src).toBe('stream:b')
    expect(engine.getSnapshot().track?.id).toBe('b')
  })

  it('refuses to play with an empty queue', async () => {
    const { engine } = setup()
    expect(await engine.play()).toEqual({ ok: false, error: 'Nothing to play.' })
    expect(await engine.setQueue([])).toEqual({ ok: false, error: 'Nothing to play.' })
  })

  it('recovers an expired stream: same position, playback resumes', async () => {
    const audio = new FakeAudio()
    const refreshFlags: (boolean | undefined)[] = []
    const engine = new AriMusicEngine({
      createAudio: () => audio,
      resolveStream: async (_track, options) => {
        refreshFlags.push(options?.refresh)
        return refreshFlags.length === 1 ? 'url:1' : 'url:2'
      },
    })
    await engine.playTrack(track('a'))
    audio.load(300)
    audio.currentTime = 142
    audio.fire('error')
    await flush()
    await flush()
    expect(audio.src).toBe('url:2')
    audio.load(300)
    audio.fire('loadedmetadata')
    await flush()
    await flush()
    expect(audio.currentTime).toBe(142)
    expect(engine.getSnapshot()).toMatchObject({ playing: true, track: { id: 'a' } })
    expect(refreshFlags).toEqual([undefined, true])
  })

  it('retries an expired stream exactly once, then surfaces the error', async () => {
    const audio = new FakeAudio()
    let calls = 0
    const engine = new AriMusicEngine({
      createAudio: () => audio,
      resolveStream: async () => {
        calls++
        if (calls === 1) return 'url:1'
        throw new Error('expired again')
      },
    })
    await engine.playTrack(track('a'))
    audio.load(300)
    audio.fire('error')
    await flush()
    await flush()
    expect(calls).toBe(2)
    expect(engine.getSnapshot().detail).toBe("This track can't be played.")
    audio.fire('error')
    await flush()
    expect(calls).toBe(2)
  })

  it('drops a stale recovery when the track changes mid-recovery', async () => {
    const audio = new FakeAudio()
    let releaseStale!: (url: string) => void
    const gate = new Promise<string>((resolve) => {
      releaseStale = resolve
    })
    let calls = 0
    const engine = new AriMusicEngine({
      createAudio: () => audio,
      resolveStream: (_t) => {
        calls++
        if (calls === 1) return Promise.resolve('url:A')
        if (calls === 2) return gate
        return Promise.resolve('url:B')
      },
    })
    await engine.playTrack(track('A'))
    audio.load(300)
    audio.fire('error')
    await flush()
    const playing = engine.playTrack(track('B'))
    await playing
    expect(audio.src).toBe('url:B')
    releaseStale('url:A-stale')
    await flush()
    await flush()
    expect(audio.src).toBe('url:B')
    expect(engine.getSnapshot().track?.id).toBe('B')
  })

  it('restores position paused when the expired track was paused', async () => {
    const audio = new FakeAudio()
    let calls = 0
    const engine = new AriMusicEngine({
      createAudio: () => audio,
      resolveStream: async () => (++calls === 1 ? 'url:1' : 'url:2'),
    })
    await engine.playTrack(track('a'))
    audio.load(300)
    audio.pause()
    const playsBefore = audio.played.length
    audio.currentTime = 50
    audio.fire('error')
    await flush()
    await flush()
    audio.load(300)
    audio.fire('loadedmetadata')
    await flush()
    await flush()
    expect(audio.src).toBe('url:2')
    expect(audio.currentTime).toBe(50)
    expect(audio.paused).toBe(true)
    expect(audio.played.length).toBe(playsBefore)
    expect(engine.getSnapshot().track?.id).toBe('a')
  })
})
