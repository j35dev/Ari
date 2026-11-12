import type { JournalEvent } from '@ari/contracts/events'
import { spokenLine } from '@ari/contracts/aria-voice'

/**
 * Speaks a voice turn as it happens. Only a current, idle, human voice
 * request may trigger automatic speech.
 *
 * A turn is a run of passages: what Aria writes before reaching for a tool
 * ("Finding the sessions to delete."), then what she writes after. Each
 * passage is spoken when it ends, in order, so the user hears what she is
 * doing while she does it and not one summary when it is all over. A final
 * reply that carries its own spoken line is spoken as soon as that line has
 * arrived, without waiting for the written detail under it.
 */
export class VoiceTurn {
  private armed: { sessionId: string; text: string; at: number } | null = null
  private current: {
    sessionId: string
    turnId: string
    messageId?: string
    /** The passage being written. */
    text: string
    /** That passage has already been handed to the voice. */
    spoke: boolean
    /** Something was spoken this turn, so later passages queue behind it. */
    started: boolean
  } | null = null
  constructor(
    /** `follow` queues the passage behind whatever is still being said this turn. */
    private readonly speak: (text: string, follow: boolean) => void,
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
  /** Says the passage in progress, if it has words and has not been said. */
  private flush(): void {
    const current = this.current
    if (!current) return
    if (!current.spoke && current.text.trim()) {
      this.speak(current.text, current.started)
      current.started = true
    }
    current.text = ''
    current.spoke = false
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
          started: false,
        }
    }
    const current = this.current
    if (!current || current.sessionId !== event.sessionId) return
    if (event.type === 'assistant.parts.appended') {
      // A new message ends the passage before it.
      if (event.messageId !== current.messageId) {
        if (current.messageId !== undefined) this.flush()
        current.messageId = event.messageId
      }
      for (const part of event.parts) {
        if (part.type === 'text') current.text += part.text
        // Reaching for a tool ends the passage: say it before the work starts.
        else if (part.type === 'tool-call' || part.type === 'tool-result') this.flush()
      }
      if (!current.spoke && spokenLine(current.text)) {
        current.spoke = true
        this.speak(current.text, current.started)
        current.started = true
      }
    } else if (event.type === 'turn.settled' && event.turnId === current.turnId) {
      // An interrupted turn keeps what was already said and adds nothing.
      if (event.stopReason === 'completed') this.flush()
      this.current = null
    }
  }
}
