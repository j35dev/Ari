import type { AgentEvent } from '@ari/contracts/agent-event'
import { StreamContent } from './content-split'
import { parseDsmlToolCalls } from './dsml'

/**
 * OpenAI-compatible chat-completions streaming client. Works with any
 * `/v1/chat/completions` endpoint (OpenAI, routers, local gateways).
 * Transport is injected so tests replay recorded SSE fixtures.
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  toolCallId?: string
  /** Assistant tool calls to echo back in multi-turn tool flows. */
  toolCalls?: { id: string; name: string; argsJson: string }[]
}

/** One function advertised to an OpenAI-compat endpoint. */
export interface ChatTool {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface ChatRequest {
  baseUrl: string
  apiKey: string | null
  model: string
  messages: ChatMessage[]
  /** Function schemas. Absent or empty means the request advertises none. */
  tools?: ChatTool[]
  headers?: Record<string, string>
  signal?: AbortSignal
  /** OpenAI / xAI reasoning depth; omitted when the session left the default. */
  reasoningEffort?: string | null
}

export type SseFetch = (
  url: string,
  init: RequestInit,
) => Promise<{ body: AsyncIterable<string> | null; status: number; statusText: string }>

export const defaultSseFetch: SseFetch = async (url, init) => {
  const response = await fetch(url, init)
  if (!response.body) return { body: null, status: response.status, statusText: response.statusText }
  return { body: readSseLines(response.body), status: response.status, statusText: response.statusText }
}

/** Converts a byte stream into SSE `data:` payload lines. */
async function* readSseLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let index = buffer.indexOf('\n')
    while (index !== -1) {
      const line = buffer.slice(0, index).replace(/\r$/, '')
      buffer = buffer.slice(index + 1)
      if (line.startsWith('data:')) yield line.slice(5).trim()
      index = buffer.indexOf('\n')
    }
  }
}

interface StreamChunk {
  choices?: {
    delta?: {
      content?: string
      reasoning_content?: string
      /** OpenRouter and some reasoner proxies use `reasoning` instead. */
      reasoning?: string
      tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[]
    }
  }[]
  usage?: { prompt_tokens?: number; completion_tokens?: number }
}

/**
 * Streams one chat completion, yielding normalized AgentEvents. Tool-call
 * argument deltas are accumulated per index and emitted as a single
 * tool-started when the call completes.
 */
export async function* streamChatCompletion(
  request: ChatRequest,
  sseFetch: SseFetch = defaultSseFetch,
): AsyncGenerator<AgentEvent, void, undefined> {
  const url = `${request.baseUrl.replace(/\/$/, '')}/chat/completions`
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...request.headers,
  }
  if (request.apiKey) headers['authorization'] = `Bearer ${request.apiKey}`

  let response
  try {
    response = await sseFetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: request.model,
        messages: request.messages.map((m) => ({
          role: m.role,
          content: m.content,
          ...(m.toolCallId ? { tool_call_id: m.toolCallId } : {}),
          ...(m.toolCalls
            ? {
                tool_calls: m.toolCalls.map((t) => ({
                  id: t.id,
                  type: 'function',
                  function: { name: t.name, arguments: t.argsJson },
                })),
              }
            : {}),
        })),
        stream: true,
        stream_options: { include_usage: true },
        ...(request.reasoningEffort
          ? {
              reasoning_effort: request.reasoningEffort,
              reasoning: { effort: request.reasoningEffort },
            }
          : {}),
        ...(request.tools && request.tools.length > 0
          ? {
              tools: request.tools.map((tool) => ({
                type: 'function',
                function: {
                  name: tool.name,
                  description: tool.description,
                  parameters: tool.parameters,
                },
              })),
              tool_choice: 'auto',
            }
          : {}),
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

  const pendingTools = new Map<number, { id: string; name: string; args: string }>()
  let inputTokens = 0
  let outputTokens = 0
  let sawNativeTool = false
  const content = new StreamContent()

  for await (const raw of response.body) {
    const data = raw.startsWith('data:') ? raw.slice(5).trim() : raw.trim()
    if (data.length === 0) continue
    if (data === '[DONE]') break
    let chunk: StreamChunk
    try {
      chunk = JSON.parse(data) as StreamChunk
    } catch {
      continue
    }
    const choice = chunk.choices?.[0]
    const delta = choice?.delta
    if (delta?.content) {
      for (const event of content.push(delta.content)) yield event
    }
    const reasoning = delta?.reasoning_content ?? delta?.reasoning
    if (reasoning) yield { type: 'thinking-delta', text: reasoning }
    for (const call of delta?.tool_calls ?? []) {
      const entry = pendingTools.get(call.index) ?? { id: '', name: '', args: '' }
      if (call.id) entry.id = call.id
      if (call.function?.name) entry.name = call.function.name
      if (call.function?.arguments) entry.args += call.function.arguments
      pendingTools.set(call.index, entry)
      // Emit as soon as the name is known and args look complete-ish; the
      // agent loop re-parses strictly anyway.
      if (entry.name && looksComplete(entry.args)) {
        pendingTools.delete(call.index)
        sawNativeTool = true
        yield {
          type: 'tool-started',
          callId: entry.id || `call_${call.index}`,
          name: entry.name,
          argsJson: entry.args,
        }
      }
    }
    if (chunk.usage) {
      inputTokens = chunk.usage.prompt_tokens ?? inputTokens
      outputTokens = chunk.usage.completion_tokens ?? outputTokens
    }
  }

  // Flush any tools whose argument stream never looked complete.
  for (const [index, entry] of pendingTools) {
    sawNativeTool = true
    yield {
      type: 'tool-started',
      callId: entry.id || `call_${index}`,
      name: entry.name,
      argsJson: entry.args,
    }
  }

  const leftover = content.end()
  for (const event of leftover.events) yield event
  if (!sawNativeTool && leftover.dsml !== null) {
    const recovered = parseDsmlToolCalls(leftover.dsml)
    for (const [i, call] of recovered.entries()) {
      yield {
        type: 'tool-started',
        callId: `dsml_${i}`,
        name: call.name,
        argsJson: JSON.stringify(call.args),
      }
    }
  }

  yield { type: 'usage', inputTokens, outputTokens, costUsd: null }
  yield { type: 'done' }
}

function looksComplete(args: string): boolean {
  try {
    JSON.parse(args)
    return true
  } catch {
    return false
  }
}
