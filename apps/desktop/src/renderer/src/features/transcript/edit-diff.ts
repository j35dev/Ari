import { parseToolArgs, stringArg } from './toolLabels'

const OLD_KEYS = [
  'oldText',
  'oldString',
  'old_string',
  'old_str',
  'old_text',
  'original',
] as const
const NEW_KEYS = [
  'newText',
  'newString',
  'new_string',
  'new_str',
  'new_text',
  'replacement',
  'content',
  'file_text',
] as const
const PATH_KEYS = ['file_path', 'filePath', 'target_file', 'notebook_path', 'path'] as const

/** Synthetic diffs above this size fall back to Before/After panels. */
const MAX_DIFF_CHARS = 20000

export interface EditDiff {
  /** Workspace-relative display path carried as the diff's file header. */
  path: string
  /** Unified diff text shaped for the shared DiffViewer. */
  diffText: string
}

interface EditPair {
  oldText: string | null
  newText: string | null
}

function pairFrom(record: Record<string, unknown>): EditPair | null {
  const oldText = stringArg(record, OLD_KEYS)
  const newText = stringArg(record, NEW_KEYS)
  if (oldText === null && newText === null) return null
  return { oldText, newText }
}

function pairsFrom(payload: Record<string, unknown>): EditPair[] | null {
  const raw = payload['edits']
  if (Array.isArray(raw)) {
    const pairs: EditPair[] = []
    for (const entry of raw) {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
      const pair = pairFrom(entry as Record<string, unknown>)
      if (pair !== null) pairs.push(pair)
    }
    return pairs.length > 0 ? pairs : null
  }
  const single = pairFrom(payload)
  return single === null ? null : [single]
}

function splitLines(text: string): string[] {
  if (text.length === 0) return []
  return text.replace(/\r\n/g, '\n').split('\n')
}

/**
 * Shapes an edit tool payload as a unified diff for the shared DiffViewer.
 * Covers single old/new replacements, Ari Core `edits[]` batches, and
 * content-only writes (rendered as a new-file diff). Returns null when the
 * payload carries no edit text or the synthesized diff would flood the card.
 */
export function editPayloadToDiff(payload: Record<string, unknown>): EditDiff | null {
  const pairs = pairsFrom(payload)
  if (pairs === null) return null
  const total = pairs.reduce(
    (sum, p) => sum + (p.oldText?.length ?? 0) + (p.newText?.length ?? 0),
    0,
  )
  if (total > MAX_DIFF_CHARS) return null
  const path = stringArg(payload, PATH_KEYS) ?? 'file'
  const lines: string[] = [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
  ]
  let oldStart = 1
  let newStart = 1
  for (const pair of pairs) {
    const oldLines = pair.oldText === null ? null : splitLines(pair.oldText)
    const newLines = pair.newText === null ? null : splitLines(pair.newText)
    const oldCount = oldLines?.length ?? 0
    const newCount = newLines?.length ?? 0
    if (oldCount === 0 && newCount === 0) continue
    lines.push(`@@ -${oldCount === 0 ? 0 : oldStart},${oldCount} +${newCount === 0 ? 0 : newStart},${newCount} @@`)
    for (const line of oldLines ?? []) lines.push(`-${line}`)
    for (const line of newLines ?? []) lines.push(`+${line}`)
    oldStart += oldCount
    newStart += newCount
  }
  if (lines.length <= 3) return null
  return { path, diffText: lines.join('\n') + '\n' }
}

/**
 * Synthesizes a DiffViewer-ready diff from a tool call's raw `argsJson`.
 * Unwraps ACP-style `{ title, input }` envelopes; diff/patch-shaped payloads
 * are the caller's job and read as null here.
 */
export function editArgsToDiff(argsJson: string | undefined): EditDiff | null {
  const parsed = parseToolArgs(argsJson)
  if (parsed === null) return null
  return editPayloadToDiff(parsed.payload)
}

export interface EditDiffStat {
  added: number
  removed: number
}

/**
 * Counts added/removed lines in a call's synthesized diff so step rows can
 * advertise size (`+2 −3`) without opening. Null when no diff synthesizes.
 */
export function editDiffStat(argsJson: string | undefined): EditDiffStat | null {
  const diff = editArgsToDiff(argsJson)
  if (diff === null) return null
  let added = 0
  let removed = 0
  for (const line of diff.diffText.split('\n')) {
    if (
      line.startsWith('diff --git ') ||
      line.startsWith('--- ') ||
      line.startsWith('+++ ') ||
      line.startsWith('@@')
    ) {
      continue
    }
    if (line.startsWith('+')) added++
    else if (line.startsWith('-')) removed++
  }
  return { added, removed }
}

/** File path carried by an edit payload, if any. */
export function editFilePath(payload: Record<string, unknown>): string | null {
  return stringArg(payload, PATH_KEYS)
}
