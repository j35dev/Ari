/**
 * Pure JSONL codec used by the event journal. File I/O lives in the engine;
 * this module stays importable from any process.
 */

export function encodeJsonLine(value: unknown): string {
  return JSON.stringify(value)
}

export type ParsedLine<T> =
  | { kind: 'value'; line: number; value: T }
  | { kind: 'error'; line: number; message: string }

/**
 * Parses newline-delimited JSON, tolerating a truncated final line (crash
 * during append). Each line is reported independently so callers can recover.
 */
export function parseJsonLines<T = unknown>(input: string): ParsedLine<T>[] {
  const lines = input.split('\n')
  const out: ParsedLine<T>[] = []
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    if (raw === undefined) break
    const trimmed = raw.trim()
    if (trimmed.length === 0) continue
    try {
      out.push({ kind: 'value', line: i + 1, value: JSON.parse(trimmed) as T })
    } catch (e) {
      out.push({
        kind: 'error',
        line: i + 1,
        message: e instanceof Error ? e.message : String(e),
      })
    }
  }
  return out
}
