import type { ToolKind } from './toolLabels'

/** Keys providers use for the readable body of a result, most specific first. */
const TEXT_KEYS = ['output', 'stdout', 'content', 'text', 'result', 'body'] as const
const ERROR_KEYS = ['error', 'message', 'stderr', 'detail'] as const
const EXIT_KEYS = ['exitCode', 'exit_code', 'status'] as const
const LIST_KEYS = ['matches', 'results', 'files', 'entries'] as const

const MAX_HINT_CHARS = 34

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** ACP-style content blocks — `[{ type: 'text', text }, …]` — joined to text. */
function blocksText(value: unknown): string | null {
  if (!Array.isArray(value)) return null
  const parts: string[] = []
  for (const entry of value) {
    const record = asRecord(entry)
    const text = record?.['text']
    if (typeof text === 'string') parts.push(text)
  }
  return parts.length > 0 ? parts.join('\n') : null
}

/** The readable body of a result across provider shapes; '' when there is none. */
function resultText(value: unknown): string {
  if (typeof value === 'string') return value
  const blocks = blocksText(value)
  if (blocks !== null) return blocks
  const record = asRecord(value)
  if (record === null) return ''
  for (const key of TEXT_KEYS) {
    const nested = record[key]
    if (typeof nested === 'string') return nested
    const nestedBlocks = blocksText(nested)
    if (nestedBlocks !== null) return nestedBlocks
  }
  return ''
}

function firstString(record: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim().length > 0) return value
  }
  return null
}

function listLength(value: unknown): number | null {
  const record = asRecord(value)
  if (record === null) return Array.isArray(value) ? value.length : null
  for (const key of LIST_KEYS) {
    const list = record[key]
    if (Array.isArray(list)) return list.length
  }
  return null
}

function exitCode(value: unknown): number | null {
  const record = asRecord(value)
  if (record === null) return null
  for (const key of EXIT_KEYS) {
    const code = record[key]
    if (typeof code === 'number' && Number.isFinite(code)) return code
  }
  return null
}

/** Non-empty lines — the honest count of what a body actually carries. */
function lineCount(text: string): number {
  let lines = 0
  for (const line of text.split('\n')) if (line.trim().length > 0) lines++
  return lines
}

function clip(value: string): string {
  const flat = value.replace(/\s+/g, ' ').trim()
  return flat.length > MAX_HINT_CHARS ? `${flat.slice(0, MAX_HINT_CHARS - 1)}…` : flat
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`
}

/**
 * One-glance readout of what a tool answered, so a settled step says something
 * without being opened: `exit 1`, `84 lines`, `12 matches`, or a failure's own
 * first line. Providers disagree wildly on result shape — bare strings, ACP
 * content blocks, `{ output, exitCode }`, `{ matches: [] }` — so the body is
 * flattened before it is counted. Returns null when nothing truthful can be
 * said: edits advertise their diffstat instead, and plans have no useful
 * answer. Never invents a number the payload does not support.
 */
export function resultHint(
  kind: ToolKind,
  resultJson: string | undefined,
  isError = false,
): string | null {
  if (resultJson === undefined || resultJson.length === 0) return null
  let parsed: unknown = resultJson
  try {
    parsed = JSON.parse(resultJson) as unknown
  } catch {
    // A raw, unparseable payload is text as it stands.
  }
  const text = resultText(parsed)
  if (isError) {
    const record = asRecord(parsed)
    const message = record === null ? null : firstString(record, ERROR_KEYS)
    const body = message ?? text
    return body.trim().length > 0 ? clip(body) : 'failed'
  }
  if (kind === 'edit' || kind === 'todo') return null
  const code = exitCode(parsed)
  if (code !== null && code !== 0) return `exit ${code}`
  if (kind === 'search') {
    const length = listLength(parsed)
    if (length !== null) return plural(length, 'match', 'matches')
    const lines = lineCount(text)
    return lines > 0 ? plural(lines, 'match', 'matches') : 'no matches'
  }
  const length = listLength(parsed)
  if (length !== null) return plural(length, 'entry', 'entries')
  const lines = lineCount(text)
  if (lines > 0) return plural(lines, 'line', 'lines')
  return kind === 'run' ? 'no output' : null
}
