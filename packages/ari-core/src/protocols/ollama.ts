import type { AgentEvent } from '@ari/contracts/agent-event'

/**
 * Ollama `/api/chat` streaming client. Unlike the SSE protocols, Ollama
 * streams newline-delimited JSON (NDJSON). Transport is injected so tests
 * replay recorded line fixtures.
 */

export interface OllamaMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface OllamaChatRequest {
  baseUrl: string
  /** Optional bearer token for gateways fronting Ollama. */
  apiKey?: string | null
  model: string
  messages: OllamaMessage[]
  headers?: Record<string, string>
  signal?: AbortSignal
}

export type NdjsonFetch = (
  url: string,
  init: RequestInit,
) => Promise<{ body: AsyncIterable<string> | null; status: number; statusText: string }>

export const defaultNdjsonFetch: NdjsonFetch = async (url, init) => {
  const response = await fetch(url, init)
  if (!response.body) return { body: null, status: response.status, statusText: response.statusText }
  return {
    body: readNdjsonLines(response.body),
    status: response.status,
    statusText: response.statusText,
  }
}

/** Converts a byte stream into trimmed NDJSON lines. */
async function* readNdjsonLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
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
      if (line.length > 0) yield line
      index = buffer.indexOf('\n')
    }
  }
  const rest = buffer.trim()
  if (rest.length > 0) yield rest
}

interface ChatChunk {
  message?: { content?: string }
  done?: boolean
  prompt_eval_count?: number
  eval_count?: number
  error?: string
}

/**
 * Streams one Ollama chat completion, yielding normalized AgentEvents.
 * Content deltas map to text-delta; the final `done: true` line carries
 * `prompt_eval_count`/`eval_count` as usage.
 */
export async function* streamChatOllama(
  request: OllamaChatRequest,
  ndjsonFetch: NdjsonFetch = defaultNdjsonFetch,
): AsyncGenerator<AgentEvent, void, undefined> {
  const url = `${request.baseUrl.replace(/\/$/, '')}/api/chat`
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...request.headers,
  }
  if (request.apiKey) headers['authorization'] = `Bearer ${request.apiKey}`

  let response
  try {
    response = await ndjsonFetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: request.model,
        messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
        stream: true,
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

  for await (const line of response.body) {
    const data = line.trim()
    if (data.length === 0) continue
    let chunk: ChatChunk
    try {
      chunk = JSON.parse(data) as ChatChunk
    } catch {
      continue
    }
    if (chunk.error) {
      yield { type: 'error', message: chunk.error, rawJson: data }
      yield { type: 'done' }
      return
    }
    if (chunk.message?.content) yield { type: 'text-delta', text: chunk.message.content }
    if (chunk.done) {
      inputTokens = chunk.prompt_eval_count ?? inputTokens
      outputTokens = chunk.eval_count ?? outputTokens
      break
    }
  }

  yield { type: 'usage', inputTokens, outputTokens, costUsd: null }
  yield { type: 'done' }
}
