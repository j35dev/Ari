export interface VoiceAudio {
  id?: number
  generation: number
  stop?: boolean
  audio?: Uint8Array
  volume?: number
}

/** Decoding is asynchronous, so check the generation both before and after it. */
export class VoicePlayback {
  private context: AudioContext | null = null
  private current: AudioBufferSourceNode | null = null
  private generation = -1
  constructor(
    private readonly acknowledge: (id: number, generation: number, error?: string) => void,
    private readonly create = () => new AudioContext(),
  ) {}
  stop(): void {
    this.current?.stop()
    this.current = null
  }
  async observe(frame: VoiceAudio): Promise<void> {
    if (frame.generation < this.generation) return
    if (frame.generation > this.generation || frame.stop) {
      this.stop()
      this.generation = frame.generation
    }
    if (frame.stop || !frame.audio || frame.id === undefined) return
    try {
      this.context ??= this.create()
      const data = new Uint8Array(frame.audio)
      const buffer = await this.context.decodeAudioData(data.buffer)
      if (frame.generation !== this.generation) return
      await this.context.resume()
      if (frame.generation !== this.generation) return
      const source = this.context.createBufferSource()
      source.buffer = buffer
      const gain = this.context.createGain()
      gain.gain.value = frame.volume ?? 1
      source.connect(gain)
      gain.connect(this.context.destination)
      this.current = source
      source.onended = () => {
        source.disconnect()
        gain.disconnect()
        if (frame.generation !== this.generation || this.current !== source) return
        this.current = null
        this.acknowledge(frame.id!, frame.generation)
      }
      source.start()
    } catch {
      if (frame.generation === this.generation)
        this.acknowledge(frame.id, frame.generation, 'Playback failed')
    }
  }
  dispose(): void {
    this.generation++
    this.stop()
    void this.context?.close()
  }
}
