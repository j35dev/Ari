import type { FocusTrack } from '@ari/contracts/rpc'

/** Structural audio surface; the real HTMLAudioElement satisfies it, tests fake it. */
export interface EngineAudioElement {
  src: string
  currentTime: number
  duration: number
  volume: number
  readonly paused: boolean
  play(): unknown
  pause(): void
  addEventListener(type: string, listener: () => void): void
  removeEventListener(type: string, listener: () => void): void
}

/** Local playback snapshot; the adapter maps this onto FocusMusicState. */
export interface EngineSnapshot {
  playing: boolean
  track: FocusTrack | null
  positionMs: number | null
  durationMs: number | null
  volume: number
  shuffle: boolean
  loading: boolean
  detail: string
}

/** Resolves a track to a direct audio URL (main-process stream RPC). */
export type StreamResolver = (track: FocusTrack) => Promise<string>

export interface AriMusicEngineOptions {
  createAudio?: () => EngineAudioElement
  resolveStream: StreamResolver
  initialVolume?: number
}

function finiteOrNull(seconds: number): number | null {
  return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : null
}

function shuffledOrder(length: number): number[] {
  const order = Array.from({ length }, (_, index) => index)
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    const a = order[i]
    order[i] = order[j] as number
    order[j] = a as number
  }
  return order
}

/**
 * Renderer-side playback controller (the PlaybackController of the music
 * engine). Owns the audio element, queue, shuffle order, volume, and
 * position; stream URLs come from the injected resolver so the controller
 * never touches IPC. State flows out through subscribe/getSnapshot only.
 */
export class AriMusicEngine {
  readonly #audio: EngineAudioElement
  readonly #resolveStream: StreamResolver
  readonly #listeners = new Set<(snapshot: EngineSnapshot) => void>()
  #queue: FocusTrack[] = []
  #order: number[] = []
  #position = 0
  #shuffle = false
  #volume: number
  #loading = false
  #detail = ''
  #generation = 0

  constructor(options: AriMusicEngineOptions) {
    this.#audio = (options.createAudio ?? (() => new Audio()))()
    this.#resolveStream = options.resolveStream
    this.#volume = options.initialVolume ?? 50
    this.#audio.volume = this.#volume / 100
    for (const event of ['play', 'pause', 'timeupdate', 'loadedmetadata', 'ended', 'error'] as const) {
      this.#audio.addEventListener(event, () => this.#onAudioEvent(event))
    }
  }

  getSnapshot(): EngineSnapshot {
    const track = this.#queue[this.#order[this.#position] ?? -1] ?? null
    return {
      playing: track !== null && !this.#audio.paused,
      track,
      positionMs: finiteOrNull(this.#audio.currentTime),
      durationMs: finiteOrNull(this.#audio.duration),
      volume: this.#volume,
      shuffle: this.#shuffle,
      loading: this.#loading,
      detail: this.#detail,
    }
  }

  /** Immediate snapshot plus every later change; returns the unsubscribe. */
  subscribe(listener: (snapshot: EngineSnapshot) => void): () => void {
    this.#listeners.add(listener)
    listener(this.getSnapshot())
    return () => {
      this.#listeners.delete(listener)
    }
  }

  #emit(): void {
    const snapshot = this.getSnapshot()
    for (const listener of this.#listeners) listener(snapshot)
  }

  #onAudioEvent(event: string): void {
    if (event === 'ended') {
      void this.next()
      return
    }
    if (event === 'error') this.#detail = "This track can't be played."
    this.#emit()
  }

  async #loadCurrent(): Promise<{ ok: boolean; error?: string }> {
    const track = this.#queue[this.#order[this.#position] ?? -1]
    if (!track) return { ok: false, error: 'Nothing to play.' }
    const generation = ++this.#generation
    this.#loading = true
    this.#detail = ''
    this.#emit()
    let url: string
    try {
      url = await this.#resolveStream(track)
    } catch {
      if (generation !== this.#generation) return { ok: false }
      this.#loading = false
      this.#detail = "This track can't be played."
      this.#emit()
      return { ok: false, error: "This track can't be played." }
    }
    if (generation !== this.#generation) return { ok: false }
    this.#loading = false
    if (!url) {
      this.#detail = "This track can't be played."
      this.#emit()
      return { ok: false, error: "This track can't be played." }
    }
    this.#audio.src = url
    this.#emit()
    try {
      await this.#audio.play()
    } catch {
      if (generation !== this.#generation) return { ok: false }
      this.#detail = 'Playback failed in this browser.'
      this.#emit()
      return { ok: false, error: 'Playback failed in this browser.' }
    }
    return { ok: true }
  }

  /** Replaces the queue; autoplays the first track unless told otherwise. */
  async setQueue(
    tracks: FocusTrack[],
    options: { shuffle?: boolean; autoplay?: boolean } = {},
  ): Promise<{ ok: boolean; error?: string }> {
    if (tracks.length === 0) return { ok: false, error: 'Nothing to play.' }
    this.#generation++
    this.#queue = [...tracks]
    if (options.shuffle !== undefined) this.#shuffle = options.shuffle
    this.#order = this.#shuffle ? shuffledOrder(tracks.length) : tracks.map((_, index) => index)
    this.#position = 0
    if (options.autoplay === false) {
      this.#emit()
      return { ok: true }
    }
    return this.#loadCurrent()
  }

  /** Plays one track now, replacing the queue. */
  async playTrack(track: FocusTrack): Promise<{ ok: boolean; error?: string }> {
    return this.setQueue([track], { autoplay: true })
  }

  /** Resumes the current track (loading it first when nothing is sourced). */
  async play(): Promise<{ ok: boolean; error?: string }> {
    if (this.#queue.length === 0) return { ok: false, error: 'Nothing to play.' }
    if (!this.#audio.src) return this.#loadCurrent()
    try {
      await this.#audio.play()
      return { ok: true }
    } catch {
      return { ok: false, error: 'Playback failed in this browser.' }
    }
  }

  pause(): void {
    this.#audio.pause()
  }

  async next(): Promise<{ ok: boolean; error?: string }> {
    if (this.#position + 1 >= this.#order.length) return { ok: false, error: 'End of queue.' }
    this.#position++
    return this.#loadCurrent()
  }

  async previous(): Promise<{ ok: boolean; error?: string }> {
    if (this.#position <= 0) {
      this.seek(0)
      return { ok: true }
    }
    this.#position--
    return this.#loadCurrent()
  }

  seek(positionMs: number): void {
    if (Number.isFinite(positionMs) && positionMs >= 0) {
      this.#audio.currentTime = positionMs / 1000
    }
  }

  setVolume(volume: number): void {
    this.#volume = Math.min(100, Math.max(0, Math.round(volume)))
    this.#audio.volume = this.#volume / 100
    this.#emit()
  }

  setShuffle(enabled: boolean): void {
    const current = this.#order[this.#position]
    this.#shuffle = enabled
    this.#order = enabled
      ? shuffledOrder(this.#queue.length)
      : this.#queue.map((_, index) => index)
    if (current !== undefined) {
      const kept = this.#order.indexOf(current)
      this.#position = kept === -1 ? 0 : kept
      if (enabled && kept !== 0) {
        // Keep the current track first so toggling shuffle never skips it.
        this.#order.splice(kept, 1)
        this.#order.unshift(current)
        this.#position = 0
      }
    }
    this.#emit()
  }

  /** Appends to the queue; shuffled engines slot it into the upcoming order. */
  queueTrack(track: FocusTrack): void {
    this.#queue.push(track)
    const index = this.#queue.length - 1
    if (this.#shuffle && this.#order.length > 0) {
      const at = this.#position + 1 + Math.floor(Math.random() * (this.#order.length - this.#position))
      this.#order.splice(Math.min(at, this.#order.length), 0, index)
    } else {
      this.#order.push(index)
    }
    // A first-ever queued track becomes current without autoplaying.
    if (this.#order.length === 1) this.#position = 0
    this.#emit()
  }
}
