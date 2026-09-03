import type { AgentEvent } from '@ari/contracts/agent-event'
import type { ChatImage } from './openai-chat'
import {
  describeFailure,
  faultMessage,
  guardStream,
  MAX_ERROR_BODY_CHARS,
  withIdleDeadline,
  withRetry,
  type StreamFetch,
} from './http-retry'

/**
 * Ollama `/api/chat` streaming client. Unlike the SSE protocols, Ollama
 * streams newline-delimited JSON (NDJSON). Transport is injected so tests
 * replay recorded line fixtures.
 */

export interface OllamaMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
  /** Staged images attached to a user turn; sent as Ollama's native `images`. */
  images?: ChatImage[]
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

export type NdjsonFetch = StreamFetch

/** One attempt, no retrying — {@link defaultNdjsonFetch} wraps it in backoff. */
const ndjsonFetchOnce: NdjsonFetch = async (url, init) => {
  const response = await fetch(url, init)
  const retryAfter = response.headers.get('retry-after')
  if (!response.body || response.status >= 400) {
    const errorBody = await response.text().catch(() => '')
    return {
      body: null,
      status: response.status,
      statusText: response.statusText,
      errorBody: errorBody.slice(0, MAX_ERROR_BODY_CHARS),
      retryAfter,
    }
  }
  return {
    body: withIdleDeadline(readNdjsonLines(response.body)),
    status: response.status,
    statusText: response.statusText,
    retryAfter,
  }
}

export const defaultNdjsonFetch: NdjsonFetch = withRetry(ndjsonFetchOnce)

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
        messages: request.messages.map((m) => ({
          role: m.role,
          content: m.content,
          ...(m.images && m.images.length > 0
            ? { images: m.images.map((img) => img.dataBase64) }
            : {}),
        })),
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
      message: describeFailure(response),
      rawJson: response.errorBody ?? null,
    }
    yield { type: 'done' }
    return
  }

  let inputTokens = 0
  let outputTokens = 0
  let streamFault: unknown = null

  for await (const line of guardStream(response.body, (error) => (streamFault = error))) {
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

  yield { type: 'usage', inputTokens, outputTokens, costUsd: null }
  yield { type: 'done' }
}
