import type { AgentEvent } from '@ari/contracts/agent-event'
import { formatUnknownError } from '@ari/shared/result'

/**
 * Maps `grok -p --output-format streaming-messages-json` NDJSON onto
 * normalized AgentEvents. Pure and total: malformed lines surface as error
 * events, never throws. The wire format is the Anthropic Messages API NDJSON;
 * the error fixture was recorded from grok CLI 1.0.5 (init-line tool/skill
 * lists trimmed), success shapes follow the documented streaming format.
 * The driver always passes `--include-partial-messages`, so text/thinking
 * arrive as stream_event deltas and whole-message text/thinking blocks are
 * skipped to avoid duplicates; tool_use still maps from the finalized
 * assistant message, where its input JSON is complete.
 */

interface GrokContentBlock {
  type?: string
  id?: string
  name?: string
  input?: unknown
  content?: unknown
  is_error?: boolean
  tool_use_id?: string
}

interface GrokStreamDelta {
  type?: string
  text?: string
  thinking?: string
}

interface GrokStreamEvent {
  type?: string
  delta?: GrokStreamDelta
}

interface NativeLine {
  type?: string
  subtype?: string
  session_id?: string
  is_error?: boolean
  errors?: unknown
  total_cost_usd?: unknown
  usage?: Record<string, unknown>
  message?: { content?: unknown }
  event?: GrokStreamEvent
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Tool results carry a string or a list of `{ text }` blocks. */
function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => (isRecord(part) && typeof part['text'] === 'string' ? part['text'] : ''))
      .join('')
  }
  return ''
}

function mapStreamEvent(event: GrokStreamEvent | undefined): AgentEvent[] {
  if (event?.type !== 'content_block_delta') return []
  const delta = event.delta
  if (!delta) return []
  if (delta.type === 'text_delta' && typeof delta.text === 'string') {
    return [{ type: 'text-delta', text: delta.text }]
  }
  if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
    return [{ type: 'thinking-delta', text: delta.thinking }]
  }
  return []
}

function mapAssistantBlock(block: GrokContentBlock): AgentEvent[] {
  if (block.type !== 'tool_use') return []
  if (typeof block.id !== 'string' || block.id.length === 0) return []
  return [
    {
      type: 'tool-started',
      callId: block.id,
      name: typeof block.name === 'string' ? block.name : 'tool',
      argsJson: JSON.stringify(block.input ?? {}),
    },
  ]
}

function mapUserBlock(block: GrokContentBlock): AgentEvent[] {
  if (block.type !== 'tool_result') return []
  if (typeof block.tool_use_id !== 'string' || block.tool_use_id.length === 0) return []
  return [
    {
      type: 'tool-completed',
      callId: block.tool_use_id,
      resultJson: JSON.stringify(toolResultText(block.content)),
      isError: block.is_error === true,
    },
  ]
}

function mapBlocks(content: unknown, mapBlock: (block: GrokContentBlock) => AgentEvent[]): AgentEvent[] {
  if (!Array.isArray(content)) return []
  return content.flatMap((block) => mapBlock(block as GrokContentBlock))
}

function isFailedResult(parsed: NativeLine): boolean {
  return (
    parsed.is_error === true ||
    (typeof parsed.subtype === 'string' && parsed.subtype.startsWith('error'))
  )
}

function failedResultEvents(parsed: NativeLine): AgentEvent[] {
  const messages = Array.isArray(parsed.errors)
    ? parsed.errors.filter((e): e is string => typeof e === 'string' && e.trim().length > 0)
    : []
  const events: AgentEvent[] = messages.map((message) => ({
    type: 'error',
    message,
    rawJson: null,
  }))
  if (events.length === 0) {
    events.push({ type: 'error', message: 'grok turn failed', rawJson: null })
  }
  events.push({ type: 'done' })
  return events
}

function successResultEvents(parsed: NativeLine): AgentEvent[] {
  const usage = isRecord(parsed.usage) ? parsed.usage : {}
  return [
    {
      type: 'usage',
      inputTokens: typeof usage['input_tokens'] === 'number' ? (usage['input_tokens']) : 0,
      outputTokens:
        typeof usage['output_tokens'] === 'number' ? (usage['output_tokens']) : 0,
      costUsd: typeof parsed.total_cost_usd === 'number' ? parsed.total_cost_usd : null,
    },
    { type: 'done' },
  ]
}

export function mapGrokLine(line: string): AgentEvent[] {
  let parsed: NativeLine
  try {
    parsed = JSON.parse(line) as NativeLine
  } catch (e) {
    return [{ type: 'error', message: `unparseable line: ${formatUnknownError(e)}`, rawJson: null }]
  }

  switch (parsed.type) {
    case 'system': {
      // init carries the CLI's session id; surfacing it lets later turns
      // --resume instead of silently starting a fresh conversation.
      const sid = parsed.session_id
      return typeof sid === 'string' && sid.length > 0 ? [{ type: 'session-ref', ref: sid }] : []
    }

    case 'stream_event':
      return mapStreamEvent(parsed.event)

    case 'assistant':
      return mapBlocks(parsed.message?.content, mapAssistantBlock)

    case 'user':
      return mapBlocks(parsed.message?.content, mapUserBlock)

    case 'result':
      return isFailedResult(parsed) ? failedResultEvents(parsed) : successResultEvents(parsed)

    default:
      return []
  }
}

export function mapGrokStream(lines: Iterable<string>): AgentEvent[] {
  return Array.from(lines).flatMap((line) => mapGrokLine(line))
}
