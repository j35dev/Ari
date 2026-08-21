
/** The four visual row kinds the transcript renders. */
export type TranscriptBlockKind = 'markdown' | 'thinking' | 'tool-call' | 'tool-result'

/**
 * One virtualizable transcript row, derived 1:1 from a `MessagePart`. The key
 * is stable across streaming updates (`msgId#partIndex`) so the virtualizer
 * and React reconciliation stay anchored while parts append.
 */
export interface TranscriptBlock {
  key: string
  kind: TranscriptBlockKind
  /** Markdown / thinking body. */
  text?: string
  callId?: string
  name?: string
  argsJson?: string
  resultJson?: string
  isError?: boolean
}
