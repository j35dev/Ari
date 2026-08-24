import type { Message, MessagePart } from '@ari/contracts/message'
import type { TranscriptBlock } from './types'

function partToBlock(message: Message, part: MessagePart, partIndex: number): TranscriptBlock {
  const key = `${message.id}#${partIndex}`
  // Assistant text rows carry message metadata so the transcript can render
  // the timestamp + copy footer under the message's final block. Every block
  // carries its turn id so per-turn diff cards can attach at boundaries.
  const meta =
    message.role === 'assistant' && part.type === 'text'
      ? {
          messageId: message.id,
          messageCreatedAt: message.createdAt,
          isLastOfMessage: false,
          turnId: message.turnId,
        }
      : { turnId: message.turnId }
  switch (part.type) {
    case 'text':
      return { key, kind: 'markdown', role: message.role, text: part.text, ...meta }
    case 'thinking':
      return { key, kind: 'thinking', role: message.role, text: part.text, ...meta }
    case 'tool-call':
      return {
        key,
        kind: 'tool-call',
        role: message.role,
        callId: part.callId,
        name: part.name,
        argsJson: part.argsJson,
        ...meta,
      }
    case 'tool-result':
      return {
        key,
        kind: 'tool-result',
        role: message.role,
        callId: part.callId,
        resultJson: part.resultJson,
        isError: part.isError,
        ...meta,
      }
  }
}

/**
 * Purely flattens an ordered message list into the flat block list the
 * virtualizer renders. Contiguous text parts — the engine flushes streamed
 * deltas every ~120ms as separate parts — coalesce into ONE block per run so
 * paragraphs flow instead of rendering one fragment per line; the merged
 * block's key (`msgId#firstPartIndex`) stays stable while it grows.
 * Thinking parts merge the same way; any tool block breaks the run.
 */
export function splitBlocks(messages: Message[]): TranscriptBlock[] {
  const blocks: TranscriptBlock[] = []
  for (const message of messages) {
    let mergeIndex: number | null = null
    let mergeKind: 'text' | 'thinking' | null = null

    message.parts.forEach((part, partIndex) => {
      const blockKind =
        part.type === 'text' ? 'markdown' : part.type === 'thinking' ? 'thinking' : null
      if (blockKind !== null && mergeKind === blockKind && mergeIndex !== null) {
        const target = blocks[mergeIndex]
        if (target !== undefined && target.kind === blockKind) {
          target.text = (target.text ?? '') + part.text
          return
        }
      }
      blocks.push(partToBlock(message, part, partIndex))
      mergeIndex = blocks.length - 1
      mergeKind = blockKind
    })

    // The message footer attaches to the final markdown block, whichever
    // part it came from.
    const last = blocks[blocks.length - 1]
    if (message.role === 'assistant' && last !== undefined && last.kind === 'markdown') {
      last.isLastOfMessage = true
    }
  }
  return blocks
}

/**
 * Call ids that have a tool-call but no matching tool-result yet — used to
 * drive the pending status dot on tool cards.
 */
export function pendingToolCallIds(blocks: TranscriptBlock[]): Set<string> {
  const called = new Set<string>()
  const answered = new Set<string>()
  for (const block of blocks) {
    if (block.kind === 'tool-call' && block.callId) called.add(block.callId)
    if (block.kind === 'tool-result' && block.callId) answered.add(block.callId)
  }
  for (const callId of answered) called.delete(callId)
  return called
}
