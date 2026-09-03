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

  it('parses a native tool_use stream into a single tool-started event', async () => {
    const events = []
    for await (const e of streamChatAnthropic(
      base,
      sseFrom([
        'data: {"type":"message_start","message":{"usage":{"input_tokens":12}}}',
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tu_1","name":"read"}}',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":"}}',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\\"note.txt\\"}"}}',
        'data: {"type":"content_block_stop","index":0}',
        'data: {"type":"message_delta","usage":{"output_tokens":5}}',
        'data: {"type":"message_stop"}',
      ]),
    )) {
      events.push(e)
    }
    expect(events.map((e) => e.type)).toEqual(['tool-started', 'usage', 'done'])
    if (events[0]?.type === 'tool-started') {
      expect(events[0].callId).toBe('tu_1')
      expect(events[0].name).toBe('read')
      expect(events[0].argsJson).toBe('{"path":"note.txt"}')
    }
    if (events[1]?.type === 'usage') {
      expect(events[1].inputTokens).toBe(12)
      expect(events[1].outputTokens).toBe(5)
    }
  })

  it('streams text and tool_use from one assistant turn without losing either', async () => {
    const events = []
    for await (const e of streamChatAnthropic(
      base,
      sseFrom([
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"let me look"}}',
        'data: {"type":"content_block_stop","index":0}',
        'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tu_2","name":"grep"}}',
        'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"pattern\\":\\"x\\"}"}}',
        'data: {"type":"content_block_stop","index":1}',
        'data: {"type":"message_stop"}',
      ]),
    )) {
      events.push(e)
    }
    expect(events.filter((e) => e.type === 'text-delta')).toHaveLength(1)
    const tool = events.find((e) => e.type === 'tool-started')
    expect(tool?.type === 'tool-started' && tool.name).toBe('grep')
  })

  it('advertises tools and marks the system + last tool for caching when opted in', async () => {
    const box: { body?: string } = {}
    const fetcher: SseFetch = async (_url, init) => {
      box.body = String(init.body as string)
      return {
        body: (async function* () {
          yield 'data: {"type":"message_stop"}'
        })(),
        status: 200,
        statusText: 'OK',
      }
    }
    const tools = [
      { name: 'read', description: 'Read', input_schema: { type: 'object' } },
      { name: 'bash', description: 'Bash', input_schema: { type: 'object' } },
    ]
    for await (const _ of streamChatAnthropic({ ...base, tools, cache: true }, fetcher)) void _

    const body = JSON.parse(String(box.body)) as {
      system: { type: string; text: string; cache_control?: unknown }[]
      tools: { name: string; cache_control?: unknown }[]
    }
    expect(body.system).toEqual([
      { type: 'text', text: 'you are terse', cache_control: { type: 'ephemeral' } },
    ])
    expect(body.tools.map((t) => t.name)).toEqual(['read', 'bash'])
    expect(body.tools[0]?.cache_control).toBeUndefined()
    expect(body.tools[1]?.cache_control).toEqual({ type: 'ephemeral' })
  })

  it('leaves an uncached request with a plain string system and no cache markers', async () => {
    const box: { body?: string } = {}
    const fetcher: SseFetch = async (_url, init) => {
      box.body = String(init.body as string)
      return {
        body: (async function* () {
          yield 'data: {"type":"message_stop"}'
        })(),
        status: 200,
        statusText: 'OK',
      }
    }
    const tools = [{ name: 'read', description: 'Read', input_schema: { type: 'object' } }]
    for await (const _ of streamChatAnthropic({ ...base, tools }, fetcher)) void _

    const body = JSON.parse(String(box.body)) as {
      system: string | unknown[]
      tools: { cache_control?: unknown }[]
    }
    expect(body.system).toBe('you are terse')
    expect(body.tools[0]?.cache_control).toBeUndefined()
  })

  it('sends staged images as base64 image blocks', async () => {
    const box: { body?: string } = {}
    const fetcher: SseFetch = async (_url, init) => {
      box.body = String(init.body as string)
      return {
        body: (async function* () {
          yield 'data: {"type":"message_stop"}'
        })(),
        status: 200,
        statusText: 'OK',
      }
    }
    for await (const _ of streamChatAnthropic(
      {
        ...base,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'look' },
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGk=' } },
            ],
          },
        ],
      },
      fetcher,
    )) {
      void _
    }
    const body = JSON.parse(String(box.body)) as {
      messages: { role: string; content: unknown }[]
    }
    expect(body.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGk=' } },
        ],
      },
    ])
  })
})
