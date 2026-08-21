import type { AgentEvent } from '@ari/contracts/agent-event'
import { formatUnknownError } from '@ari/shared/result'

/**
 * Maps `opencode run --format json` JSONL lines onto normalized AgentEvents.
 * Pure and total: malformed lines surface as error events, never throws. The
 * success/error/tool fixtures were recorded live from opencode CLI 1.18;
 * reasoning-part shapes follow the documented session part schema.
 */

interface OpencodePart {
  type?: string
  tool?: string
  callID?: string
  text?: string
  reason?: string
  state?: {
    status?: string
    input?: unknown
    output?: string
    metadata?: { exit?: number }
  }
  tokens?: Record<string, unknown>
  cost?: number
}

interface NativeLine {
  type?: string
  part?: OpencodePart
  error?: { name?: string; data?: { message?: string } }
}

/** Steps ending in another round of tool calls are followed by more steps. */
function isTerminalStepFinish(reason: string | undefined): boolean {
  return reason !== 'tool-calls'
}

function mapToolPart(part: OpencodePart): AgentEvent[] {
  if (!part.callID || !part.tool) return []
  const status = part.state?.status
  const events: AgentEvent[] = [
    {
      type: 'tool-started',
      callId: part.callID,
      name: part.tool,
      argsJson: JSON.stringify(part.state?.input ?? {}),
    },
  ]
  if (status === 'pending') return events
  const exit = part.state?.metadata?.exit
  events.push({
    type: 'tool-completed',
    callId: part.callID,
    resultJson: JSON.stringify(part.state?.output ?? ''),
    isError: status === 'error' || (typeof exit === 'number' && exit !== 0),
  })
  return events
}

export function mapOpencodeLine(line: string): AgentEvent[] {
  let parsed: NativeLine
  try {
    parsed = JSON.parse(line) as NativeLine
  } catch (e) {
    // Plain-text log chatter is transport noise; only broken JSON is an error.
    if (!line.trim().startsWith('{')) return []
    return [{ type: 'error', message: `unparseable line: ${formatUnknownError(e)}`, rawJson: null }]
  }

  switch (parsed.type) {
    case 'step_start':
      return []

    case 'text':
      return parsed.part?.text ? [{ type: 'text-delta', text: parsed.part.text }] : []

    case 'reasoning':
      return parsed.part?.text ? [{ type: 'thinking-delta', text: parsed.part.text }] : []

    case 'tool_use':
      return parsed.part?.type === 'tool' ? mapToolPart(parsed.part) : []

    case 'step_finish': {
      const tokens = parsed.part?.tokens ?? {}
      const input = typeof tokens['input'] === 'number' ? tokens['input'] : 0
      const output = typeof tokens['output'] === 'number' ? tokens['output'] : 0
      const usage: AgentEvent = {
        type: 'usage',
        inputTokens: input,
        outputTokens: output,
        costUsd: typeof parsed.part?.cost === 'number' ? parsed.part.cost : null,
      }
      return isTerminalStepFinish(parsed.part?.reason) ? [usage, { type: 'done' }] : [usage]
    }

    case 'error': {
      const message = parsed.error?.data?.message ?? parsed.error?.name ?? 'opencode error'
      return [{ type: 'error', message, rawJson: null }]
    }

    default:
      return []
  }
}

export function mapOpencodeStream(lines: Iterable<string>): AgentEvent[] {
  return Array.from(lines).flatMap((line) => mapOpencodeLine(line))
}
