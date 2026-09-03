import type { ChatMessage } from './protocols/openai-chat'

/**
 * Context-window manager for the Ari Core harness. Pure functions only:
 * given the accumulated message list, produce a trimmed copy that keeps
 * the conversation valid for every protocol flavor.
 */

/** Placeholder substituted for runs of dropped tool-result messages. */
export const TRIMMED_TOOL_RESULTS_PLACEHOLDER = '[earlier tool results trimmed]'

/**
 * Characters per token assumed when converting a model's token context window
 * into the character budget these functions work in. Four is the usual figure
 * for English source code across mainstream tokenizers.
 */
export const CHARS_PER_TOKEN = 4

/**
 * Default assumed context window, in tokens, for a custom endpoint whose real
 * window Ari does not know. Ari Core only — CLI-backed providers manage their
 * own context and never consult this.
 */
export const DEFAULT_CONTEXT_WINDOW_TOKENS = 500_000

/**
 * Soft context budget (in content characters) applied before each model round,
 * derived from {@link DEFAULT_CONTEXT_WINDOW_TOKENS}.
 *
 * It is deliberately generous: the budget is a backstop against a runaway
 * session, not a target. Set too low it compacts constantly, and each
 * compaction costs an extra model call and drops the file contents the model is
 * working from, which reads as a slow agent that keeps re-reading instead of
 * editing. The trade at this size is that a model with a smaller real window
 * will hit its own limit before this budget engages.
 */
export const CONTEXT_WINDOW_CHARS = DEFAULT_CONTEXT_WINDOW_TOKENS * CHARS_PER_TOKEN

/**
 * Fraction of the budget that must be in use before compaction is worth a
 * model call. Below it, trimming alone is cheaper and loses nothing that
 * matters yet.
 */
export const COMPACTION_TRIGGER_RATIO = 0.75

/**
 * Share of the context budget kept verbatim through a compaction, so the work
 * in progress survives in full detail and only older spans are summarized. It
 * scales with the budget rather than being a fixed size: a harness configured
 * with a small window would otherwise never find anything old enough to
 * summarize.
 */
export const KEEP_RECENT_RATIO = 0.35

/** Keep window for the default budget, and the default for {@link splitForCompaction}. */
export const KEEP_RECENT_CHARS = Math.floor(CONTEXT_WINDOW_CHARS * KEEP_RECENT_RATIO)

/** Marks a message holding a compaction summary rather than real history. */
export const SUMMARY_PREFIX = '[summary of earlier conversation]'

/** The structured shape a compaction summary is asked to take. */
export const SUMMARY_INSTRUCTIONS = `Summarize the conversation so far so another engineer can continue the work with no other context. Use exactly this structure, omitting sections that have no content:

## Goal
[what the user is trying to accomplish]

## Constraints & Preferences
- [requirements the user stated]

## Progress
### Done
- [completed work]
### In Progress
- [current work]
### Blocked
- [blockers, if any]

## Key Decisions
- **[decision]**: [rationale]

## Next Steps
1. [what should happen next]

## Critical Context
- [file paths, identifiers, values, and command output needed to continue]

Be specific: name files and symbols rather than describing them. Do not invent progress that did not happen.`

function sizeOf(messages: ChatMessage[]): number {
  return messages.reduce((sum, m) => sum + m.content.length, 0)
}

/**
 * Groups messages into atomic units so assistant tool calls and their tool
 * results are never separated. A unit starts at every non-tool message;
 * consecutive tool results attach to the preceding unit.
 */
function buildUnits(messages: ChatMessage[]): ChatMessage[][] {
  const units: ChatMessage[][] = []
  for (const message of messages) {
    if (message.role === 'tool' && units.length > 0) {
      units[units.length - 1]?.push(message)
    } else {
      units.push([message])
    }
  }
  return units
}

/**
 * Collapses a run of dropped units into protocol-safe stand-ins: dropped
 * user/assistant turns vanish, while any maximal run of dropped tool
 * results becomes a single placeholder user message. Adjacent placeholders
 * merge so the transcript never accumulates filler.
 */
function compressDropped(units: ChatMessage[][]): ChatMessage[] {
  const out: ChatMessage[] = []
  let lastWasPlaceholder = false
  for (const unit of units) {
    for (const message of unit) {
      if (message.role === 'tool') {
        if (!lastWasPlaceholder) {
          out.push({ role: 'user', content: TRIMMED_TOOL_RESULTS_PLACEHOLDER })
          lastWasPlaceholder = true
        }
      } else {
        lastWasPlaceholder = false
      }
    }
  }
  return out
}

/**
 * Trims `messages` to at most `maxChars` of content while guaranteeing:
 *
 * - leading system prompts are always kept;
 * - the latest user message is always kept;
 * - the newest history is preferred over the oldest;
 * - an assistant tool call is never separated from its tool results;
 * - dropped tool-result runs are replaced with
 *   {@link TRIMMED_TOOL_RESULTS_PLACEHOLDER}.
 *
 * The input array is never mutated. Sizes are approximated by summed
 * content lengths; the placeholder itself is not charged to the budget.
 */
export function trimMessages(messages: ChatMessage[], maxChars: number): ChatMessage[] {
  let headEnd = 0
  while (headEnd < messages.length && messages[headEnd]?.role === 'system') headEnd++
  const systems = messages.slice(0, headEnd)

  const units = buildUnits(messages.slice(headEnd))
  let lastUserUnit = -1
  units.forEach((unit, index) => {
    if (unit.some((m) => m.role === 'user')) lastUserUnit = index
  })

  // Walk newest-first, keeping what fits; the latest-user unit is pinned
  // even when it alone exceeds the budget.
  let budget = maxChars - sizeOf(systems)
  const keep = new Array<boolean>(units.length).fill(false)
  for (let index = units.length - 1; index >= 0; index--) {
    const unit = units[index]
    if (!unit) continue
    const size = sizeOf(unit)
    const pinned = index === lastUserUnit
    if (pinned || size <= budget) {
      keep[index] = true
      if (!pinned) budget -= size
    }
  }

  const out: ChatMessage[] = [...systems]
  let droppedRun: ChatMessage[][] = []
  for (let index = 0; index < units.length; index++) {
    const unit = units[index]
    if (!unit) continue
    if (keep[index]) {
      if (droppedRun.length > 0) {
        out.push(...compressDropped(droppedRun))
        droppedRun = []
      }
      out.push(...unit)
    } else {
      droppedRun.push(unit)
    }
  }
  if (droppedRun.length > 0) out.push(...compressDropped(droppedRun))
  return out
}

/** True when the conversation is large enough that summarizing earns its call. */
export function needsCompaction(messages: ChatMessage[], maxChars: number): boolean {
  return sizeOf(messages) > maxChars * COMPACTION_TRIGGER_RATIO
}

export interface CompactionSplit {
  /** Leading system prompts, always preserved verbatim. */
  systems: ChatMessage[]
  /** Older history to summarize; empty when nothing is old enough. */
  older: ChatMessage[]
  /** Newest history kept verbatim. */
  recent: ChatMessage[]
}

/**
 * Splits a conversation at a turn boundary: everything before the cut is
 * summarizable, everything after is kept verbatim. The cut walks backwards
 * from the newest message until `keepRecentChars` is used up, then moves to
 * the next user message so a tool call is never separated from its results
 * and the kept span always starts a turn.
 */
export function splitForCompaction(
  messages: ChatMessage[],
  keepRecentChars = KEEP_RECENT_CHARS,
): CompactionSplit {
  let headEnd = 0
  while (headEnd < messages.length && messages[headEnd]?.role === 'system') headEnd++
  const systems = messages.slice(0, headEnd)
  const history = messages.slice(headEnd)

  // Walk backwards, taking messages while they fit. The newest message is
  // always taken, so a single oversized turn still forms the kept span rather
  // than collapsing the cut to zero.
  let used = 0
  let cut = history.length
  for (let index = history.length - 1; index >= 0; index--) {
    const message = history[index]
    if (!message) continue
    const size = message.content.length
    if (cut < history.length && used + size > keepRecentChars) break
    used += size
    cut = index
  }
  // Land the cut on a user message: that starts a turn, and it guarantees the
  // kept span never opens with an orphaned tool result.
  while (cut < history.length && history[cut]?.role !== 'user') cut++
  // Nothing to summarize if the whole history is inside the keep window, or if
  // no turn boundary was found ahead of the cut.
  if (cut <= 0 || cut >= history.length) {
    return { systems, older: [], recent: history }
  }
  return { systems, older: history.slice(0, cut), recent: history.slice(cut) }
}

/**
 * Renders messages as a transcript for summarization. Roles are labelled so
 * the model reads it as material to summarize rather than a conversation to
 * continue, and tool results are capped so one large read cannot dominate the
 * summarization request.
 */
export function serializeForSummary(messages: ChatMessage[], maxToolResultChars = 2000): string {
  const lines: string[] = []
  for (const message of messages) {
    if (message.role === 'tool') {
      const body =
        message.content.length > maxToolResultChars
          ? `${message.content.slice(0, maxToolResultChars)}… [${message.content.length - maxToolResultChars} chars truncated]`
          : message.content
      lines.push(`[Tool result]: ${body}`)
      continue
    }
    if (message.role === 'assistant') {
      if (message.content.length > 0) lines.push(`[Assistant]: ${message.content}`)
      if (message.toolCalls?.length) {
        const calls = message.toolCalls.map((c) => `${c.name}(${c.argsJson})`).join('; ')
        lines.push(`[Assistant tool calls]: ${calls}`)
      }
      continue
    }
    lines.push(`[${message.role === 'user' ? 'User' : 'System'}]: ${message.content}${message.images && message.images.length > 0 ? ` [${message.images.length} attached image(s)]` : ''}`)
  }
  return lines.join('\n')
}

/** Wraps summary text as the message that stands in for the summarized span. */
export function summaryMessage(summary: string): ChatMessage {
  return { role: 'user', content: `${SUMMARY_PREFIX}\n\n${summary}` }
}
