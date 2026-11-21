/** Kind of inline token the composer popup machinery reacts to. */
export type ActiveTokenKind = 'mention' | 'command'

/** The `@path` or leading `/command` fragment being typed at the caret. */
export interface ActiveToken {
  kind: ActiveTokenKind
  /** Raw token text including the leading `@` or `/`. */
  raw: string
  /** Index of the leading character within the full text. */
  start: number
}

const MENTION_TOKEN_RE = /(?:^|\s)(@[\w\\/.-]*)$/
/**
 * A slash command is only a command at the very start of the draft, and only
 * while its name is being typed: the first space ends it, except after `ari`,
 * whose own command is the two words `ari theme`.
 */
const COMMAND_TOKEN_RE = /^\/(?:ari )?\$?[\w:.@-]*$/i

/**
 * Extract the token being typed at `caret` in `text`, or null when the caret
 * does not sit at the end of a ` @partial` fragment or of a leading
 * `/partial`. A mention must start at the beginning of the text or after
 * whitespace, so mid-word `@`s never trigger a popup.
 */
export function activeTokenAt(text: string, caret: number): ActiveToken | null {
  const before = text.slice(0, Math.max(0, Math.min(caret, text.length)))
  if (COMMAND_TOKEN_RE.test(before)) return { kind: 'command', raw: before, start: 0 }
  const mention = MENTION_TOKEN_RE.exec(before)
  if (mention?.[1]) {
    return { kind: 'mention', raw: mention[1], start: before.length - mention[1].length }
  }
  return null
}
