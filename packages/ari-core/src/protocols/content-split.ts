import { containsDsml, trailingDsmlPrefixLen } from './dsml'

/**
 * Splits a model's content stream into user-visible text, collapsible
 * thinking, and held DSML. DeepSeek/Qwen-style `<think>…</think>` (and
 * `<thinking>`) often arrives in `delta.content`; without this, markdown
 * strips the tags and the chain-of-thought renders as the assistant reply.
 */

export type ContentEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'thinking-delta'; text: string }

const OPEN_RE = /<think(?:ing)?>/i
const CLOSE_RE = /<\/think(?:ing)?>/i
const DSML_OPEN_RE = /<\s*\|\s*DSML\s*\|/i

const OPEN_TAGS = ['<think>', '<thinking>']
const CLOSE_TAGS = ['</think>', '</thinking>']

function tagPrefixLen(text: string, tags: readonly string[]): number {
  const max = Math.min(text.length, 12)
  for (let n = max; n > 0; n--) {
    const suffix = text.slice(-n).toLowerCase()
    if (tags.some((tag) => tag.startsWith(suffix) && suffix.startsWith('<'))) return n
  }
  return 0
}

type Mode = 'text' | 'think' | 'dsml'

export class StreamContent {
  #buf = ''
  #mode: Mode = 'text'

  push(chunk: string): ContentEvent[] {
    this.#buf += chunk
    return this.#drain(false)
  }

  /**
   * Flushes leftover text/thinking. If the remainder is a DSML block, it is
   * returned separately so the caller can recover tool calls from it.
   */
  end(): { events: ContentEvent[]; dsml: string | null } {
    if (this.#mode === 'dsml' || containsDsml(this.#buf)) {
      return { events: [], dsml: this.#buf }
    }
    return { events: this.#drain(true), dsml: null }
  }

  #drain(flushAll: boolean): ContentEvent[] {
    const out: ContentEvent[] = []
    while (this.#buf.length > 0) {
      if (this.#mode === 'dsml') return out
      if (this.#mode === 'think') {
        const closeAt = this.#buf.search(CLOSE_RE)
        if (closeAt === -1) {
          this.#emitHeld(out, 'thinking-delta', flushAll, CLOSE_TAGS)
          return out
        }
        const inner = this.#buf.slice(0, closeAt)
        if (inner.length > 0) out.push({ type: 'thinking-delta', text: inner })
        const close = this.#buf.slice(closeAt).match(CLOSE_RE)
        this.#buf = this.#buf.slice(closeAt + (close?.[0].length ?? 0))
        this.#mode = 'text'
        continue
      }
      const dsmlAt = this.#buf.search(DSML_OPEN_RE)
      const thinkAt = this.#buf.search(OPEN_RE)
      const next = earliest(thinkAt, dsmlAt)
      if (next === null) {
        const keep = Math.max(tagPrefixLen(this.#buf, OPEN_TAGS), trailingDsmlPrefixLen(this.#buf))
        this.#emitHeld(out, 'text-delta', flushAll, null, keep)
        return out
      }
      const before = this.#buf.slice(0, next.at)
      if (before.length > 0) out.push({ type: 'text-delta', text: before })
      if (next.kind === 'dsml') {
        this.#buf = this.#buf.slice(next.at)
        this.#mode = 'dsml'
        return out
      }
      const rest = this.#buf.slice(next.at)
      const open = rest.match(OPEN_RE)
      this.#buf = rest.slice(open?.[0].length ?? 0)
      this.#mode = 'think'
    }
    return out
  }

  #emitHeld(
    out: ContentEvent[],
    type: ContentEvent['type'],
    flushAll: boolean,
    closeTags: readonly string[] | null,
    keepOverride?: number,
  ): void {
    if (flushAll) {
      if (this.#buf.length > 0) out.push({ type, text: this.#buf })
      this.#buf = ''
      return
    }
    const keep = keepOverride ?? tagPrefixLen(this.#buf, closeTags ?? OPEN_TAGS)
    const emit = this.#buf.slice(0, this.#buf.length - keep)
    this.#buf = this.#buf.slice(this.#buf.length - keep)
    if (emit.length > 0) out.push({ type, text: emit })
  }
}

function earliest(
  thinkAt: number,
  dsmlAt: number,
): { kind: 'think' | 'dsml'; at: number } | null {
  const think = thinkAt < 0 ? Infinity : thinkAt
  const dsml = dsmlAt < 0 ? Infinity : dsmlAt
  const at = Math.min(think, dsml)
  if (!Number.isFinite(at)) return null
  return { kind: at === think ? 'think' : 'dsml', at }
}
