import { describe, expect, it } from 'vitest'
import { streamChatOllama, type NdjsonFetch } from './ollama'

function ndjsonFrom(lines: string[]): NdjsonFetch {
  return async () => ({
    body: (async function* () {
      for (const line of lines) yield line
    })(),
    status: 200,
    statusText: 'OK',
  })
}

const base = {
  baseUrl: 'http://localhost:11434',
  model: 'llama-test',
  messages: [
    { role: 'system' as const, content: 'you are terse' },
    { role: 'user' as const, content: 'hi' },
  ],
}

describe('ollama chat streaming client', () => {
  it('streams text deltas and usage from the final done line', async () => {
    const events = []
    for await (const e of streamChatOllama(
      base,
      ndjsonFrom([
        '{"message":{"content":"he"}}',
        '{"message":{"content":"llo"}}',
        '{"message":{"content":""},"done":true,"prompt_eval_count":9,"eval_count":4}',
      ]),
    )) {
      events.push(e)
    }
    expect(events.map((e) => e.type)).toEqual(['text-delta', 'text-delta', 'usage', 'done'])
    if (events[2]?.type === 'usage') {
      expect(events[2].inputTokens).toBe(9)
      expect(events[2].outputTokens).toBe(4)
    }
  })

  it('surfaces HTTP errors as error + done', async () => {
    const fetcher: NdjsonFetch = async () => ({
      body: null,
      status: 500,
      statusText: 'Internal Server Error',
    })
    const events = []
    for await (const e of streamChatOllama(base, fetcher)) events.push(e)
    expect(events.map((e) => e.type)).toEqual(['error', 'done'])
    if (events[0]?.type === 'error') expect(events[0].message).toContain('500')
  })

  it('surfaces network failures as error + done', async () => {
    const fetcher: NdjsonFetch = async () => {
      throw new Error('ECONNREFUSED')
    }
    const events = []
    for await (const e of streamChatOllama(base, fetcher)) events.push(e)
    expect(events.map((e) => e.type)).toEqual(['error', 'done'])
  })

  it('tolerates malformed lines without dying', async () => {
    const events = []
    for await (const e of streamChatOllama(
      base,
      ndjsonFrom([
        '{oops',
        '{"message":{"content":"ok"}}',
        '{"done":true,"prompt_eval_count":1,"eval_count":1}',
      ]),
    )) {
      events.push(e)
    }
    expect(events.filter((e) => e.type === 'text-delta')).toHaveLength(1)
  })

  it('still reports usage + done when the stream ends without a done line', async () => {
    const events = []
    for await (const e of streamChatOllama(base, ndjsonFrom(['{"message":{"content":"hi"}}']))) {
      events.push(e)
    }
    expect(events.map((e) => e.type)).toEqual(['text-delta', 'usage', 'done'])
  })

  it('sends model, string messages and stream flag in the request body', async () => {
    const box: { url: string; init?: RequestInit } = { url: '' }
    const fetcher: NdjsonFetch = async (url, init) => {
      box.url = url
      box.init = init
      return {
        body: (async function* () {
          yield '{"done":true}'
        })(),
        status: 200,
        statusText: 'OK',
      }
    }
    for await (const _ of streamChatOllama({ ...base, apiKey: 'tok-123' }, fetcher)) void _
    expect(box.url).toBe('http://localhost:11434/api/chat')
    const headers = (box.init?.headers ?? {}) as Record<string, string>
    expect(headers['authorization']).toBe('Bearer tok-123')
    const body = JSON.parse(String(box.init?.body as string)) as {
      model: string
      messages: { role: string; content: string }[]
      stream: boolean
    }
    expect(body.model).toBe('llama-test')
    expect(body.stream).toBe(true)
    expect(body.messages).toEqual([
      { role: 'system', content: 'you are terse' },
      { role: 'user', content: 'hi' },
    ])
  })

  it('passes staged images as native image payloads', async () => {
    const box: { body?: string } = {}
    const fetcher: NdjsonFetch = async (_url, init) => {
      box.body = String(init.body as string)
      return {
        body: (async function* () {
          yield '{"done":true}'
        })(),
        status: 200,
        statusText: 'OK',
      }
    }
    for await (const _ of streamChatOllama(
      {
        ...base,
        messages: [
          { role: 'user', content: 'look', images: [{ dataBase64: 'aGk=', mimeType: 'image/png' }] },
        ],
      },
      fetcher,
    )) {
      void _
    }
    const body = JSON.parse(String(box.body)) as {
      messages: { role: string; content: string; images?: string[] }[]
    }
    expect(body.messages).toEqual([{ role: 'user', content: 'look', images: ['aGk='] }])
  })
})
