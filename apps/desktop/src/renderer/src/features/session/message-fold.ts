import { pushMessageParts, type Message, type MessagePart } from '@ari/contracts/message'

/**
 * Mutable fold of a session's journal into its message list. Events land in
 * place; `commit` hands out an immutable snapshot only when something changed.
 *
 * A snapshot's message objects are never mutated afterwards — the transcript
 * caches its split blocks per message object — so the first append to a
 * published message after a commit copies it once, and every further append
 * before the next commit writes into that copy. A replay of N events is
 * therefore O(N) plus one snapshot, not one list rebuild per event.
 */
export interface MessageFold {
  /** Appends a whole user message, as `user.message.added` journals it. */
  addUser(message: Message): void
  /**
   * Appends streamed parts to an assistant message, starting it from
   * `start()` (parts excluded) when the id is new. A repeated tool call
   * replaces its earlier part. Returns the message's part count.
   */
  appendParts(
    messageId: string,
    parts: readonly MessagePart[],
    start: () => Omit<Message, 'parts'>,
  ): number
  /** The list as of now, or null when nothing changed since the last commit. */
  commit(): Message[] | null
}

/** Starts an empty fold. */
export function createMessageFold(): MessageFold {
  const list: Message[] = []
  const indexById = new Map<string, number>()
  // Messages created or copied since the last commit: no snapshot holds them yet.
  const drafts = new Set<string>()
  let dirty = false

  return {
    addUser(message) {
      if (!indexById.has(message.id)) indexById.set(message.id, list.length)
      list.push(message)
      dirty = true
    },
    appendParts(messageId, parts, start) {
      dirty = true
      const index = indexById.get(messageId)
      const existing = index === undefined ? undefined : list[index]
      if (index === undefined || existing === undefined) {
        const fresh: MessagePart[] = []
        pushMessageParts(fresh, parts)
        indexById.set(messageId, list.length)
        list.push({ ...start(), parts: fresh })
        drafts.add(messageId)
        return fresh.length
      }
      if (drafts.has(messageId)) {
        pushMessageParts(existing.parts, parts)
        return existing.parts.length
      }
      const copy = [...existing.parts]
      pushMessageParts(copy, parts)
      list[index] = { ...existing, parts: copy }
      drafts.add(messageId)
      return copy.length
    },
    commit() {
      if (!dirty) return null
      dirty = false
      drafts.clear()
      return list.slice()
    },
  }
}
