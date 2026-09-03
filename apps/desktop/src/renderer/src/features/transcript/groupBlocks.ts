import {
  classifyToolCall,
  describeToolCall,
  effectiveToolName,
  humanizeToolName,
  parseToolArgs,
  pastVerb,
  toolSubject,
  type ToolKind,
} from './toolLabels'
import { editDiffStat, editFilePath, type EditDiffStat } from './edit-diff'
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

/**
 * Collapses each run of consecutive work blocks — tool calls, results, and the
 * reasoning between them — into one activity row per run, leaving assistant
 * prose and user bubbles as their own rows. A run is bounded only by something
 * the user said or the assistant wrote, which is the honest unit: one stretch
 * of work between two utterances renders as one row no matter how many tools
 * fired. (Chunking every N calls used to split that stretch at arbitrary
 * points, so a single burst of work read as a dozen near-identical tally
 * lines.) A run carrying any tool traffic always becomes a group, even a single
 * in-flight call, so the row does not change shape as results stream in; a lone
 * thinking block stays a plain thinking row. Group keys span first→last member
 * so they stay stable while more parts arrive. When `turnDiffs` carries an
 * entry for a settled turn, a collapsed diff card is appended after that turn's
 * final row.
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
  todos: number
  errors: number
  pending: number
}

/**
 * Human summary of a tool run: "Ran 2 commands · Edited 3 files". Pure; used
 * by the activity row and its tests. Edits count distinct files so three
 * replacements in two files read as two, not three.
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
    todos: 0,
    errors: 0,
    pending: 0,
  }
  const editedPaths = new Set<string>()
  let editedUnknown = 0
  for (const call of calls) {
    switch (classifyToolCall(call)) {
      case 'edit': {
        const parsed = parseToolArgs(call.argsJson)
        const path = parsed === null ? null : editFilePath(parsed.payload)
        if (path === null) editedUnknown++
        else editedPaths.add(path.toLowerCase())
        break
      }
      case 'read':
        summary.read += 1
        break
      case 'search':
        summary.searched += 1
        break
      case 'todo':
        summary.todos += 1
        break
      default:
        summary.ran += 1
    }

    const result = call.callId ? resultsByCallId.get(call.callId) : undefined
    if (!result) summary.pending += 1
    else if (result.isError) summary.errors += 1
  }
  summary.edited = editedPaths.size + editedUnknown
  return summary
}

/**
 * Ledger order — highest-signal bucket first, so the leftmost chip on a row is
 * the one worth reading and the same kind always sits in the same relative
 * position across rows. Shared by the tally sentence so both agree.
 */
const LEDGER_ORDER: readonly ToolKind[] = ['edit', 'run', 'search', 'read', 'todo']

function kindCount(summary: ToolActivitySummary, kind: ToolKind): number {
  switch (kind) {
    case 'edit':
      return summary.edited
    case 'run':
      return summary.ran
    case 'search':
      return summary.searched
    case 'read':
      return summary.read
    case 'todo':
      return summary.todos
  }
}

/** One bucket's count phrase: `Ran 2 commands`, `Read 1 file`. */
export function kindPhrase(kind: ToolKind, count: number): string {
  const plural = count === 1 ? '' : 's'
  switch (kind) {
    case 'edit':
      return `Edited ${count} file${plural}`
    case 'run':
      return `Ran ${count} command${plural}`
    case 'search':
      return `Searched ${count} time${plural}`
    case 'read':
      return `Read ${count} file${plural}`
    case 'todo':
      return `Updated ${count} todo${plural}`
  }
}

/** One entry per bucket that actually did something, in {@link LEDGER_ORDER}. */
export interface ActivityLedgerEntry {
  kind: ToolKind
  count: number
}

/**
 * The row's work as counted chips instead of a sentence. A row of glyph+count
 * pairs is scannable in one glance where "Ran 2 commands · Read 3 files ·
 * Updated 1 todo" has to be read word by word.
 */
export function activityLedger(summary: ToolActivitySummary): ActivityLedgerEntry[] {
  const entries: ActivityLedgerEntry[] = []
  for (const kind of LEDGER_ORDER) {
    const count = kindCount(summary, kind)
    if (count > 0) entries.push({ kind, count })
  }
  return entries
}

/** Renders the summary as a compact sentence; empty when nothing happened. */
export function formatToolSummary(summary: ToolActivitySummary): string {
  return activityLedger(summary)
    .map((entry) => kindPhrase(entry.kind, entry.count))
    .join(' · ')
}

/** The bucket a row leads with: the highest-signal kind that named something. */
function headlineSubjects(
  summary: ToolActivitySummary,
  calls: TranscriptBlock[],
): { kind: ToolKind; verb: string; subjects: string[] } {
  let fallback: ToolKind | null = null
  for (const kind of LEDGER_ORDER) {
    if (kindCount(summary, kind) === 0) continue
    if (fallback === null) fallback = kind
    const subjects = subjectsOf(calls, kind)
    if (subjects.length > 0) return { kind, verb: pastVerb(kind), subjects }
  }
  const kind = fallback ?? 'run'
  return { kind, verb: kindPhrase(kind, kindCount(summary, kind)), subjects: [] }
}

/**
 * Net size of every measurable edit in the burst. This is the number a reader
 * of a settled turn actually wants — how much code moved — and no tally of
 * nouns can express it. Null when no edit carries a diff to measure.
 */
export function burstDiffStat(calls: TranscriptBlock[]): EditDiffStat | null {
  let added = 0
  let removed = 0
  let measured = false
  for (const call of calls) {
    if (classifyToolCall(call) !== 'edit') continue
    const stat = editDiffStat(call.argsJson)
    if (stat === null) continue
    measured = true
    added += stat.added
    removed += stat.removed
  }
  return measured ? { added, removed } : null
}

/** The call still awaiting a result, newest first — what the row is doing now. */
function liveCall(
  row: Pick<ToolGroupRow, 'calls' | 'resultsByCallId'>,
): TranscriptBlock | undefined {
  for (let i = row.calls.length - 1; i >= 0; i--) {
    const call = row.calls[i]
    if (call === undefined) continue
    if (call.callId !== undefined && row.resultsByCallId.has(call.callId)) continue
    return call
  }
  return undefined
}

/** Distinct headline subjects for one bucket, in call order. */
function subjectsOf(calls: TranscriptBlock[], kind: ToolKind): string[] {
  const seen = new Set<string>()
  const subjects: string[] = []
  for (const call of calls) {
    const label = describeToolCall(call)
    if (label.kind !== kind) continue
    const subject = toolSubject(label.kind, label.target)
    if (subject.length === 0) continue
    const dedupe = subject.toLowerCase()
    if (seen.has(dedupe)) continue
    seen.add(dedupe)
    subjects.push(subject)
  }
  return subjects
}

/** Subjects a headline shows before collapsing the rest into `+N`. */
const MAX_HEADLINE_SUBJECTS = 2

/** Everything one activity row needs to render itself, derived in one pass. */
export interface ActivityHeadline {
  /** Sans-serif lead — a verb, or the whole phrase when no subject shows. */
  verb: string
  /** Monospace subjects (`groupBlocks.ts, types.ts`); may be empty. */
  subject: string
  /** Subjects the headline could not fit. */
  more: number
  /** The headline as one line, for accessible names and tooltips. */
  label: string
  working: boolean
  summary: ToolActivitySummary
  /** Buckets the headline does not already name, for the glyph ledger. */
  ledger: ActivityLedgerEntry[]
  /** Net lines the burst's edits moved, when measurable. */
  stat: EditDiffStat | null
}

/**
 * Describes one activity row: what it is doing, or what it did. While a call is
 * in flight the row names that call ("Reading tokens.css") so it doubles as the
 * live progress readout. Settled, it leads with the *subjects* of the
 * highest-signal bucket ("Edited groupBlocks.ts, types.ts +1") rather than a
 * tally of nouns — counting what happened tells you the shape of the work,
 * naming it tells you the work. The `ledger` then carries only the buckets the
 * headline left unsaid, so nothing is stated twice, and `summary` keeps the full
 * tally for the accessible sentence. A bucket whose calls expose no showable
 * argument falls back to its count phrase ("Read 6 files").
 */
export function describeActivity(
  row: Pick<ToolGroupRow, 'blocks' | 'calls' | 'resultsByCallId'>,
): ActivityHeadline {
  const summary = summarizeToolRun(row.calls, row.resultsByCallId)
  const ledger = activityLedger(summary)
  const stat = burstDiffStat(row.calls)
  const base = { more: 0, working: false, summary, ledger, stat }
  if (summary.pending > 0) {
    const call = liveCall(row)
    if (call !== undefined) {
      const { verb, target } = describeToolCall(call, true)
      if (target.length === 0) {
        const name = humanizeToolName(effectiveToolName(call.name, call.argsJson))
        return { ...base, working: true, verb: name, subject: '', label: name }
      }
      // The live row shows one target and has the width for it, so it keeps the
      // step's full path or command rather than the headline's short subject.
      return { ...base, working: true, verb, subject: target, label: `${verb} ${target}` }
    }
  }
  if (row.calls.length === 0) {
    return { ...base, verb: 'Thinking', subject: '', label: 'Thinking' }
  }
  const { kind, verb, subjects } = headlineSubjects(summary, row.calls)
  const rest = ledger.filter((entry) => entry.kind !== kind)
  if (subjects.length === 0) {
    return { ...base, ledger: rest, verb, subject: '', label: verb }
  }
  const shown = subjects.slice(0, MAX_HEADLINE_SUBJECTS)
  const more = subjects.length - shown.length
  const subject = shown.join(', ')
  return {
    ...base,
    ledger: rest,
    verb,
    subject,
    more,
    label: `${verb} ${subject}${more > 0 ? ` +${more}` : ''}`,
  }
}
