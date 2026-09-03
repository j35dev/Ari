import type { AgentEvent } from '@ari/contracts/agent-event'
import { defaultSseFetch, type SseFetch } from './openai-chat'
import { describeFailure, faultMessage, guardStream } from './http-retry'

/**
 * Anthropic Messages API streaming client (`POST /v1/messages`, SSE).
 * Transport is injected so tests replay recorded SSE fixtures.
 *
 * Native tool use: tools are advertised on the request, assistant turns carry
 * `tool_use` blocks, and results come back as `tool_result` blocks inside the
 * following user turn. Content is either a plain string or an array of content
 * blocks (text / image / tool_use / tool_result).
 */

export interface AnthropicTextBlock {
  type: 'text'
  text: string
}

export interface AnthropicImageBlock {
  type: 'image'
  source: { type: 'base64'; media_type: string; data: string }
}

/** A tool call the model made. `input` is the parsed JSON arguments object. */
export interface AnthropicToolUseBlock {
  type: 'tool_use'
  id: string
  name: string
  input: unknown
}

/** A tool result answering a prior `tool_use`. Must live in a user turn. */
export interface AnthropicToolResultBlock {
  type: 'tool_result'
  tool_use_id: string
  content: string
}

export type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock

/** Content is a plain string, or an array of blocks once tools/images exist. */
export type AnthropicContent = string | AnthropicContentBlock[]

export interface AnthropicMessage {
  role: 'user' | 'assistant'
  content: AnthropicContent
}

/** One function advertised to the endpoint, in Anthropic's tool schema. */
export interface AnthropicToolSpec {
  name: string
  description: string
  /** JSON Schema for the tool's arguments (the harness `parameters` field). */
  input_schema: Record<string, unknown>
}

export interface AnthropicChatRequest {
  baseUrl: string
  apiKey: string | null
  model: string
  /** System prompt, sent in the top-level `system` field (not as a message). */
  system?: string
  messages: AnthropicMessage[]
  /** Function schemas. Absent or empty means the request advertises none. */
  tools?: AnthropicToolSpec[]
  headers?: Record<string, string>
  signal?: AbortSignal
  reasoningEffort?: string | null
  /**
   * Attach `cache_control: { type: 'ephemeral' }` to the system prompt and the
   * final tool definition, so repeated rounds of one turn reuse the cached
   * prefix. Opt-in: older models reject `cache_control`.
   */
  cache?: boolean
}

function thinkingFor(
  effort: string | null | undefined,
): { type: 'enabled'; budget_tokens: number } | null {
  if (effort === null || effort === undefined || effort.length === 0) return null
  const budget =
    effort === 'low' || effort === 'minimal'
      ? 2048
      : effort === 'medium'
        ? 8192
        : effort === 'xhigh'
          ? 32_000
          : 16_384
  return { type: 'enabled', budget_tokens: budget }
}

interface StreamEvent {
  type?: string
  index?: number
  content_block?: {
    type?: string
    id?: string
    name?: string
  }
  delta?: { type?: string; text?: string; thinking?: string; partial_json?: string }
  message?: { usage?: { input_tokens?: number } }
  usage?: { output_tokens?: number }
  error?: { type?: string; message?: string }
}

/** Wire form of the system prompt: the string, or a cached text block. */
function systemBody(system: string | undefined, cache: boolean): unknown {
  if (system === undefined) return undefined
  return cache ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }] : system
}

/** Wire form of the tool list; the last entry carries the cache breakpoint. */
function toolsBody(tools: AnthropicToolSpec[] | undefined, cache: boolean): unknown {
  if (tools === undefined || tools.length === 0) return undefined
  if (!cache) return tools
  return tools.map((tool, index) =>
    index === tools.length - 1 ? { ...tool, cache_control: { type: 'ephemeral' } } : tool,
  )
}

/**
 * Streams one Anthropic completion, yielding normalized AgentEvents.
 * `message_start` carries input tokens, `message_delta` output tokens, and
 * `message_stop` terminates the stream. Text and thinking deltas stream live;
 * a `tool_use` block accumulates its `input_json_delta` fragments and is
 * emitted as a single `tool-started` when the block stops.
 */
export async function* streamChatAnthropic(
  request: AnthropicChatRequest,
  sseFetch: SseFetch = defaultSseFetch,
): AsyncGenerator<AgentEvent, void, undefined> {
  const url = `${request.baseUrl.replace(/\/$/, '')}/v1/messages`
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'anthropic-version': '2023-06-01',
    ...request.headers,
  }
  if (request.apiKey) headers['x-api-key'] = request.apiKey

  const thinking = thinkingFor(request.reasoningEffort)
  let response
  try {
    response = await sseFetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: request.model,
        max_tokens: thinking ? thinking.budget_tokens + 4096 : 8192,
        system: systemBody(request.system, request.cache ?? false),
        messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
        stream: true,
        thinking: thinking !== null ? thinking : undefined,
        tools: toolsBody(request.tools, request.cache ?? false),
      }),
      signal: request.signal,
    })
  } catch (e) {
    yield { type: 'error', message: `endpoint unreachable: ${String(e)}`, rawJson: null }
    yield { type: 'done' }
    return
  }

  if (!response.body || response.status >= 400) {
    yield {
      type: 'error',
      message: describeFailure(response),
      rawJson: response.errorBody ?? null,
    }
    yield { type: 'done' }
    return
  }

  let inputTokens = 0
  let outputTokens = 0
  let streamFault: unknown = null
  // Tool_use blocks accumulate by content-block index; emitted on block stop.
  const pendingTools = new Map<number, { id: string; name: string; json: string }>()

  for await (const raw of guardStream(response.body, (error) => (streamFault = error))) {
    const data = raw.startsWith('data:') ? raw.slice(5).trim() : raw.trim()
    if (data.length === 0) continue
    let event: StreamEvent
    try {
      event = JSON.parse(data) as StreamEvent
    } catch {
      continue
    }
    if (event.type === 'content_block_start') {
      const block = event.content_block
      if (block?.type === 'tool_use' && typeof event.index === 'number') {
        pendingTools.set(event.index, {
          id: block.id ?? '',
          name: block.name ?? '',
          json: '',
        })
      }
    } else if (event.type === 'content_block_delta') {
      const delta = event.delta
      if (delta?.type === 'text_delta' && delta.text) {
        yield { type: 'text-delta', text: delta.text }
      } else if (delta?.type === 'thinking_delta' && delta.thinking) {
        yield { type: 'thinking-delta', text: delta.thinking }
      } else if (delta?.type === 'input_json_delta' && delta.partial_json) {
        if (typeof event.index === 'number') {
          const entry = pendingTools.get(event.index) ?? { id: '', name: '', json: '' }
          entry.json += delta.partial_json
          pendingTools.set(event.index, entry)
        }
      }
    } else if (event.type === 'content_block_stop') {
      if (typeof event.index === 'number') {
        const entry = pendingTools.get(event.index)
        if (entry) {
          pendingTools.delete(event.index)
          if (entry.name) {
            yield {
              type: 'tool-started',
              callId: entry.id || `call_${event.index}`,
              name: entry.name,
              argsJson: entry.json,
            }
          }
        }
      }
    } else if (event.type === 'message_start') {
      inputTokens = event.message?.usage?.input_tokens ?? inputTokens
    } else if (event.type === 'message_delta') {
      outputTokens = event.usage?.output_tokens ?? outputTokens
    } else if (event.type === 'message_stop') {
      break
    } else if (event.type === 'error') {
      yield {
        type: 'error',
        message: event.error?.message ?? 'anthropic stream error',
        rawJson: data,
      }
      yield { type: 'done' }
      return
    }
  }

  // A stream that broke mid-flight has emitted whatever arrived; the round
  // still failed, so no half-parsed tool block is flushed from it.
  if (streamFault !== null) {
    if (request.signal?.aborted !== true) {
      yield {
        type: 'error',
        message: `endpoint stream interrupted: ${faultMessage(streamFault)}`,
        rawJson: null,
      }
    }
    yield { type: 'done' }
    return
  }

  // Flush any tool block whose stream ended without an explicit stop.
  for (const [index, entry] of pendingTools) {
    if (entry.name) {
      yield {
        type: 'tool-started',
        callId: entry.id || `call_${index}`,
        name: entry.name,
        argsJson: entry.json,
      }
    }
  }

  yield { type: 'usage', inputTokens, outputTokens, costUsd: null }
  yield { type: 'done' }
}
