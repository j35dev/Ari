import type { JournalEvent } from '@ari/contracts/events'
import { spokenLine } from '@ari/contracts/aria-voice'

/** Only a current, idle, human voice request may trigger automatic speech. */
export class VoiceTurn {
  private armed: { sessionId: string; text: string; at: number } | null = null
  private current: { sessionId: string; turnId: string; messageId?: string; text: string; spoke: boolean } | null = null
  constructor(
    private readonly speak: (text: string) => void,
    private readonly enabled: () => boolean,
    private readonly now = Date.now,
  ) {}
  arm(sessionId: string, text: string): void {
    this.clear()
    this.armed = { sessionId, text, at: this.now() }
  }
  clear(): void {
    this.armed = null
    this.current = null
  }
  observe(event: JournalEvent): void {
    if (!this.enabled()) {
      this.clear()
      return
    }
    if (event.type === 'user.message.added' && this.armed?.sessionId === event.sessionId) {
      const request = this.armed
      this.armed = null
      const text = event.message.parts
        .filter((p) => p.type === 'text')
        .map((p) => p.text)
        .join('')
      if (
        this.now() - request.at < 30_000 &&
        text.trim() === request.text.trim() &&
        event.message.turnId &&
        (!event.message.origin || event.message.origin.kind === 'human')
      )
        this.current = {
          sessionId: event.sessionId,
          turnId: event.message.turnId,
          text: '',
          spoke: false,
        }
    }
    const current = this.current
    if (!current || current.sessionId !== event.sessionId) return
    if (event.type === 'assistant.parts.appended') {
      // A final reply is a separate message from routine commentary.
      if (event.messageId !== current.messageId) {
        current.messageId = event.messageId
        current.text = ''
      }
      for (const part of event.parts) {
        if (part.type === 'text') current.text += part.text
        else if (part.type === 'tool-call' || part.type === 'tool-result') current.text = ''
      }
      const line = spokenLine(current.text)
      if (line && !current.spoke) {
        current.spoke = true
        this.speak(current.text)
      }
    } else if (event.type === 'turn.settled' && event.turnId === current.turnId) {
      this.current = null
      if (event.stopReason === 'completed' && !current.spoke && current.text.trim())
        this.speak(current.text)
    }
  }
}
