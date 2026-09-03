import type { Message } from '@ari/contracts/message'

/** The visual row kinds the transcript renders. */
export type TranscriptBlockKind =
  | 'markdown'
  | 'thinking'
  | 'tool-call'
  | 'tool-result'
  | 'error-note'
  | 'image'

/** One staged image inside an `image` row (all of a message's images share it). */
export interface TranscriptImage {
  attachmentId: string
  name: string
  mimeType: string
  size: number
}

/** Rows the virtualizer renders: plain blocks, collapsed tool runs, turn diffs. */
export type TranscriptRow = TranscriptBlock | ToolGroupRow | TurnDiffRow

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
  /** Staged images for `image` rows (one row per run of image parts). */
  images?: TranscriptImage[]
  /** Owning message id (assistant text rows) — drives the copy footer. */
  messageId?: string
  /** Owning message creation time (assistant text rows). */
  messageCreatedAt?: number
  /** True on the final text part of its message; the footer renders there. */
  isLastOfMessage?: boolean
  /** Owning turn id — lets diff cards attach after a turn's final row. */
  turnId?: string | null
}

/**
 * A run of consecutive work blocks — tool calls, their results, and the
 * reasoning interleaved between them — collapsed into one activity row.
 */
export interface ToolGroupRow {
  kind: 'tool-group'
  /** Stable key spanning first→last member block. */
  key: string
  /** Every member block in wire order; drives the expanded step list. */
  blocks: TranscriptBlock[]
  calls: TranscriptBlock[]
  resultsByCallId: Map<string, TranscriptBlock>
}

/** A settled turn's git changes rendered as one collapsed diff card. */
export interface TurnDiffRow {
  kind: 'turn-diff'
  /** Stable key derived from the turn id (`turn-diff:<turnId>`). */
  key: string
  turnId: string
  /** Raw unified diff text for the turn's checkpoint. */
  diffText: string
}
