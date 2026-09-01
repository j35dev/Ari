import type { AgentEvent } from '@ari/contracts/agent-event'
import { containsDsml, parseDsmlToolCalls } from './dsml'

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
  // DSML can arrive split across deltas (`<|` then `DSML|…`). Hold only a
  // suffix that could still become a DSML open tag so ordinary text still
  // streams, then recover the markup as tool-started if no native tool_calls.
  let held = ''
  let dsmlMode = false

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
      held += delta.content
      if (!dsmlMode) {
        const at = held.search(/<\s*\|\s*DSML\s*\|/i)
        if (at === -1) {
          const keep = trailingDsmlPrefixLen(held)
          const flush = held.slice(0, held.length - keep)
          held = held.slice(held.length - keep)
          if (flush.length > 0) yield { type: 'text-delta', text: flush }
        } else {
          const before = held.slice(0, at)
          if (before.length > 0) yield { type: 'text-delta', text: before }
          held = held.slice(at)
          dsmlMode = true
        }
      }
    }
    if (delta?.reasoning_content) yield { type: 'thinking-delta', text: delta.reasoning_content }
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

  if (!sawNativeTool && (dsmlMode || containsDsml(held))) {
    const recovered = parseDsmlToolCalls(held)
    for (const [i, call] of recovered.entries()) {
      yield {
        type: 'tool-started',
        callId: `dsml_${i}`,
        name: call.name,
        argsJson: JSON.stringify(call.args),
      }
    }
  } else if (!dsmlMode && held.length > 0) {
    yield { type: 'text-delta', text: held }
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

/** Longest suffix of `text` that could still grow into a `<|DSML|` open tag. */
function trailingDsmlPrefixLen(text: string): number {
  const max = Math.min(text.length, 16)
  for (let n = max; n > 0; n--) {
    if (/^<\s*(?:\|\s*(?:D(?:S(?:M(?:L(?:\s*\|?)?)?)?)?)?)?$/i.test(text.slice(-n))) return n
  }
  return 0
}
