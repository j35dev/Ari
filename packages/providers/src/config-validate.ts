/**
 * Syntax checks for the agents' config files, shared by the main process
 * (which refuses to save invalid JSON) and the settings editor (which shows
 * the problem inline before you press Save). No Node imports: the renderer
 * bundles this.
 *
 * JSON is checked with `JSON.parse`, exactly what the agents do. TOML has no
 * parser in Ari, so {@link tomlProblem} is a conservative line linter: it
 * catches the mistakes that stop an agent starting (an unquoted string, an
 * unclosed bracket or string, a broken table header, a key set twice) and
 * stays quiet on anything it does not understand. It is advisory: the editor
 * warns, the main process does not block on it.
 */

export type ConfigFormat = 'json' | 'toml' | 'markdown'

export interface ConfigProblem {
  message: string
  /** 1-based, when the parser said where. */
  line?: number
  column?: number
}

/** The problem with a config payload, or null when it parses (or the format is not checked). */
export function configProblem(format: ConfigFormat, content: string): ConfigProblem | null {
  if (format === 'json') return jsonProblem(content)
  if (format === 'toml') return tomlProblem(content)
  return null
}

/** `JSON.parse` failure with a line and column. An empty file is allowed. */
export function jsonProblem(content: string): ConfigProblem | null {
  if (content.trim().length === 0) return null
  try {
    JSON.parse(content)
    return null
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error)
    // V8 appends "in JSON at position 96 (line 7 column 3)"; the line and
    // column come back as fields, so the sentence stops before it.
    const message = raw.replace(/\s+(?:in JSON\s+)?at position \d+.*$/i, '')
    const lineColumn = /line (\d+) column (\d+)/i.exec(raw)
    if (lineColumn) {
      return { message, line: Number(lineColumn[1]), column: Number(lineColumn[2]) }
    }
    const position = /position (\d+)/i.exec(raw)
    if (position) return { message, ...lineAndColumn(content, Number(position[1])) }
    // "Unexpected end of JSON input" points past the last character.
    if (/end of (json )?input/i.test(message)) {
      return { message, ...lineAndColumn(content, content.length) }
    }
    return { message }
  }
}

function lineAndColumn(text: string, offset: number): { line: number; column: number } {
  const before = text.slice(0, offset)
  const line = before.split('\n').length
  return { line, column: offset - before.lastIndexOf('\n') }
}

const BARE_KEY = String.raw`[A-Za-z0-9_-]+`
const QUOTED_KEY = String.raw`"(?:[^"\\]|\\.)*"|'[^']*'`
const KEY_PART = `(?:${BARE_KEY}|${QUOTED_KEY})`
const DOTTED_KEY = `${KEY_PART}(?:\\s*\\.\\s*${KEY_PART})*`
const TABLE_HEADER = new RegExp(`^\\[\\s*(${DOTTED_KEY})\\s*\\]$`)
const ARRAY_HEADER = new RegExp(`^\\[\\[\\s*(${DOTTED_KEY})\\s*\\]\\]$`)
const KEY_VALUE = new RegExp(`^(${DOTTED_KEY})\\s*=\\s*(.*)$`)
const BARE_VALUE =
  /^(?:true|false|[+-]?(?:inf|nan)|[+-]?(?:0|[1-9](?:_?\d)*)(?:\.\d(?:_?\d)*)?(?:[eE][+-]?\d(?:_?\d)*)?|0x[0-9A-Fa-f](?:_?[0-9A-Fa-f])*|0o[0-7](?:_?[0-7])*|0b[01](?:_?[01])*|\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:[Zz]|[+-]\d{2}:\d{2})?)?|\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)$/

/** First TOML syntax mistake an agent would choke on, or null. */
export function tomlProblem(content: string): ConfigProblem | null {
  const lines = content.replace(/\r\n?/g, '\n').split('\n')
  /** Open `"""` / `'''` string carried across lines, and where it started. */
  let multiline: { quote: string; line: number } | null = null
  /** Open brackets of a value that spans lines. */
  let depth = 0
  let depthStart = 0
  let table = ''
  const tables = new Set<string>()
  const keys = new Set<string>()

  for (let index = 0; index < lines.length; index++) {
    const lineNo = index + 1
    let text = lines[index] ?? ''
    if (multiline) {
      const close = text.indexOf(multiline.quote)
      if (close === -1) continue
      text = text.slice(close + 3)
      multiline = null
      const scanned = scanValue(text, lineNo)
      if ('problem' in scanned) return scanned.problem
      depth += scanned.depth
      if (scanned.multiline) multiline = { quote: scanned.multiline, line: lineNo }
      continue
    }
    if (depth > 0) {
      const scanned = scanValue(text, lineNo)
      if ('problem' in scanned) return scanned.problem
      depth += scanned.depth
      if (depth < 0) return { message: 'Unexpected closing bracket', line: lineNo }
      if (scanned.multiline) multiline = { quote: scanned.multiline, line: lineNo }
      continue
    }

    const trimmed = stripComment(text).trim()
    if (trimmed.length === 0) continue

    if (trimmed.startsWith('[')) {
      const array = ARRAY_HEADER.exec(trimmed)
      const header = array ?? TABLE_HEADER.exec(trimmed)
      if (!header?.[1]) return { message: `Malformed table header ${trimmed}`, line: lineNo }
      const name = normalizeKey(header[1])
      if (!array) {
        if (tables.has(name)) return { message: `Table [${name}] is defined twice`, line: lineNo }
        tables.add(name)
      }
      table = name
      if (array) {
        // A new [[array]] entry starts fresh: its keys and sub-tables may repeat.
        for (const key of [...keys]) {
          if (key.startsWith(`${name}\u0000`) || key.startsWith(`${name}.`)) keys.delete(key)
        }
        for (const sub of [...tables]) if (sub.startsWith(`${name}.`)) tables.delete(sub)
      }
      continue
    }

    const pair = KEY_VALUE.exec(trimmed)
    if (!pair?.[1]) {
      return { message: 'Expected key = value', line: lineNo, column: firstColumn(text) }
    }
    const key = `${table}\u0000${normalizeKey(pair[1])}`
    if (keys.has(key)) {
      return { message: `${normalizeKey(pair[1])} is set twice`, line: lineNo }
    }
    keys.add(key)
    const value = (pair[2] ?? '').trim()
    if (value.length === 0) return { message: `${pair[1]} has no value`, line: lineNo }
    if (!/^["'[{]/.test(value) && !BARE_VALUE.test(value)) {
      return {
        message: `${normalizeKey(pair[1])}: text values need quotes, like "${value}"`,
        line: lineNo,
      }
    }
    const scanned = scanValue(value, lineNo)
    if ('problem' in scanned) return scanned.problem
    depth = scanned.depth
    depthStart = lineNo
    if (depth < 0) return { message: 'Unexpected closing bracket', line: lineNo }
    if (scanned.multiline) multiline = { quote: scanned.multiline, line: lineNo }
  }
  if (multiline) return { message: 'Unterminated multi-line string', line: multiline.line }
  if (depth > 0) return { message: 'Unclosed [ or {', line: depthStart }
  return null
}

/**
 * Walks a value fragment: bracket balance, and strings that must close on
 * their line. Reports a `"""`/`'''` string left open for the next lines.
 */
function scanValue(
  text: string,
  line: number,
): { depth: number; multiline?: string } | { problem: ConfigProblem } {
  let depth = 0
  for (let index = 0; index < text.length; index++) {
    const ch = text[index]
    if (ch === '#') break
    if (ch === '"' || ch === "'") {
      const triple = text.startsWith(ch.repeat(3), index)
      if (triple) {
        const close = text.indexOf(ch.repeat(3), index + 3)
        if (close === -1) return { depth, multiline: ch.repeat(3) }
        index = close + 2
        continue
      }
      let end = index + 1
      while (end < text.length && text[end] !== ch) end += ch === '"' && text[end] === '\\' ? 2 : 1
      if (end >= text.length) {
        return { problem: { message: 'Unterminated string', line, column: index + 1 } }
      }
      index = end
      continue
    }
    if (ch === '[' || ch === '{') depth++
    if (ch === ']' || ch === '}') depth--
  }
  return { depth }
}

/** The line without a trailing `# comment` (a `#` inside a string stays). */
function stripComment(text: string): string {
  let quote: string | null = null
  for (let index = 0; index < text.length; index++) {
    const ch = text[index]
    if (quote) {
      if (ch === '\\' && quote === '"') index++
      else if (ch === quote) quote = null
    } else if (ch === '"' || ch === "'") quote = ch
    else if (ch === '#') return text.slice(0, index)
  }
  return text
}

function normalizeKey(key: string): string {
  return key
    .split('.')
    .map((part) => part.trim().replace(/^["']|["']$/g, ''))
    .join('.')
}

function firstColumn(text: string): number {
  return (/^\s*/.exec(text)?.[0].length ?? 0) + 1
}
