/**
 * Recovers tool calls that models dump as xAI DSML markup in the assistant
 * text instead of native `tool_calls`. Grok (and some OpenAI-compat proxies
 * in front of it) do this when the request advertised no tools, and sometimes
 * even when it did.
 *
 * Real on the wire: `<|DSML|invoke name="read">…`. Markdown renderers split
 * on `|`, which is why the transcript can look like `< | DSML | invoke>`.
 * Both forms parse.
 */

export interface DsmlToolCall {
  name: string
  args: Record<string, unknown>
}

const INVOKE_RE =
  /<\s*\|\s*DSML\s*\|\s*(?:tool_)?invoke\s+name="([^"]+)"\s*>([\s\S]*?)<\/\s*\|\s*DSML\s*\|\s*(?:tool_)?invoke\s*>/gi

const PARAM_RE =
  /<\s*\|\s*DSML\s*\|\s*parameter\s+name="([^"]+)"([^>]*)>([\s\S]*?)<\/\s*\|\s*DSML\s*\|\s*parameter\s*>/gi

/** Parameter names models invent when they have not seen the JSON schema. */
const ARG_ALIASES: Record<string, string> = {
  file: 'path',
  filepath: 'path',
  filename: 'path',
  cmd: 'command',
  query: 'pattern',
}

/** True when `text` contains a DSML tool-call block (with or without spaces). */
export function containsDsml(text: string): boolean {
  return /<\s*\|\s*DSML\s*\|/i.test(text)
}

function canonicalArgName(name: string): string {
  return ARG_ALIASES[name] ?? name
}

function coerceParam(value: string, attrs: string): unknown {
  const trimmed = value.trim()
  if (/\bnumber="true"/.test(attrs) || /\btype="number"/.test(attrs)) {
    const n = Number(trimmed)
    return Number.isFinite(n) ? n : trimmed
  }
  if (/\bboolean="true"/.test(attrs) || /\btype="boolean"/.test(attrs)) {
    if (trimmed === 'true') return true
    if (trimmed === 'false') return false
  }
  if (
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'))
  ) {
    try {
      return JSON.parse(trimmed) as unknown
    } catch {
      // keep the raw string
    }
  }
  return value
}

/**
 * Extracts every DSML invoke in `text`. Returns [] when none parse, so the
 * caller can treat the text as ordinary assistant content.
 */
export function parseDsmlToolCalls(text: string): DsmlToolCall[] {
  const calls: DsmlToolCall[] = []
  INVOKE_RE.lastIndex = 0
  for (const match of text.matchAll(INVOKE_RE)) {
    const name = match[1]
    const body = match[2]
    if (name === undefined || body === undefined || name === '') continue
    const args: Record<string, unknown> = {}
    PARAM_RE.lastIndex = 0
    for (const param of body.matchAll(PARAM_RE)) {
      const rawName = param[1]
      const attrs = param[2] ?? ''
      const rawValue = param[3]
      if (rawName === undefined || rawValue === undefined) continue
      const key = canonicalArgName(rawName)
      if (key in args) continue
      args[key] = coerceParam(rawValue, attrs)
    }
    calls.push({ name, args })
  }
  return calls
}
