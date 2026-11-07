/**
 * How a tool result should be shown. Providers store shell output as a JSON
 * string, a `{ output, exitCode }` object, or — when the bytes were
 * serialized raw — an array of character codes. Pretty-printing that array
 * is one number per line, which is what filled the terminal transcript.
 */

const SHELL_KEYS = new Set([
  'output',
  'stdout',
  'stderr',
  'text',
  'exitCode',
  'exit_code',
  'code',
  'status',
])

/** Short lists are real data (line numbers, ids). Text dumps are longer. */
const MIN_TEXT_BYTES = 16

export function presentToolResult(resultJson: string): { text: string; lang: 'json' | 'text' } {
  let value: unknown
  try {
    value = JSON.parse(resultJson) as unknown
  } catch {
    return { text: resultJson, lang: 'text' }
  }
  const text = plainToolText(value)
  if (text !== null) return { text, lang: 'text' }
  return { text: JSON.stringify(value, null, 2) ?? resultJson, lang: 'json' }
}

/**
 * The payload's own text, or null when it should stay structured JSON.
 * A JSON string is returned unquoted so bash output keeps its line breaks.
 */
export function plainToolText(value: unknown): string | null {
  const bytes = textFromBytePayload(value)
  if (bytes !== null) return bytes
  if (typeof value === 'string') return value
  return shellText(value)
}

/** UTF-8 text when `value` is a byte dump; null for lists that are not text. */
export function textFromBytePayload(value: unknown): string | null {
  const bytes = asBytes(value)
  if (bytes === null || !looksLikeTextBytes(bytes)) return null
  return new TextDecoder('utf-8', { fatal: false }).decode(Uint8Array.from(bytes))
}

function asBytes(value: unknown): number[] | null {
  if (isByteList(value)) return value
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>
    if (record['type'] === 'Buffer' && isByteList(record['data'])) return record['data']
  }
  return null
}

function isByteList(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (item) => Number.isInteger(item) && (item as number) >= 0 && (item as number) <= 255,
    )
  )
}

/**
 * Printable runs that are not sorted. A rising sequence is line numbers or
 * offsets; command output jumps around the way letters do.
 */
function looksLikeTextBytes(bytes: number[]): boolean {
  if (bytes.length < MIN_TEXT_BYTES) return false
  let ascending = 0
  for (let i = 1; i < bytes.length; i++) {
    const current = bytes[i] ?? 0
    const previous = bytes[i - 1] ?? 0
    if (current >= previous) ascending++
  }
  if (ascending / (bytes.length - 1) > 0.85) return false
  let printable = 0
  for (const byte of bytes) {
    if (byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte < 127)) printable++
  }
  return printable / bytes.length >= 0.9
}

function shellText(value: unknown): string | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
  if (keys.length === 0 || keys.some((key) => !SHELL_KEYS.has(key))) return null
  const out = textish(record['output'] ?? record['stdout'] ?? record['text'])
  const err = textish(record['stderr'])
  if (out === null && err === null) return null
  const exit = record['exitCode'] ?? record['exit_code'] ?? record['code']
  const parts: string[] = []
  if (typeof exit === 'number' && Number.isFinite(exit) && exit !== 0) parts.push(`exit ${exit}`)
  if (out !== null && out.length > 0) parts.push(out)
  if (err !== null && err.length > 0) parts.push(err)
  return parts.length > 0 ? parts.join('\n') : null
}

function textish(value: unknown): string | null {
  if (typeof value === 'string') return value
  return textFromBytePayload(value)
}
