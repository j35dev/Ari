import { describe, expect, it } from 'vitest'
import { streamChatCompletion, type SseFetch } from './openai-chat'

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
  baseUrl: 'https://api.example.com/v1',
  apiKey: 'sk-test',
  model: 'test-model',
  messages: [{ role: 'user' as const, content: 'hi' }],
}

describe('openai chat streaming client', () => {
  it('streams text deltas and usage', async () => {
    const events = []
    for await (const e of streamChatCompletion(
      base,
      sseFrom([
        'data: {"choices":[{"delta":{"content":"he"}}]}',
        'data: {"choices":[{"delta":{"content":"llo"}}]}',
        'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2}}',
        'data: [DONE]',
      ]),
    )) {
      events.push(e)
    }
    expect(events.map((e) => e.type)).toEqual([
      'text-delta',
      'text-delta',
      'usage',
      'done',
    ])
    if (events[2]?.type === 'usage') {
      expect(events[2].inputTokens).toBe(5)
      expect(events[2].outputTokens).toBe(2)
    }
  })

  it('accumulates tool-call argument deltas and emits tool-started once parseable', async () => {
    const events = []
    for await (const e of streamChatCompletion(
      base,
      sseFrom([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"bash","arguments":"{\\"co"}}]}}]}',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"mmand\\":\\"ls\\"}"}}]}}]}',
        'data: [DONE]',
      ]),
    )) {
      events.push(e)
    }
    const started = events.find((e) => e.type === 'tool-started')
    if (started?.type === 'tool-started') {
      expect(started.callId).toBe('c1')
      expect(started.name).toBe('bash')
      expect(JSON.parse(started.argsJson)).toEqual({ command: 'ls' })
    } else {
      throw new Error('expected tool-started')
    }
  })

  it('surfaces HTTP errors as error + done', async () => {
    const fetcher: SseFetch = async () => ({ body: null, status: 401, statusText: 'Unauthorized' })
    const events = []
    for await (const e of streamChatCompletion(base, fetcher)) events.push(e)
    expect(events.map((e) => e.type)).toEqual(['error', 'done'])
    if (events[0]?.type === 'error') expect(events[0].message).toContain('401')
  })

  it('surfaces network failures as error + done', async () => {
    const fetcher: SseFetch = async () => {
      throw new Error('ECONNREFUSED')
    }
    const events = []
    for await (const e of streamChatCompletion(base, fetcher)) events.push(e)
    expect(events.map((e) => e.type)).toEqual(['error', 'done'])
  })

  it('tolerates malformed data lines without dying', async () => {
    const events = []
    for await (const e of streamChatCompletion(
      base,
      sseFrom(['data: {oops', 'data: {"choices":[{"delta":{"content":"ok"}}]}', 'data: [DONE]']),
    )) {
      events.push(e)
    }
    expect(events.filter((e) => e.type === 'text-delta')).toHaveLength(1)
  })

  it('sends bearer auth and model in the request body', async () => {
    const box: { url: string; init?: RequestInit } = { url: '' }
    const fetcher: SseFetch = async (url, init) => {
      box.url = url
      box.init = init
      return { body: (async function* () { yield 'data: [DONE]' })(), status: 200, statusText: 'OK' }
    }
    for await (const _ of streamChatCompletion(base, fetcher)) void _
    expect(box.url).toBe('https://api.example.com/v1/chat/completions')
    const headers = (box.init?.headers ?? {}) as Record<string, string>
    expect(headers['authorization']).toBe('Bearer sk-test')
    const body = JSON.parse(String(box.init?.body as string)) as { model: string; stream: boolean }
    expect(body.model).toBe('test-model')
    expect(body.stream).toBe(true)
  })
})
