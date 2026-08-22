import type { ChatMessage } from './protocols/openai-chat'

/**
 * Context-window manager for the Ari Core harness. Pure functions only:
 * given the accumulated message list, produce a trimmed copy that keeps
 * the conversation valid for every protocol flavor.
 */

/** Placeholder substituted for runs of dropped tool-result messages. */
export const TRIMMED_TOOL_RESULTS_PLACEHOLDER = '[earlier tool results trimmed]'

/**
 * Soft context budget (in content characters) applied by the driver before
 * each model round. Roughly ~30k tokens for typical tokenizers.
 */
export const CONTEXT_WINDOW_CHARS = 120_000

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
