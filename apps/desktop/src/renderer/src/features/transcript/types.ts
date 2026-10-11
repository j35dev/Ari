import type { Message } from '@ari/contracts/message'

/** The visual row kinds the transcript renders. */
export type TranscriptBlockKind =
  'markdown' | 'thinking' | 'tool-call' | 'tool-result' | 'error-note' | 'image'

/** One staged image inside an `image` row (all of a message's images share it). */
export interface TranscriptImage {
  attachmentId: string
  name: string
  mimeType: string
  size: number
}

/** Rows the virtualizer renders: plain blocks, collapsed tool runs, turn diffs, delegated work. */
export type TranscriptRow = GroupedRow | DelegationRow

/** What grouping a message list yields, before delegated work is placed among it. */
export type GroupedRow = TranscriptBlock | ToolGroupRow | TurnDiffRow

export type DelegatedChildState =
  | 'working'
  | 'needs-you'
  | 'waiting'
  | 'done'
  | 'failed'
  | 'stopped'
  | 'idle'
  | 'removed'

/** One child session a turn delegated to, as its task card shows it. */
export interface DelegatedChild {
  sessionId: string
  title: string
  role: string | null
  driverKind: string
  modelId: string | null
  state: DelegatedChildState
  /** Epoch ms the running turn started; null unless working. */
  startedAt: number | null
  /** The child's final message, once it has one. */
  report: string | null
  /** Where in the transcript the spawn happened. */
  anchor: { messageId: string | null; partIndex: number }
}

/** The children spawned at one point in a turn, shown as one group of task cards. */
export interface DelegationRow {
  kind: 'delegation'
  /** Stable key derived from the group's first child. */
  key: string
  children: DelegatedChild[]
}

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
  /** Who sent a user message when it was not typed here: another session, or Ari. */
  origin?: Message['origin']
}

/**
 * A run of consecutive work blocks — tool calls, their results, and the
 * reasoning interleaved between them — collapsed into one activity row.
 */
export interface ToolGroupRow {
  kind: 'tool-group'
  /** Stable key derived from the run's first block. */
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
