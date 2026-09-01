import type { TranscriptBlock } from './types'

/** Coarse bucket a tool falls into; drives both verbs and summary counters. */
export type ToolKind = 'run' | 'edit' | 'read' | 'search'

const EDIT_TOOLS = new Set([
  'edit',
  'multiedit',
  'write',
  'write_file',
  'search_replace',
  'apply_patch',
  'notebookedit',
  'create_file',
  'str_replace_editor',
])

const READ_TOOLS = new Set([
  'read',
  'read_file',
  'glob',
  'ls',
  'list_dir',
  'view',
  'read_many_files',
])
const SEARCH_TOOLS = new Set([
  'grep',
  'search',
  'find',
  'websearch',
  'webfetch',
  'web_fetch',
  'web_search',
  'codebase_search',
])

/** Substring probes for provider-specific names the exact sets miss. */
const FUZZY_KIND: ReadonlyArray<readonly [RegExp, ToolKind]> = [
  [/write|edit|patch|replace|create|insert|delete|move|rename/, 'edit'],
  [/read|list|glob|view|cat|open/, 'read'],
  [/search|grep|find|fetch|lookup/, 'search'],
]

/** Buckets a raw tool name; anything unrecognised counts as a command run. */
export function classifyTool(name: string | undefined): ToolKind {
  const key = (name ?? '').toLowerCase()
  if (EDIT_TOOLS.has(key)) return 'edit'
  if (READ_TOOLS.has(key)) return 'read'
  if (SEARCH_TOOLS.has(key)) return 'search'
  if (key.includes('command') || key.includes('terminal') || key.includes('shell')) return 'run'
  for (const [probe, kind] of FUZZY_KIND) {
    if (probe.test(key)) return kind
  }
  return 'run'
}

/** User-facing Ari identity per bucket — the transcript brands every step as an Ari tool. */
const ARI_TOOL_NAME: Record<ToolKind, string> = {
  run: 'Ari Run',
  edit: 'Ari Edit',
  read: 'Ari Read',
  search: 'Ari Search',
}

/** Brand name for a bucket ("Ari Run"); pairs with {@link classifyTool}. */
export function ariToolName(kind: ToolKind): string {
  return ARI_TOOL_NAME[kind]
}

/** Past-tense verb for a settled step ("Read src/app.ts"). */
const PAST_VERB: Record<ToolKind, string> = {
  run: 'Ran',
  edit: 'Edited',
  read: 'Read',
  search: 'Searched',
}

/** Present-participle verb for the in-flight step ("Reading src/app.ts"). */
const LIVE_VERB: Record<ToolKind, string> = {
  run: 'Running',
  edit: 'Editing',
  read: 'Reading',
  search: 'Searching',
}

/**
 * Argument keys worth showing, most specific first. Providers disagree on
 * naming (`file_path` vs `target_file` vs `path`), so the first hit wins.
 */
const TARGET_KEYS = [
  'command',
  'cmd',
  'script',
  'file_path',
  'filePath',
  'target_file',
  'targetFile',
  'notebook_path',
  'absolute_path',
  'target_directory',
  'path',
  'pattern',
  'query',
  'url',
  'prompt',
] as const

const MAX_TARGET_CHARS = 96

/** Collapses whitespace and caps length so a target always fits one line. */
function oneLine(value: string): string {
  const flat = value.replace(/\s+/g, ' ').trim()
  return flat.length > MAX_TARGET_CHARS ? `${flat.slice(0, MAX_TARGET_CHARS - 1)}…` : flat
}

/**
 * Shortens a filesystem path to its last two segments so steps read
 * `transcript/toolLabels.ts` instead of an absolute Windows path.
 */
export function shortenPath(value: string): string {
  const segments = value.split(/[\\/]+/).filter((s) => s.length > 0)
  if (segments.length <= 2) return segments.join('/')
  return segments.slice(-2).join('/')
}

function isPathKey(key: string): boolean {
  return /path|file|directory/i.test(key)
}

/**
 * Wrapper keys under which providers nest the real arguments. The ACP bridge
 * ships `{ title, input: { command } }`, so the useful payload is a level down.
 */
const NESTED_ARG_KEYS = ['input', 'arguments', 'args', 'parameters', 'params'] as const

/** Keys that describe the call rather than its subject; never shown as target. */
const NON_TARGET_KEYS = new Set([
  'title',
  'name',
  'tool',
  'tool_name',
  'toolName',
  'description',
  'explanation',
  'id',
  'callid',
  'kind',
])

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** The argument records to search, outermost first, then nested wrappers. */
function argRecords(args: Record<string, unknown>): Record<string, unknown>[] {
  const records = [args]
  for (const key of NESTED_ARG_KEYS) {
    const nested = asRecord(args[key])
    if (nested !== null) records.push(nested)
  }
  return records
}

function parseArgs(argsJson: string | undefined): unknown {
  if (argsJson === undefined || argsJson.length === 0) return undefined
  try {
    return JSON.parse(argsJson) as unknown
  } catch {
    return argsJson
  }
}

/** A parsed call's arguments: the outer record plus the unwrapped payload. */
export interface ParsedToolArgs {
  /** Outermost args record, exactly as the provider sent it. */
  args: Record<string, unknown>
  /** Innermost payload record after unwrapping ACP-style envelopes. */
  payload: Record<string, unknown>
}

/**
 * Parses a call's `argsJson` into records for structured views. Returns null
 * when the payload is missing or not an object; ACP-style `{ title, input }`
 * envelopes expose their `input` as the payload.
 */
export function parseToolArgs(argsJson: string | undefined): ParsedToolArgs | null {
  const args = asRecord(parseArgs(argsJson))
  if (args === null) return null
  for (const key of NESTED_ARG_KEYS) {
    const nested = asRecord(args[key])
    if (nested !== null) return { args, payload: nested }
  }
  return { args, payload: args }
}

/** First non-empty string among `keys`, or null when none is present. */
export function stringArg(
  record: Record<string, unknown>,
  keys: readonly string[],
): string | null {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return null
}

/** Extracts the most meaningful single-line argument preview from a call. */
export function toolTarget(argsJson: string | undefined): string {
  const parsed = parseArgs(argsJson)
  if (parsed === undefined) return ''
  if (typeof parsed === 'string') return oneLine(parsed)
  const args = asRecord(parsed)
  if (args === null) return ''
  const records = argRecords(args)
  for (const record of records) {
    for (const key of TARGET_KEYS) {
      const value = record[key]
      if (typeof value !== 'string' || value.length === 0) continue
      return oneLine(isPathKey(key) ? shortenPath(value) : value)
    }
  }
  for (const record of records) {
    const first = Object.entries(record).find(
      ([key, value]) =>
        typeof value === 'string' && value.length > 0 && !NON_TARGET_KEYS.has(key.toLowerCase()),
    )
    if (first !== undefined) return oneLine(String(first[1]))
  }
  return ''
}

/** Names carrying no information; the args' own title is a better label. */
const GENERIC_NAMES = new Set(['tool', 'other', 'unknown', 'function', ''])

/**
 * Best available tool name. The ACP bridge falls back to the literal `tool`
 * when a request carries no `rawInput.name` or `kind`, in which case the
 * request title (`run_terminal_command`) is the only real identifier.
 */
export function effectiveToolName(
  name: string | undefined,
  argsJson: string | undefined,
): string {
  const given = (name ?? '').trim()
  if (!GENERIC_NAMES.has(given.toLowerCase())) return given
  const args = asRecord(parseArgs(argsJson))
  if (args === null) return given
  for (const key of ['title', 'name', 'tool_name', 'tool'] as const) {
    const value = args[key]
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  return given
}

export interface ToolStepLabel {
  kind: ToolKind
  /** Leading verb, tensed for the step's state. */
  verb: string
  /** Path, command, or query the step acted on; may be empty. */
  target: string
}

/** Bucket for a whole call block, resolving generic provider names first. */
export function classifyToolCall(block: Pick<TranscriptBlock, 'name' | 'argsJson'>): ToolKind {
  return classifyTool(effectiveToolName(block.name, block.argsJson))
}

/**
 * One-line description of a tool call. `live` picks the present participle so
 * the in-flight header reads "Reading tokens.css" while history reads "Read
 * tokens.css".
 */
export function describeToolCall(
  block: Pick<TranscriptBlock, 'name' | 'argsJson'>,
  live = false,
): ToolStepLabel {
  const name = effectiveToolName(block.name, block.argsJson)
  const kind = classifyTool(name)
  const target = toolTarget(block.argsJson)
  return {
    kind,
    verb: live ? LIVE_VERB[kind] : PAST_VERB[kind],
    target: target.length > 0 ? target : name,
  }
}

const MAX_THOUGHT_CHARS = 120

/**
 * First meaningful line of a reasoning block, capped for a collapsed row.
 * Markdown emphasis and heading markers are stripped so the preview reads as
 * prose rather than raw syntax.
 */
export function thoughtPreview(text: string): string {
  const line = text
    .split('\n')
    .map((l) => l.replace(/^\s*[#>*\-\s]+/, '').trim())
    .find((l) => l.length > 0)
  if (line === undefined) return 'Thinking'
  const clean = line.replace(/[*_`]/g, '')
  return clean.length > MAX_THOUGHT_CHARS ? `${clean.slice(0, MAX_THOUGHT_CHARS - 1)}…` : clean
}
