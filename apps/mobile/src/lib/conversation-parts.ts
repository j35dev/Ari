import type { MessagePart } from '@ari/contracts/message'

export interface ConversationPart {
  part: MessagePart
  sourceIndex: number
}

export interface ConversationPresentation {
  parts: ConversationPart[]
  copyText: string
}

export type ConversationBlock =
  | { kind: 'content'; part: Extract<MessagePart, { type: 'text' | 'image' }>; sourceIndex: number }
  | { kind: 'activity'; parts: ConversationPart[]; sourceIndex: number }

/** Coalesce streamed text and thinking runs without inserting whitespace or crossing part boundaries. */
export function conversationParts(source: readonly MessagePart[]): ConversationPresentation {
  const parts: ConversationPart[] = []
  const copyChunks: string[] = []
  let run: { type: 'text' | 'thinking'; sourceIndex: number; chunks: string[] } | null = null
  const flush = (): void => {
    if (run === null) return
    parts.push({
      sourceIndex: run.sourceIndex,
      part: { type: run.type, text: run.chunks.join('') },
    })
    run = null
  }

  source.forEach((part, sourceIndex) => {
    if (part.type === 'text') copyChunks.push(part.text)
    if (part.type === 'text' || part.type === 'thinking') {
      if (run?.type === part.type) run.chunks.push(part.text)
      else {
        flush()
        run = { type: part.type, sourceIndex, chunks: [part.text] }
      }
    } else {
      flush()
      parts.push({ sourceIndex, part })
    }
  })
  flush()
  return { parts, copyText: copyChunks.join('') }
}

/** Group adjacent reasoning and tool parts into one activity block, keeping text and images separate. */
export function conversationBlocks(parts: readonly ConversationPart[]): ConversationBlock[] {
  const blocks: ConversationBlock[] = []
  for (const entry of parts) {
    const { part, sourceIndex } = entry
    if (part.type === 'thinking' || part.type === 'tool-call' || part.type === 'tool-result') {
      const previous = blocks.at(-1)
      if (previous?.kind === 'activity') previous.parts.push(entry)
      else blocks.push({ kind: 'activity', parts: [entry], sourceIndex })
    } else blocks.push({ kind: 'content', part, sourceIndex })
  }
  return blocks
}
