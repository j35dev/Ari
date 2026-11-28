export interface VoiceAudio {
  id?: number
  generation: number
  stop?: boolean
  audio?: Uint8Array
  volume?: number
}

/** Decode in arrival order and schedule ready clips on the audio clock. */
export class VoicePlayback {
  private context: AudioContext | null = null
  private sources = new Set<AudioBufferSourceNode>()
  private ready = Promise.resolve()
  private nextStart = 0
  private abort = new AbortController()
  private generation = -1
  constructor(
    private readonly acknowledge: (id: number, generation: number, error?: string) => void,
    private readonly create = () => new AudioContext(),
  ) {}
  stop(): void {
    // Invalidate pending decode/resume work immediately, before the main IPC stop returns.
    this.generation++
    this.halt()
  }
  private halt(): void {
    this.abort.abort()
    this.abort = new AbortController()
    this.ready = Promise.resolve()
    this.nextStart = 0
    for (const source of this.sources) source.stop()
    this.sources.clear()
  }
  async observe(frame: VoiceAudio): Promise<void> {
    if (frame.generation < this.generation) return
    if (frame.generation > this.generation || frame.stop) {
      this.halt()
      this.generation = frame.generation
    }
    const { audio, generation, id, volume } = frame
    if (frame.stop || !audio || id === undefined) return
    const signal = this.abort.signal
    this.ready = this.ready.then(() => this.schedule(id, generation, audio, volume ?? 1, signal))
    await this.ready
  }
  private async schedule(
    id: number,
    generation: number,
    audio: Uint8Array,
    volume: number,
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted) return
    try {
      const context = (this.context ??= this.create())
      const buffer = await context.decodeAudioData(new Uint8Array(audio).buffer)
      if (signal.aborted) return
      if (context.state !== 'running') await context.resume()
      if (signal.aborted) return
      const source = context.createBufferSource()
      source.buffer = buffer
      const gain = context.createGain()
      gain.gain.value = volume
      source.connect(gain)
      gain.connect(context.destination)
      const disconnect = () => {
        source.disconnect()
        gain.disconnect()
      }
      const start = Math.max(context.currentTime, this.nextStart)
      try {
        source.start(start)
      } catch (error) {
        disconnect()
        throw error
      }
      this.sources.add(source)
      this.nextStart = start + buffer.duration
      source.onended = () => {
        disconnect()
        this.sources.delete(source)
        if (!signal.aborted) this.acknowledge(id, generation)
      }
    } catch {
      if (!signal.aborted) this.acknowledge(id, generation, 'Playback failed')
    }
  }
  dispose(): void {
    this.stop()
    void this.context?.close()
  }
}
