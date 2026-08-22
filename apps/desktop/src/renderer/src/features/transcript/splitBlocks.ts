import type { Message, MessagePart } from '@ari/contracts/message'
import type { TranscriptBlock } from './types'

function partToBlock(
  messageId: string,
  role: Message['role'],
  part: MessagePart,
  partIndex: number,
): TranscriptBlock {
  const key = `${messageId}#${partIndex}`
  switch (part.type) {
    case 'text':
      return { key, kind: 'markdown', role, text: part.text }
    case 'thinking':
      return { key, kind: 'thinking', role, text: part.text }
    case 'tool-call':
      return {
        key,
        kind: 'tool-call',
        role,
        callId: part.callId,
        name: part.name,
        argsJson: part.argsJson,
      }
    case 'tool-result':
      return {
        key,
        kind: 'tool-result',
        role,
        callId: part.callId,
        resultJson: part.resultJson,
        isError: part.isError,
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
      blocks.push(partToBlock(message.id, message.role, part, partIndex))
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
