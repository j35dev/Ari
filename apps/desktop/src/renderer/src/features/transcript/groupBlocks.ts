import { classifyToolCall, describeToolCall } from './toolLabels'
import type { ToolGroupRow, TranscriptBlock, TranscriptRow, TurnDiffRow } from './types'

export type { TranscriptRow } from './types'

/**
 * Blocks that belong to a collapsed activity run: the tool traffic itself plus
 * the reasoning threaded between calls. Folding thinking in is what keeps a
 * long turn from rendering as dozens of alternating `thinking` / `Ran 1
 * command` rows — only assistant prose and user messages break a run.
 */
function isActivityBlock(block: TranscriptBlock): boolean {
  return block.kind === 'tool-call' || block.kind === 'tool-result' || block.kind === 'thinking'
}

function hasToolTraffic(run: TranscriptBlock[]): boolean {
  return run.some((b) => b.kind === 'tool-call' || b.kind === 'tool-result')
}

/** The turn a row belongs to, or null for rows outside any turn. */
function rowTurnId(row: TranscriptRow): string | null {
  if (row.kind === 'tool-group') return row.blocks[0]?.turnId ?? null
  if (row.kind === 'turn-diff') return row.turnId
  return row.turnId ?? null
}

/**
 * Appends one collapsed {@link TurnDiffRow} after the last row of each turn
 * present in `turnDiffs`. Cards attach at turn boundaries so they trail the
 * turn's assistant/tool blocks; turns without an entry render untouched.
 */
export function insertTurnDiffRows(
  rows: TranscriptRow[],
  turnDiffs: Readonly<Record<string, string>>,
): TranscriptRow[] {
  const out: TranscriptRow[] = []
  const emitted = new Set<string>()
  let openTurnId: string | null = null
  const flushCard = (): void => {
    if (openTurnId === null) return
    const diffText = turnDiffs[openTurnId]
    if (typeof diffText === 'string' && diffText.length > 0 && !emitted.has(openTurnId)) {
      emitted.add(openTurnId)
      const row: TurnDiffRow = {
        kind: 'turn-diff',
        key: `turn-diff:${openTurnId}`,
        turnId: openTurnId,
        diffText,
      }
      out.push(row)
    }
    openTurnId = null
  }
  for (const row of rows) {
    const turnId = rowTurnId(row)
    if (turnId !== openTurnId) {
      flushCard()
      openTurnId = turnId
    }
    out.push(row)
  }
  flushCard()
  return out
}

/** Long tool runs chunk into bursts of at most this many calls per row. */
export const MAX_CALLS_PER_GROUP = 6

function callsIn(run: TranscriptBlock[]): number {
  let n = 0
  for (const b of run) if (b.kind === 'tool-call') n++
  return n
}

/**
 * Collapses each run of consecutive work blocks — tool calls, results, and the
 * reasoning between them — into activity rows ("Ran 3 commands · Edited 1
 * file"), leaving assistant prose and user bubbles as their own rows. Long
 * runs chunk into bursts of at most {@link MAX_CALLS_PER_GROUP} calls so an
 * expanded row stays a short step list instead of a fifty-line dropdown. A
 * burst carrying any tool traffic always becomes a group, even a single
 * in-flight call, so the row does not change shape as results stream in; a
 * lone thinking block stays a plain thinking row. Group keys span first→last
 * member so they stay stable while more parts arrive. When `turnDiffs` carries
 * an entry for a settled turn, a collapsed diff card is appended after that
 * turn's final row.
 */
export function groupBlocks(
  blocks: TranscriptBlock[],
  turnDiffs?: Readonly<Record<string, string>>,
): TranscriptRow[] {
  const rows: TranscriptRow[] = []
  let run: TranscriptBlock[] = []

  const flush = (): void => {
    if (run.length === 0) return
    const first = run[0]
    const last = run[run.length - 1]
    if (first === undefined || last === undefined) {
      run = []
      return
    }
    if (!hasToolTraffic(run)) {
      rows.push(...run)
    } else {
      const calls = run.filter((b) => b.kind === 'tool-call')
      const resultsByCallId = new Map<string, TranscriptBlock>()
      for (const block of run) {
        if (block.kind === 'tool-result' && block.callId) {
          resultsByCallId.set(block.callId, block)
        }
      }
      rows.push({
        kind: 'tool-group',
        key: `${first.key}..${last.key}`,
        blocks: run,
        calls,
        resultsByCallId,
      })
    }
    run = []
  }

  for (const block of blocks) {
    if (isActivityBlock(block)) {
      if (block.kind === 'tool-call' && hasToolTraffic(run) && callsIn(run) >= MAX_CALLS_PER_GROUP) {
        flush()
      }
      run.push(block)
    } else {
      flush()
      rows.push(block)
    }
  }
  flush()
  if (turnDiffs !== undefined && Object.keys(turnDiffs).length > 0) {
    return insertTurnDiffRows(rows, turnDiffs)
  }
  return rows
}

export interface ToolActivitySummary {
  ran: number
  edited: number
  read: number
  searched: number
  errors: number
  pending: number
}

/**
 * Human summary of a tool run: "Ran 2 commands · Edited 3 files". Pure; used
 * by the activity row and its tests.
 */
export function summarizeToolRun(
  calls: TranscriptBlock[],
  resultsByCallId: Map<string, TranscriptBlock>,
): ToolActivitySummary {
  const summary: ToolActivitySummary = {
    ran: 0,
    edited: 0,
    read: 0,
    searched: 0,
    errors: 0,
    pending: 0,
  }
  for (const call of calls) {
    switch (classifyToolCall(call)) {
      case 'edit':
        summary.edited += 1
        break
      case 'read':
        summary.read += 1
        break
      case 'search':
        summary.searched += 1
        break
      default:
        summary.ran += 1
    }

    const result = call.callId ? resultsByCallId.get(call.callId) : undefined
    if (!result) summary.pending += 1
    else if (result.isError) summary.errors += 1
  }
  return summary
}

/** Renders the summary as a compact sentence; empty when nothing happened. */
export function formatToolSummary(summary: ToolActivitySummary): string {
  const parts: string[] = []
  if (summary.ran > 0) parts.push(`Ran ${summary.ran} command${summary.ran === 1 ? '' : 's'}`)
  if (summary.edited > 0) parts.push(`Edited ${summary.edited} file${summary.edited === 1 ? '' : 's'}`)
  if (summary.read > 0) parts.push(`Read ${summary.read} file${summary.read === 1 ? '' : 's'}`)
  if (summary.searched > 0)
    parts.push(`Searched ${summary.searched} time${summary.searched === 1 ? '' : 's'}`)
  return parts.join(' · ')
}

/**
 * Single-line headline for a collapsed activity row. While a call is in flight
 * it names that call ("Running git status") so the row doubles as the live
 * progress readout; once every call has answered it falls back to the settled
 * tally ("Ran 3 commands · Read 2 files"). Reasoning trailing a finished run
 * reads as "Thinking".
 */
export function activityHeadline(row: Pick<ToolGroupRow, 'blocks' | 'calls' | 'resultsByCallId'>): string {
  const summary = summarizeToolRun(row.calls, row.resultsByCallId)
  if (summary.pending > 0) {
    for (let i = row.calls.length - 1; i >= 0; i--) {
      const call = row.calls[i]
      if (call === undefined) continue
      if (call.callId && row.resultsByCallId.has(call.callId)) continue
      const { verb, target } = describeToolCall(call, true)
      return target.length > 0 ? `${verb} ${target}` : verb
    }
  }
  if (row.blocks[row.blocks.length - 1]?.kind === 'thinking') return 'Thinking'
  const settled = formatToolSummary(summary)
  if (settled.length > 0) return settled
  return `${row.calls.length} tool call${row.calls.length === 1 ? '' : 's'}`
}
