import type { AgentEvent } from '@ari/contracts/agent-event'
import { formatUnknownError } from '@ari/shared/result'
import { imageOutputEvents } from '../image-output'

/**
 * Maps `pi --mode json -p` JSONL lines onto normalized AgentEvents. Pure and
 * total: malformed lines surface as error events, never throws.
 *
 * Wire shapes were recorded from pi 0.84.x (`error-*.jsonl` fixtures are real
 * runs); `success-session.jsonl` is synthesized from the observed schema after
 * provider auth failed on the recording machine. Streaming `message_update`
 * deltas are intentionally ignored — complete blocks are mapped once at
 * `message_end`, mirroring the claude/codex mappers' item-level approach.
 */

interface ContentBlock {
  type?: string
  text?: string
  thinking?: string
  id?: string
  name?: string
  arguments?: unknown
}

interface Usage {
  input?: unknown
  output?: unknown
  cacheRead?: unknown
  cacheWrite?: unknown
  cost?: { total?: unknown }
}

interface Message {
  role?: string
  content?: ContentBlock[]
  usage?: Usage
  stopReason?: string
  errorMessage?: string
}

interface NativeLine {
  type?: string
  id?: string
  message?: Message
  messages?: Message[]
  toolCallId?: string
  toolName?: string
  args?: unknown
  result?: unknown
  isError?: boolean
}

function mapAssistantMessage(message: Message): AgentEvent[] {
  const events: AgentEvent[] = []
  if (message.stopReason === 'error' && message.errorMessage) {
    events.push({ type: 'error', message: message.errorMessage, rawJson: null })
    return events
  }
  for (const block of message.content ?? []) {
    if (block.type === 'text' && block.text) {
      events.push({ type: 'text-delta', text: block.text })
    } else if (block.type === 'thinking' && block.thinking) {
      events.push({ type: 'thinking-delta', text: block.thinking })
    }
    // toolCall blocks are covered by tool_execution_start/end events.
  }
  return events
}

/**
 * Each assistant message carries the usage of the one model call that wrote
 * it, with cache traffic kept out of `input`. The turn spent their sum; the
 * window holds what the last call saw.
 */
function usageFrom(messages: Message[] | undefined): AgentEvent[] {
  const count = (value: unknown): number => (typeof value === 'number' ? value : 0)
  let input = 0
  let output = 0
  let cached = 0
  let cost: number | null = null
  let context = 0
  for (const message of messages ?? []) {
    const usage = message.role === 'assistant' ? message.usage : undefined
    if (!usage) continue
    const read = count(usage.input) + count(usage.cacheWrite) + count(usage.cacheRead)
    input += read
    output += count(usage.output)
    cached += count(usage.cacheRead)
    if (typeof usage.cost?.total === 'number') cost = (cost ?? 0) + usage.cost.total
    context = read + count(usage.output)
  }
  const events: AgentEvent[] = [
    {
      type: 'usage',
      inputTokens: input,
      outputTokens: output,
      cachedInputTokens: cached,
      costUsd: cost,
    },
  ]
  if (context > 0) events.push({ type: 'context-usage', usedTokens: context, windowTokens: null })
  return events
}

/** Maps one JSONL line. Returns zero or more normalized events. */
export function mapPiLine(line: string): AgentEvent[] {
  let parsed: NativeLine
  try {
    parsed = JSON.parse(line) as NativeLine
  } catch (e) {
    return [{ type: 'error', message: `unparseable line: ${formatUnknownError(e)}`, rawJson: null }]
  }

  switch (parsed.type) {
    case 'session': {
      const id = parsed.id
      return typeof id === 'string' && id.length > 0 ? [{ type: 'session-ref', ref: id }] : []
    }

    case 'agent_start':
    case 'turn_start':
    case 'message_start':
    case 'message_update':
      return []

    case 'message_end': {
      const message = parsed.message
      if (!message || message.role !== 'assistant') return []
      return mapAssistantMessage(message)
    }

    case 'tool_execution_start': {
      if (!parsed.toolCallId) return []
      return [
        {
          type: 'tool-started',
          callId: parsed.toolCallId,
          name: parsed.toolName ?? 'unknown',
          argsJson: JSON.stringify(parsed.args ?? {}),
        },
      ]
    }

    case 'tool_execution_end': {
      if (!parsed.toolCallId) return []
      return [
        {
          type: 'tool-completed',
          callId: parsed.toolCallId,
          resultJson: JSON.stringify(parsed.result ?? null),
          isError: parsed.isError === true,
        },
        ...imageOutputEvents(parsed.result),
      ]
    }

    case 'turn_end':
      // toolResults duplicate tool_execution_end; skip to avoid double emission.
      return []

    case 'agent_end':
      return [...usageFrom(parsed.messages), { type: 'done' }]

    default:
      return []
  }
}

/** Maps a whole stream of lines in order. */
export function mapPiStream(lines: Iterable<string>): AgentEvent[] {
  return Array.from(lines).flatMap((line) => mapPiLine(line))
}
