export type WidgetPhase = 'hidden' | 'listening' | 'transcribing' | 'sent' | 'error'

export interface WidgetState {
  id: number
  phase: WidgetPhase
  text: string
  setup: boolean
}

export interface WidgetSnapshot extends WidgetState {
  theme: string
  reducedMotion: boolean
}

export const RECORDING_LIMIT_MS = 120_000
export const TRANSCRIPTION_LIMIT_MS = 45_000
export const SENT_MS = 1_500

/** The hook and recorder can finish in either order; only the current hold may publish. */
export class HoldToTalk {
  state: WidgetState = { id: 0, phase: 'hidden', text: '', setup: false }
  private deadline = Infinity

  get expiresAt(): number {
    return this.deadline
  }

  down(now: number): boolean {
    if (this.state.phase === 'listening' || this.state.phase === 'transcribing') return false
    this.state = { id: this.state.id + 1, phase: 'listening', text: '', setup: false }
    this.deadline = now + RECORDING_LIMIT_MS
    return true
  }

  up(now: number): void {
    if (this.state.phase !== 'listening') return
    this.state = { ...this.state, phase: 'transcribing' }
    this.deadline = now + TRANSCRIPTION_LIMIT_MS
  }

  cancel(): void {
    this.state = { ...this.state, phase: 'hidden', text: '', setup: false }
    this.deadline = Infinity
  }

  finish(id: number, text: string, now: number): void {
    if (id !== this.state.id || this.state.phase !== 'transcribing') return
    if (!text.trim()) return this.cancel()
    this.state = { ...this.state, phase: 'sent', text: text.replace(/\s+/g, ' ').trim() }
    this.deadline = now + SENT_MS
  }

  error(id: number, text: string, setup: boolean, now: number): void {
    if (id !== this.state.id || !['listening', 'transcribing'].includes(this.state.phase)) return
    this.state = { ...this.state, phase: 'error', text, setup }
    this.deadline = now + 6_000
  }

  tick(now: number): void {
    if (now < this.deadline) return
    if (this.state.phase === 'listening' || this.state.phase === 'transcribing') {
      this.error(this.state.id, 'Speech timed out. Try again.', false, now)
    } else this.cancel()
  }
}
