import type { Message, MessagePart } from '@ari/contracts/message'
import type { TranscriptBlock } from './types'

function partToBlock(
  message: Message,
  part: MessagePart,
  partIndex: number,
  isLastPart: boolean,
): TranscriptBlock {
  const key = `${message.id}#${partIndex}`
  // Assistant text rows carry message metadata so the transcript can render
  // the timestamp + copy footer under the message's final block. Every block
  // carries its turn id so per-turn diff cards can attach at boundaries.
  const meta =
    message.role === 'assistant' && part.type === 'text'
      ? {
          messageId: message.id,
          messageCreatedAt: message.createdAt,
          isLastOfMessage: isLastPart,
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
 * virtualizer renders. Keys are `msgId#partIndex` and therefore stable while
 * later parts stream into the same message.
 */
export function splitBlocks(messages: Message[]): TranscriptBlock[] {
  const blocks: TranscriptBlock[] = []
  for (const message of messages) {
    message.parts.forEach((part, partIndex) => {
      blocks.push(partToBlock(message, part, partIndex, partIndex === message.parts.length - 1))
    })
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
