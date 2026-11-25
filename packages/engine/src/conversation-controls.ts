import type { JournalEvent } from '@ari/contracts/events'
import { pushMessageParts, type MessagePart } from '@ari/contracts/message'
import type { EventNote } from './conversation-database'

/**
 * Follows a conversation's events far enough to say where each delegation card
 * belongs, the way the transcript places it: after the part last written when
 * the spawn was recorded. Also notices acknowledgments that repeat one already
 * seen. Used when event rows are rebuilt from history.
 */
export class TranscriptPosition {
  readonly #parts = new Map<string, MessagePart[]>()
  readonly #acknowledged = new Set<string>()
  #last: { messageId: string; parts: number } | null = null

  /** The note for `event`, then folds it in. */
  next(event: JournalEvent): EventNote {
    const note: EventNote = {}
    if (event.type === 'child.session.acknowledged') {
      const key = `${event.childSessionId}\n${event.turnId}`
      if (this.#acknowledged.has(key)) note.repeat = true
      this.#acknowledged.add(key)
    }
    if (event.type === 'child.session.spawned' && this.#last) note.anchor = { ...this.#last }
    if (event.type === 'user.message.added') {
      this.#parts.set(event.message.id, [...event.message.parts])
      this.#last = { messageId: event.message.id, parts: event.message.parts.length }
    } else if (event.type === 'assistant.parts.appended') {
      const parts = this.#parts.get(event.messageId) ?? []
      pushMessageParts(parts, event.parts)
      this.#parts.set(event.messageId, parts)
      this.#last = { messageId: event.messageId, parts: parts.length }
    }
    return note
  }
}
