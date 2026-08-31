/**
 * Shared output-truncation limits for tool results, modeled on the caps used
 * by production coding harnesses: whichever limit is hit first wins, and
 * partial lines are never returned (except the bash tail edge case).
 */

/** Maximum lines returned by any single tool result. */
export const MAX_LINES = 2000
/** Maximum UTF-8 bytes returned by any single tool result. */
export const MAX_BYTES = 50 * 1024
/** Maximum characters kept per grep match line. */
export const GREP_MAX_LINE_CHARS = 240

function splitLines(content: string): string[] {
  if (content.length === 0) return []
  const lines = content.split('\n')
  if (content.endsWith('\n')) lines.pop()
  return lines
}

export interface HeadTruncation {
  content: string
  truncated: boolean
  /** Total lines in the untruncated content. */
  totalLines: number
  /** Lines present in `content`. */
  outputLines: number
  /** 1-indexed last line shown; 0 when nothing was shown. */
  lastLine: number
}

/**
 * Keeps the first `maxLines` lines / `maxBytes` bytes of `content`,
 * whichever is hit first. Suitable for file reads where the beginning is
 * what matters.
 */
export function truncateHead(content: string, maxLines = MAX_LINES, maxBytes = MAX_BYTES): HeadTruncation {
  const lines = splitLines(content)
  const totalLines = lines.length
  if (totalLines <= maxLines && Buffer.byteLength(content, 'utf8') <= maxBytes) {
    return { content, truncated: false, totalLines, outputLines: totalLines, lastLine: totalLines }
  }
  const kept: string[] = []
  let bytes = 0
  for (let i = 0; i < lines.length && i < maxLines; i++) {
    const line = lines[i] ?? ''
    const lineBytes = Buffer.byteLength(line, 'utf8') + (kept.length > 0 ? 1 : 0)
    if (bytes + lineBytes > maxBytes) break
    kept.push(line)
    bytes += lineBytes
  }
  return {
    content: kept.join('\n'),
    truncated: true,
    totalLines,
    outputLines: kept.length,
    lastLine: kept.length,
  }
}

export interface TailTruncation {
  content: string
  truncated: boolean
  totalLines: number
  /** 1-indexed first line shown; 1 when untruncated. */
  firstLine: number
}

/**
 * Keeps the last `maxLines` lines / `maxBytes` bytes of `content`, whichever
 * is hit first. Suitable for command output where errors live at the end.
 * Unlike {@link truncateHead} it may keep a partial line when one line alone
 * exceeds the byte budget.
 */
export function truncateTail(content: string, maxLines = MAX_LINES, maxBytes = MAX_BYTES): TailTruncation {
  const lines = splitLines(content)
  const totalLines = lines.length
  if (totalLines <= maxLines && Buffer.byteLength(content, 'utf8') <= maxBytes) {
    return { content, truncated: false, totalLines, firstLine: 1 }
  }
  const kept: string[] = []
  let bytes = 0
  for (let i = lines.length - 1; i >= 0 && kept.length < maxLines; i--) {
    const line = lines[i] ?? ''
    const lineBytes = Buffer.byteLength(line, 'utf8') + (kept.length > 0 ? 1 : 0)
    if (bytes + lineBytes > maxBytes) break
    kept.unshift(line)
    bytes += lineBytes
  }
  if (kept.length === 0) {
    // One line exceeds the whole budget: keep its tail, UTF-8-safe.
    const last = lines[totalLines - 1] ?? ''
    const buf = Buffer.from(last, 'utf8')
    let start = buf.length - maxBytes
    while (start < buf.length && (buf[start] ?? 0) & 0x80) start++
    kept.push(buf.subarray(start).toString('utf8'))
  }
  return {
    content: kept.join('\n'),
    truncated: true,
    totalLines,
    firstLine: totalLines - kept.length + 1,
  }
}
