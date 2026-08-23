import type { TranscriptBlock, TranscriptRow, TurnDiffRow } from './types'

export type { TranscriptRow } from './types'

function isToolBlock(block: TranscriptBlock): boolean {
  return block.kind === 'tool-call' || block.kind === 'tool-result'
}

/** The turn a row belongs to, or null for rows outside any turn. */
function rowTurnId(row: TranscriptRow): string | null {
  if (row.kind === 'tool-group') return row.calls[0]?.turnId ?? null
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

/**
 * Collapses consecutive tool-call/tool-result blocks into single activity
 * rows (Zeron-style "Ran 3 commands · edited 1 file"), leaving markdown and
 * thinking rows untouched. Group keys span first→last member so they stay
 * stable while more parts stream into the run. When `turnDiffs` carries an
 * entry for a settled turn, a collapsed diff card is appended after that
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
    if (run.length === 1 && first) {
      rows.push(first)
    } else if (first && last) {
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
        calls,
        resultsByCallId,
      })
    }
    run = []
  }

  for (const block of blocks) {
    if (isToolBlock(block)) {
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

const EDIT_VERBS = new Set([
  'edit',
  'multiedit',
  'write',
  'write_file',
  'search_replace',
  'apply_patch',
  'notebookedit',
  'create_file',
])

const READ_VERBS = new Set(['read', 'read_file', 'glob', 'ls', 'list_dir', 'view'])

const SEARCH_VERBS = new Set(['grep', 'search', 'find', 'websearch', 'webfetch', 'web_fetch'])

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
    const name = (call.name ?? '').toLowerCase()
    if (EDIT_VERBS.has(name)) summary.edited += 1
    else if (READ_VERBS.has(name)) summary.read += 1
    else if (SEARCH_VERBS.has(name)) summary.searched += 1
    else summary.ran += 1

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
    parts.push(`Searched ×${summary.searched}`)
  return parts.join(' · ')
}
