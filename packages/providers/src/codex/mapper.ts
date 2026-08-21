import type { AgentEvent } from '@ari/contracts/agent-event'
import { formatUnknownError } from '@ari/shared/result'

/**
 * Maps `codex exec --json` JSONL lines onto normalized AgentEvents. Pure and
 * total: malformed lines surface as error events, never throws. The real
 * error fixture was recorded from codex CLI 0.5x; success item shapes follow
 * the documented thread event schema.
 */

interface CodexItem {
  id?: string
  type?: string
  text?: string
  command?: string
  aggregated_output?: string
  exit_code?: number
  status?: string
}

interface NativeLine {
  type?: string
  subtype?: string
  thread_id?: string
  message?: string
  error?: { message?: string } | string
  item?: CodexItem
  usage?: { input_tokens?: number; output_tokens?: number }
}

/** Reconnect chatter is transport noise, not a transcript-worthy failure. */
function isReconnectNoise(message: string): boolean {
  return message.startsWith('Reconnecting...')
}

export function mapCodexLine(line: string): AgentEvent[] {
  let parsed: NativeLine
  try {
    parsed = JSON.parse(line) as NativeLine
  } catch (e) {
    return [{ type: 'error', message: `unparseable line: ${formatUnknownError(e)}`, rawJson: null }]
  }

  switch (parsed.type) {
    case 'thread.started':
    case 'turn.started':
      return []

    case 'item.started':
    case 'item.updated': {
      const item = parsed.item
      if (!item?.id) return []
      if (parsed.type === 'item.started' && item.type === 'command_execution') {
        return [
          {
            type: 'tool-started',
            callId: item.id,
            name: 'bash',
            argsJson: JSON.stringify({ command: item.command ?? '' }),
          },
        ]
      }
      return []
    }

    case 'item.completed': {
      const item = parsed.item
      if (!item) return []
      switch (item.type) {
        case 'agent_message':
          return item.text ? [{ type: 'text-delta', text: item.text }] : []
        case 'reasoning':
          return item.text ? [{ type: 'thinking-delta', text: item.text }] : []
        case 'command_execution': {
          if (!item.id) return []
          const events: AgentEvent[] = []
          // exec --json may emit completed without a started line.
          events.push({
            type: 'tool-started',
            callId: item.id,
            name: 'bash',
            argsJson: JSON.stringify({ command: item.command ?? '' }),
          })
          events.push({
            type: 'tool-completed',
            callId: item.id,
            resultJson: JSON.stringify(item.aggregated_output ?? ''),
            isError: typeof item.exit_code === 'number' && item.exit_code !== 0,
          })
          return events
        }
        case 'file_change': {
          if (!item.id) return []
          return [
            {
              type: 'tool-completed',
              callId: item.id,
              resultJson: JSON.stringify(item),
              isError: item.status === 'failed',
            },
          ]
        }
        default:
          return []
      }
    }

    case 'error': {
      const message = parsed.message ?? ''
      if (isReconnectNoise(message)) return []
      return [{ type: 'error', message, rawJson: null }]
    }

    case 'turn.completed': {
      const usage = parsed.usage ?? {}
      return [
        {
          type: 'usage',
          inputTokens: typeof usage['input_tokens'] === 'number' ? (usage['input_tokens']) : 0,
          outputTokens:
            typeof usage['output_tokens'] === 'number' ? (usage['output_tokens']) : 0,
          costUsd: null,
        },
        { type: 'done' },
      ]
    }

    case 'turn.failed': {
      const err = parsed.error
      const message =
        typeof err === 'string' ? err : (err?.message ?? 'codex turn failed')
      return [
        { type: 'error', message, rawJson: null },
        { type: 'done' },
      ]
    }

    default:
      return []
  }
}

export function mapCodexStream(lines: Iterable<string>): AgentEvent[] {
  return Array.from(lines).flatMap((line) => mapCodexLine(line))
}
