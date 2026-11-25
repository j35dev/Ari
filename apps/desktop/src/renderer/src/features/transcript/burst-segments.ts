import { classifyToolCall } from './toolLabels'
import type { TranscriptBlock } from './types'

/**
 * A burst's steps as the reader sees them: looking around (reads, searches
 * and the thoughts between them) folds into one "Explored" line, while every
 * command and edit keeps a line of its own, so what the agent actually did
 * stays on the page.
 */
export type BurstSegment =
  | {
      kind: 'explore'
      /** From the first block, so the line keeps its identity as it grows. */
      key: string
      blocks: TranscriptBlock[]
      calls: TranscriptBlock[]
    }
  | { kind: 'step'; key: string; block: TranscriptBlock }

function explores(block: TranscriptBlock): boolean {
  if (block.kind === 'thinking') return true
  if (block.kind !== 'tool-call') return false
  const kind = classifyToolCall(block)
  return kind === 'read' || kind === 'search'
}

export function burstSegments(steps: readonly TranscriptBlock[]): BurstSegment[] {
  const segments: BurstSegment[] = []
  let open: Extract<BurstSegment, { kind: 'explore' }> | null = null
  for (const step of steps) {
    if (!explores(step)) {
      open = null
      segments.push({ kind: 'step', key: step.key, block: step })
      continue
    }
    if (open === null) {
      open = { kind: 'explore', key: `explore:${step.key}`, blocks: [], calls: [] }
      segments.push(open)
    }
    open.blocks.push(step)
    if (step.kind === 'tool-call') open.calls.push(step)
  }
  return segments
}

/** "2 files, 1 search": what an exploration covered, by call. */
export function exploreTally(calls: readonly TranscriptBlock[]): string {
  let files = 0
  let searches = 0
  for (const call of calls) {
    if (classifyToolCall(call) === 'read') files++
    else searches++
  }
  const parts: string[] = []
  if (files > 0) parts.push(`${files} ${files === 1 ? 'file' : 'files'}`)
  if (searches > 0) parts.push(`${searches} ${searches === 1 ? 'search' : 'searches'}`)
  return parts.join(', ')
}
