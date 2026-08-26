/** A `@path` token span within the draft text, as [start, end) offsets. */
export interface MentionRange {
  start: number
  end: number
}

/**
 * Same token shape as `active-token.ts`: a mention starts at the beginning of
 * the text or after whitespace, so mid-word `@`s (emails, decoratives) never
 * count. Finds every such token, not just the one at the caret.
 */
const MENTION_GLOBAL_RE = /(^|\s)(@[\w\\/.-]+)/g

/** All `@path` mentions in `text`, in reading order. */
export function mentionRanges(text: string): MentionRange[] {
  const ranges: MentionRange[] = []
  for (const match of text.matchAll(MENTION_GLOBAL_RE)) {
    const prefix = match[1] ?? ''
    const token = match[2] ?? ''
    if (token.length === 0) continue
    const start = (match.index ?? 0) + prefix.length
    ranges.push({ start, end: start + token.length })
  }
  return ranges
}
