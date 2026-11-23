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

/** Stateful print-mode stream: preserve channel/block identity and reconcile message_end. */
export class PiMessageMapper {
  #session = 'session'
  #round = 0
  #active = false
  #lastEnd = ''
  readonly #blocks = new Map<number, string>()
  mapLine(line: string): AgentEvent[] {
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(line) as Record<string, unknown>
    } catch {
      return mapPiLine(line)
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
      return [{ type: 'error', message: 'Unexpected Pi stream record.', rawJson: null }]
    const message = parsed.message as (Message & { timestamp?: number }) | undefined
    if (parsed.type === 'session' && typeof parsed.id === 'string') this.#session = parsed.id
    if (parsed.type === 'message_start' && message?.role === 'assistant') {
      this.#round++
      this.#active = true
      this.#blocks.clear()
      return []
    }
    if (parsed.type === 'message_update' && this.#active) {
      const event = parsed.assistantMessageEvent as
        { type?: string; delta?: unknown; contentIndex?: number } | undefined
      if (
        event &&
        (event.type === 'text_delta' || event.type === 'thinking_delta') &&
        typeof event.delta === 'string'
      ) {
        const kind = event.type === 'text_delta' ? 'text-delta' : 'thinking-delta'
        const index = event.contentIndex ?? 0
        this.#blocks.set(index, (this.#blocks.get(index) ?? '') + event.delta)
        return [
          {
            type: kind,
            text: event.delta,
            streamId: `pi:${this.#session}:${this.#round}:${kind}:${event.contentIndex ?? 0}`,
          },
        ]
      }
    }
    if (parsed.type === 'message_end' && message?.role === 'assistant') {
      if (message.stopReason === 'error') {
        this.#active = false
        return mapPiLine(line)
      }
      const signature =
        typeof message.timestamp === 'number'
          ? `${message.timestamp}:${JSON.stringify(message.content)}`
          : ''
      if (!this.#active && signature && signature === this.#lastEnd) return []
      if (!this.#active) {
        this.#round++
        this.#blocks.clear()
      }
      this.#active = false
      this.#lastEnd = signature
      return (message.content ?? []).flatMap((block, index): AgentEvent[] => {
        if (block.type !== 'text' && block.type !== 'thinking') return []
        const value = block.type === 'text' ? block.text : block.thinking
        if (typeof value !== 'string') return []
        const kind = block.type === 'text' ? 'text-delta' : 'thinking-delta'
        const prior = this.#blocks.get(index) ?? ''
        const append = value.startsWith(prior)
        const remaining = append ? value.slice(prior.length) : value
        if (!remaining && append) return []
        return [
          {
            type: kind,
            text: remaining,
            streamId: `pi:${this.#session}:${this.#round}:${kind}:${index}`,
            ...(!append ? { replace: true } : {}),
          },
        ]
      })
    }
    if (
      parsed.type === 'tool_execution_update' &&
      typeof parsed.toolCallId === 'string' &&
      parsed.partialResult !== undefined
    )
      return [
        {
          type: 'tool-progress',
          callId: parsed.toolCallId,
          resultJson: JSON.stringify(parsed.partialResult),
        },
      ]
    return mapPiLine(line)
  }
}
