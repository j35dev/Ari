import { describe, expect, it, vi } from 'vitest'
import { href } from './__fixtures__/fake-http'
import { createSseParser, OcHttp, OcHttpError } from './http'

describe('createSseParser', () => {
  it('joins data lines, skips comments, and survives chunks split anywhere', () => {
    const events: string[] = []
    const parse = createSseParser((data) => events.push(data))
    const stream = 'data: {"a":1}\n\n: heartbeat\n\ndata: {"b":\ndata: 2}\r\n\r\nevent: x\n\n'
    for (const char of stream) parse(char)
    expect(events).toEqual(['{"a":1}', '{"b":\n2}'])
  })
})

function sseResponse(chunks: string[], hold = false): Response {
  const encoder = new TextEncoder()
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
        if (!hold) controller.close()
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  )
}

describe('OcHttp', () => {
  it('sends auth, the directory header, and JSON; throws on error statuses', async () => {
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (href(url).endsWith('/missing')) return new Response('nope', { status: 404 })
      return new Response(
        JSON.stringify({ url: href(url), headers: init?.headers, body: init?.body }),
      )
    })
    const http = new OcHttp({ url: 'http://127.0.0.1:1', authorization: 'Basic abc', fetch })
    const echoed = await http.request<{
      url: string
      headers: Record<string, string>
      body: string
    }>('POST', '/session', {
      directory: 'D:\\Projects\\My App',
      body: { x: 1 },
      query: { limit: '2' },
    })
    expect(echoed.url).toBe('http://127.0.0.1:1/session?limit=2')
    expect(echoed.headers).toMatchObject({
      authorization: 'Basic abc',
      'content-type': 'application/json',
      'x-opencode-directory': encodeURIComponent('D:\\Projects\\My App'),
    })
    expect(JSON.parse(echoed.body)).toEqual({ x: 1 })
    const error = await http.request('GET', '/missing').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(OcHttpError)
    expect((error as OcHttpError).status).toBe(404)
  })

  it('resolves an empty body as null', async () => {
    const http = new OcHttp({
      url: 'http://x',
      authorization: 'Basic a',
      fetch: async () => new Response(null, { status: 204 }),
    })
    expect(await http.request('POST', '/abort')).toBeNull()
  })

  it('subscribes once the stream is open and reconnects after it drops', async () => {
    let calls = 0
    const fetch = vi.fn(async () => {
      calls++
      return calls === 1
        ? sseResponse(['data: {"n":1}\n\n'])
        : sseResponse(['data: {"n":2}\n\n'], true)
    })
    const http = new OcHttp({ url: 'http://x', authorization: 'Basic a', fetch })
    const seen: unknown[] = []
    const reconnected = vi.fn()
    const subscription = http.subscribe('/event', (payload) => seen.push(payload), {
      onReconnect: reconnected,
      retryMs: 1,
    })
    await subscription.ready
    await vi.waitFor(() => expect(seen).toEqual([{ n: 1 }, { n: 2 }]))
    expect(reconnected).toHaveBeenCalledTimes(1)
    subscription.close()
  })

  it('fails ready when the stream never opens', async () => {
    const http = new OcHttp({
      url: 'http://x',
      authorization: 'Basic a',
      fetch: async () => new Response('denied', { status: 401 }),
    })
    const subscription = http.subscribe('/event', () => {}, { retryMs: 1 })
    await expect(subscription.ready).rejects.toBeInstanceOf(OcHttpError)
    subscription.close()
  })
})
