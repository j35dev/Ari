import { describe, expect, it } from 'vitest'
import { streamChatAnthropic } from './anthropic-messages'
import type { SseFetch } from './openai-chat'

function sseFrom(lines: string[]): SseFetch {
  return async () => ({
    body: (async function* () {
      for (const line of lines) yield line
    })(),
    status: 200,
    statusText: 'OK',
  })
}

const base = {
  baseUrl: 'https://api.anthropic.com',
  apiKey: 'sk-ant-test',
  model: 'claude-test-model',
  system: 'you are terse',
  messages: [
    { role: 'user' as const, content: 'hi' },
    { role: 'assistant' as const, content: 'hello' },
    { role: 'user' as const, content: 'bye' },
  ],
}

describe('anthropic messages streaming client', () => {
  it('streams thinking/text deltas and usage, terminating on message_stop', async () => {
    const events = []
    for await (const e of streamChatAnthropic(
      base,
      sseFrom([
        'data: {"type":"message_start","message":{"usage":{"input_tokens":12}}}',
        'data: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"hmm"}}',
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"he"}}',
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"llo"}}',
        'data: {"type":"message_delta","usage":{"output_tokens":7}}',
        'data: {"type":"message_stop"}',
      ]),
    )) {
      events.push(e)
    }
    expect(events.map((e) => e.type)).toEqual([
      'thinking-delta',
      'text-delta',
      'text-delta',
      'usage',
      'done',
    ])
    if (events[0]?.type === 'thinking-delta') expect(events[0].text).toBe('hmm')
    if (events[3]?.type === 'usage') {
      expect(events[3].inputTokens).toBe(12)
      expect(events[3].outputTokens).toBe(7)
    }
  })

  it('surfaces in-stream error events as error + done', async () => {
    const events = []
    for await (const e of streamChatAnthropic(
      base,
      sseFrom([
        'data: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
      ]),
    )) {
      events.push(e)
    }
    expect(events.map((e) => e.type)).toEqual(['error', 'done'])
    if (events[0]?.type === 'error') expect(events[0].message).toBe('Overloaded')
  })

  it('surfaces HTTP errors as error + done', async () => {
    const fetcher: SseFetch = async () => ({ body: null, status: 401, statusText: 'Unauthorized' })
    const events = []
    for await (const e of streamChatAnthropic(base, fetcher)) events.push(e)
    expect(events.map((e) => e.type)).toEqual(['error', 'done'])
    if (events[0]?.type === 'error') expect(events[0].message).toContain('401')
  })

  it('surfaces network failures as error + done', async () => {
    const fetcher: SseFetch = async () => {
      throw new Error('ECONNREFUSED')
    }
    const events = []
    for await (const e of streamChatAnthropic(base, fetcher)) events.push(e)
    expect(events.map((e) => e.type)).toEqual(['error', 'done'])
  })

  it('tolerates malformed data lines without dying', async () => {
    const events = []
    for await (const e of streamChatAnthropic(
      base,
      sseFrom([
        'data: {oops',
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}',
        'data: {"type":"message_stop"}',
      ]),
    )) {
      events.push(e)
    }
    expect(events.filter((e) => e.type === 'text-delta')).toHaveLength(1)
  })

  it('sends x-api-key auth, api version, model, max_tokens, system and string messages', async () => {
    const box: { url: string; init?: RequestInit } = { url: '' }
    const fetcher: SseFetch = async (url, init) => {
      box.url = url
      box.init = init
      return {
        body: (async function* () {
          yield 'data: {"type":"message_stop"}'
        })(),
        status: 200,
        statusText: 'OK',
      }
    }
    for await (const _ of streamChatAnthropic(base, fetcher)) void _
    expect(box.url).toBe('https://api.anthropic.com/v1/messages')
    const headers = (box.init?.headers ?? {}) as Record<string, string>
    expect(headers['x-api-key']).toBe('sk-ant-test')
    expect(headers['anthropic-version']).toBe('2023-06-01')
    const body = JSON.parse(String(box.init?.body as string)) as {
      model: string
      max_tokens: number
      system?: string
      messages: { role: string; content: string }[]
      stream: boolean
    }
    expect(body.model).toBe('claude-test-model')
    expect(body.max_tokens).toBe(8192)
    expect(body.system).toBe('you are terse')
    expect(body.stream).toBe(true)
    expect(body.messages).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      { role: 'user', content: 'bye' },
    ])
  })
})
