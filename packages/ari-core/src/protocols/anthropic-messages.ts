import type { AgentEvent } from '@ari/contracts/agent-event'
import { defaultSseFetch, type ChatImage, type SseFetch } from './openai-chat'

/**
 * Anthropic Messages API streaming client (`POST /v1/messages`, SSE).
 * Transport is injected so tests replay recorded SSE fixtures.
 */

export interface AnthropicMessage {
  role: 'user' | 'assistant'
  content: string
  /** Staged images attached to a user turn; sent as base64 image blocks. */
  images?: ChatImage[]
}

export interface AnthropicChatRequest {
  baseUrl: string
  apiKey: string | null
  model: string
  /** System prompt, sent in the top-level `system` field (not as a message). */
  system?: string
  messages: AnthropicMessage[]
  headers?: Record<string, string>
  signal?: AbortSignal
  reasoningEffort?: string | null
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
  delta?: { type?: string; text?: string; thinking?: string }
  message?: { usage?: { input_tokens?: number } }
  usage?: { output_tokens?: number }
  error?: { type?: string; message?: string }
}

/**
 * Renders a message for the Anthropic wire format: plain text when imageless,
 * mixed text + base64 image blocks otherwise.
 */
export function anthropicContent(
  message: Pick<AnthropicMessage, 'content' | 'images'>,
): string | ({ type: string; text?: string; source?: { type: string; media_type: string; data: string } }[]) {
  if (!message.images || message.images.length === 0) return message.content
  const blocks: { type: string; text?: string; source?: { type: string; media_type: string; data: string } }[] = []
  if (message.content.length > 0) blocks.push({ type: 'text', text: message.content })
  for (const image of message.images) {
    blocks.push({
      type: 'image',
      source: { type: 'base64', media_type: image.mimeType, data: image.dataBase64 },
    })
  }
  return blocks
}

/**
 * Streams one Anthropic completion, yielding normalized AgentEvents.
 * `message_start` carries input tokens, `message_delta` output tokens, and
 * `message_stop` terminates the stream with a final usage event.
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
        ...(request.system ? { system: request.system } : {}),
        messages: request.messages.map((m) => ({ role: m.role, content: anthropicContent(m) })),
        stream: true,
        ...(thinking !== null ? { thinking } : {}),
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
      message: `endpoint error ${response.status}: ${response.statusText}`,
      rawJson: null,
    }
    yield { type: 'done' }
    return
  }

  let inputTokens = 0
  let outputTokens = 0

  for await (const raw of response.body) {
    const data = raw.startsWith('data:') ? raw.slice(5).trim() : raw.trim()
    if (data.length === 0) continue
    let event: StreamEvent
    try {
      event = JSON.parse(data) as StreamEvent
    } catch {
      continue
    }
    if (event.type === 'content_block_delta') {
      if (event.delta?.type === 'text_delta' && event.delta.text) {
        yield { type: 'text-delta', text: event.delta.text }
      } else if (event.delta?.type === 'thinking_delta' && event.delta.thinking) {
        yield { type: 'thinking-delta', text: event.delta.thinking }
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

  yield { type: 'usage', inputTokens, outputTokens, costUsd: null }
  yield { type: 'done' }
}
