/** Kind of inline token the composer popup machinery reacts to. */
export type ActiveTokenKind = 'slash' | 'mention'

/** The `/command` or `@path` fragment being typed at the caret. */
export interface ActiveToken {
  kind: ActiveTokenKind
  /** Raw token text including the leading `/` or `@`. */
  raw: string
  /** Index of the leading character within the full text. */
  start: number
}

const SLASH_TOKEN_RE = /(?:^|\s)(\/[a-z]*)$/
const MENTION_TOKEN_RE = /(?:^|\s)(@[\w\\/.-]*)$/

/**
 * Extract the token being typed at `caret` in `text`, or null when the caret
 * does not sit at the end of a ` /partial` or ` @partial` fragment. A token
 * must start at the beginning of the text or after whitespace, so `abc/` and
 * mid-word `@`s never trigger a popup.
 */
export function activeTokenAt(text: string, caret: number): ActiveToken | null {
  const before = text.slice(0, Math.max(0, Math.min(caret, text.length)))
  const slash = SLASH_TOKEN_RE.exec(before)
  if (slash?.[1]) {
    return { kind: 'slash', raw: slash[1], start: before.length - slash[1].length }
  }
  const mention = MENTION_TOKEN_RE.exec(before)
  if (mention?.[1]) {
    return { kind: 'mention', raw: mention[1], start: before.length - mention[1].length }
  }
  return null
}
