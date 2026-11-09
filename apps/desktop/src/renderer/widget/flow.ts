import type { WidgetState } from '../../main/aria-widget/model'

export interface Recording {
  stop(): Promise<Float32Array>
  cancel(): void
  level(): number
}

export interface RecordingDeps {
  record(): Promise<Recording>
  invoke(method: string, params?: unknown): Promise<unknown>
}

export function hasSpeech(pcm: Float32Array): boolean {
  if (pcm.length < 160) return false
  let energy = 0
  for (const sample of pcm) energy += sample * sample
  return energy / pcm.length > 0.000001
}

/** Recording acquisition may outlive a quick release or cancellation. */
export class RecordingFlow {
  private state: WidgetState | null = null
  private recording: Promise<Recording> | null = null
  private meter: Recording | null = null
  private stopped = false
  private disposed = false

  constructor(private readonly deps: RecordingDeps) {}

  observe(state: WidgetState): void {
    if (this.disposed) return
    const previous = this.state
    this.state = state
    if (previous?.id !== state.id) this.cancel()
    if (state.phase === 'listening' && !this.recording) {
      this.stopped = false
      this.recording = this.begin(state.id)
      void this.recording.catch(() => undefined)
    } else if (state.phase === 'transcribing' && !this.stopped) {
      this.stopped = true
      void this.release(state.id)
    } else if (!['listening', 'transcribing'].includes(state.phase)) this.cancel()
  }

  level(): number {
    return this.meter?.level() ?? 0
  }

  private active(id: number): boolean {
    return (
      !this.disposed &&
      this.state?.id === id &&
      (this.state.phase === 'listening' || this.state.phase === 'transcribing')
    )
  }

  private async begin(id: number): Promise<Recording> {
    try {
      const recording = await this.deps.record()
      if (!this.active(id)) recording.cancel()
      else this.meter = recording
      return recording
    } catch (error) {
      if (this.active(id)) {
        const text = error instanceof Error ? error.message : 'Could not access the microphone.'
        await this.deps.invoke('ariaWidget.error', {
          id,
          text,
          setup: false,
        })
      }
      throw error
    }
  }

  private async release(id: number): Promise<void> {
    try {
      const recording = await this.recording
      if (!this.active(id)) return
      if (!recording) {
        await this.deps.invoke('ariaWidget.complete', { id, text: '' })
        return
      }
      const pcm = await recording.stop()
      this.meter = null
      if (!this.active(id)) return
      if (!hasSpeech(pcm)) {
        await this.deps.invoke('ariaWidget.complete', { id, text: '' })
        return
      }
      const result = (await this.deps.invoke('speech.transcribe', { pcm })) as { text: string }
      if (this.active(id)) await this.deps.invoke('ariaWidget.complete', { id, text: result.text })
    } catch (error) {
      if (this.active(id)) {
        const status = (await this.deps.invoke('speech.status').catch(() => ({ ready: true }))) as {
          ready: boolean
        }
        if (!this.active(id)) return
        await this.deps.invoke('ariaWidget.error', {
          id,
          text: !status.ready
            ? 'Set up speech to text in Settings'
            : error instanceof Error
              ? error.message
              : 'Could not transcribe speech.',
          setup: !status.ready,
        })
      }
    }
  }

  private cancel(): void {
    const pending = this.recording
    this.recording = null
    this.meter = null
    void pending?.then(
      (recording) => recording.cancel(),
      () => undefined,
    )
  }

  dispose(): void {
    this.disposed = true
    this.cancel()
  }
}
