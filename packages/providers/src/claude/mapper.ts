import type { AgentEvent } from '@ari/contracts/agent-event'
import { formatUnknownError } from '@ari/shared/result'

/**
 * Maps Claude Code `--output-format stream-json` lines onto normalized
 * AgentEvents. Pure and total: malformed lines surface as error events, never
 * throws. See __fixtures__ for real recorded shapes.
 */

interface ContentBlock {
  type: string
  text?: string
  thinking?: string
  id?: string
  name?: string
  input?: unknown
  tool_use_id?: string
  content?: unknown
  is_error?: boolean
}

interface NativeLine {
  type?: string
  subtype?: string
  session_id?: string
  error?: string
  is_error?: boolean
  message?: { content?: ContentBlock[]; usage?: Record<string, unknown> }
  usage?: Record<string, unknown>
  total_cost_usd?: number
  result?: string
}

function usageFrom(raw: Record<string, unknown> | undefined): {
  inputTokens: number
  outputTokens: number
} {
  return {
    inputTokens: typeof raw?.['input_tokens'] === 'number' ? (raw['input_tokens']) : 0,
    outputTokens:
      typeof raw?.['output_tokens'] === 'number' ? (raw['output_tokens']) : 0,
  }
}

/** Maps one JSONL line. Returns zero or more normalized events. */
export function mapClaudeLine(line: string): AgentEvent[] {
  let parsed: NativeLine
  try {
    parsed = JSON.parse(line) as NativeLine
  } catch (e) {
    return [{ type: 'error', message: `unparseable line: ${formatUnknownError(e)}`, rawJson: null }]
  }

  const events: AgentEvent[] = []

  if (typeof parsed.error === 'string' && parsed.error.length > 0) {
    events.push({
      type: 'error',
      message: `${parsed.error}: ${extractText(parsed)}`,
      rawJson: null,
    })
    return events
  }

  switch (parsed.type) {
    case 'system':
      // init carries session metadata; nothing to surface in the transcript.
      break

    case 'assistant': {
      for (const block of parsed.message?.content ?? []) {
        if (block.type === 'text' && block.text) {
          events.push({ type: 'text-delta', text: block.text })
        } else if (block.type === 'thinking' && block.thinking) {
          events.push({ type: 'thinking-delta', text: block.thinking })
        } else if (block.type === 'tool_use' && block.id && block.name) {
          events.push({
            type: 'tool-started',
            callId: block.id,
            name: block.name,
            argsJson: JSON.stringify(block.input ?? {}),
          })
        }
      }
      break
    }

    case 'user': {
      for (const block of parsed.message?.content ?? []) {
        if (block.type === 'tool_result' && block.tool_use_id) {
          events.push({
            type: 'tool-completed',
            callId: block.tool_use_id,
            resultJson: JSON.stringify(block.content ?? null),
            isError: block.is_error === true,
          })
        }
      }
      break
    }

    case 'result': {
      const usage = usageFrom(parsed.usage)
      events.push({
        type: 'usage',
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        costUsd: typeof parsed.total_cost_usd === 'number' ? parsed.total_cost_usd : null,
      })
      if (parsed.is_error === true) {
        events.push({ type: 'error', message: extractText(parsed), rawJson: null })
      }
      events.push({ type: 'done' })
      break
    }
  }

  return events
}

function extractText(line: NativeLine): string {
  for (const block of line.message?.content ?? []) {
    if (block.type === 'text' && block.text) return block.text
  }
  return typeof line.result === 'string' ? line.result : 'unknown provider error'
}

/** Maps a whole stream of lines in order. */
export function mapClaudeStream(lines: Iterable<string>): AgentEvent[] {
  return Array.from(lines).flatMap((line) => mapClaudeLine(line))
}
