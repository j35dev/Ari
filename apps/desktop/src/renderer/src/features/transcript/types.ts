import type { Message } from '@ari/contracts/message'

/** The visual row kinds the transcript renders. */
export type TranscriptBlockKind = 'markdown' | 'thinking' | 'tool-call' | 'tool-result'

/**
 * One virtualizable transcript row, derived 1:1 from a `MessagePart`. The key
 * is stable across streaming updates (`msgId#partIndex`) so the virtualizer
 * and React reconciliation stay anchored while parts append.
 */
export interface TranscriptBlock {
  key: string
  kind: TranscriptBlockKind
  /** Owning message role; drives user-bubble vs assistant styling. */
  role?: Message['role']
  /** Markdown / thinking body. */
  text?: string
  callId?: string
  name?: string
  argsJson?: string
  resultJson?: string
  isError?: boolean
  /** Owning message id (assistant text rows) — drives the copy footer. */
  messageId?: string
  /** Owning message creation time (assistant text rows). */
  messageCreatedAt?: number
  /** True on the final text part of its message; the footer renders there. */
  isLastOfMessage?: boolean
}

/** A run of consecutive tool blocks collapsed into one activity row. */
export interface ToolGroupRow {
  kind: 'tool-group'
  /** Stable key spanning first→last member block. */
  key: string
  calls: TranscriptBlock[]
  resultsByCallId: Map<string, TranscriptBlock>
}
