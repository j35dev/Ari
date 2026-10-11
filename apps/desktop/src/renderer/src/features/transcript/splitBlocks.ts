import type { Message, MessagePart } from '@ari/contracts/message'
import type { TranscriptBlock, TranscriptImage } from './types'

/**
 * Marker the engine injects before provider failure text when it appends the
 * error to the streaming assistant message (engine `#runTurn`). Blocks whose
 * text opens with it render as styled error notes instead of markdown.
 */
const ERROR_MARKER = /^\s*⚠\s?/

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
    case 'text': {
      if (message.role === 'assistant' && ERROR_MARKER.test(part.text)) {
        return {
          key,
          kind: 'error-note',
          role: message.role,
          text: part.text.replace(ERROR_MARKER, ''),
          ...meta,
        }
      }
      return { key, kind: 'markdown', role: message.role, text: part.text, ...meta }
    }
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
    case 'image':
      return {
        key,
        kind: 'image',
        role: message.role,
        images: [
          {
            attachmentId: part.attachmentId,
            name: part.name,
            mimeType: part.mimeType,
            size: part.size,
          },
        ],
        turnId: message.turnId,
      }
  }
}

/**
 * Blocks last built for a message object. Messages are replaced, never
 * mutated, so a hit is exact — a settled message is split once for as long as
 * it lives, however many times the transcript re-renders around it.
 */
const blocksByMessage = new WeakMap<Message, TranscriptBlock[]>()

function sameImages(a: TranscriptImage[] | undefined, b: TranscriptImage[] | undefined): boolean {
  if (a === b) return true
  if (a === undefined || b === undefined || a.length !== b.length) return false
  return a.every((image, index) => image.attachmentId === b[index]?.attachmentId)
}

function sameBlock(a: TranscriptBlock, b: TranscriptBlock): boolean {
  return (
    a.kind === b.kind &&
    a.role === b.role &&
    a.text === b.text &&
    a.callId === b.callId &&
    a.name === b.name &&
    a.argsJson === b.argsJson &&
    a.resultJson === b.resultJson &&
    a.isError === b.isError &&
    a.messageId === b.messageId &&
    a.messageCreatedAt === b.messageCreatedAt &&
    a.isLastOfMessage === b.isLastOfMessage &&
    a.turnId === b.turnId &&
    sameImages(a.images, b.images)
  )
}

/**
 * Purely flattens an ordered message list into the flat block list the
 * transcript renders. Contiguous text parts — the engine flushes streamed
 * deltas every ~120ms as separate parts — coalesce into ONE block per run so
 * paragraphs flow instead of rendering one fragment per line; the merged
 * block's key (`msgId#firstPartIndex`) stays stable while it grows.
 * Thinking parts merge the same way; any tool block breaks the run.
 *
 * Returned blocks are immutable. Pass the `previous` result and every block
 * the new messages leave unchanged comes back as the *same object*, so a
 * streaming flush hands React one changed row instead of a transcript of
 * fresh ones.
 */
export function splitBlocks(messages: Message[], previous?: TranscriptBlock[]): TranscriptBlock[] {
  let prior: Map<string, TranscriptBlock> | null = null
  const out: TranscriptBlock[] = []
  for (const message of messages) {
    const cached = blocksByMessage.get(message)
    if (cached !== undefined) {
      for (const block of cached) out.push(block)
      continue
    }
    const blocks: TranscriptBlock[] = []
    let mergeIndex: number | null = null
    let mergeKind: 'markdown' | 'thinking' | null = null
    // A message's images render as one thumbnail strip, not one row per
    // file; user messages are journaled whole, so the run never grows later.
    let imageStart: number | null = null
    let imageRun: TranscriptImage[] = []

    const flushImages = (): void => {
      if (imageStart === null || imageRun.length === 0) return
      blocks.push({
        key: `${message.id}#img${imageStart}`,
        kind: 'image',
        role: message.role,
        images: imageRun,
        turnId: message.turnId,
      })
      mergeIndex = blocks.length - 1
      mergeKind = null
      imageStart = null
      imageRun = []
    }

    message.parts.forEach((part, partIndex) => {
      if (part.type === 'image') {
        if (imageStart === null) imageStart = partIndex
        imageRun.push({
          attachmentId: part.attachmentId,
          name: part.name,
          mimeType: part.mimeType,
          size: part.size,
        })
        mergeKind = null
        return
      }
      flushImages()
      // An error note is its own block: the marker check lives in partToBlock,
      // but the merge must not swallow the part before it gets there.
      if (
        part.type === 'text' &&
        mergeKind === 'markdown' &&
        mergeIndex !== null &&
        !ERROR_MARKER.test(part.text)
      ) {
        const target = blocks[mergeIndex]
        if (target !== undefined && target.kind === 'markdown') {
          target.text = (target.text ?? '') + part.text
          return
        }
      }
      if (part.type === 'thinking' && mergeKind === 'thinking' && mergeIndex !== null) {
        const target = blocks[mergeIndex]
        if (target !== undefined && target.kind === 'thinking') {
          target.text = (target.text ?? '') + part.text
          return
        }
      }
      blocks.push(partToBlock(message, part, partIndex))
      mergeIndex = blocks.length - 1
      mergeKind = part.type === 'text' ? 'markdown' : part.type === 'thinking' ? 'thinking' : null
    })
    flushImages()

    // The message footer attaches to the final markdown or error-note block,
    // whichever part came last.
    const last = blocks[blocks.length - 1]
    if (
      message.role === 'assistant' &&
      last !== undefined &&
      (last.kind === 'markdown' || last.kind === 'error-note')
    ) {
      last.isLastOfMessage = true
    }

    let shared = blocks
    if (previous !== undefined && previous.length > 0) {
      prior ??= new Map(previous.map((block) => [block.key, block]))
      const known = prior
      shared = blocks.map((block) => {
        const before = known.get(block.key)
        return before !== undefined && sameBlock(before, block) ? before : block
      })
    }
    blocksByMessage.set(message, shared)
    for (const block of shared) out.push(block)
  }
  return out
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
