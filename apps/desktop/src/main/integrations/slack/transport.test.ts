// @vitest-environment node
import { WebSocketServer, type WebSocket } from 'ws'
import { WebClient } from '@slack/web-api'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createSlackTransport,
  SlackTransportError,
  type SlackEnvelope,
  type SlackTransport,
} from './transport'

let server: WebSocketServer
let peer: WebSocket | null
let transport: SlackTransport
let acknowledgements: string[]
let calls: { method: string; options: unknown }[]

beforeEach(async () => {
  server = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  await new Promise<void>((resolve) => server.once('listening', resolve))
  const address = server.address()
  if (typeof address === 'string' || address === null)
    throw new Error('Expected a loopback fixture port')
  peer = null
  acknowledgements = []
  calls = []
  server.on('connection', (socket) => {
    peer = socket
    socket.on('message', (data) => acknowledgements.push(data.toString()))
    socket.send(JSON.stringify({ type: 'hello', num_connections: 1 }))
  })
  vi.spyOn(WebClient.prototype, 'apiCall').mockImplementation((method, options) => {
    calls.push({ method, options })
    if (method === 'auth.test')
      return Promise.resolve({
        ok: true,
        team_id: 'TTEAM123',
        team: 'Fixture',
        user_id: 'UBOT123',
        bot_id: 'BBOT123',
        app_id: 'AAPP123',
      })
    if (method === 'apps.connections.open')
      return Promise.resolve({ ok: true, url: `ws://127.0.0.1:${address.port}` })
    if (method === 'chat.postMessage' || method === 'chat.update')
      return Promise.resolve({ ok: true, ts: '1.000001' })
    return Promise.reject(new Error(`Unexpected fixture API call: ${method}`))
  })
  transport = createSlackTransport('xoxb-fixture-token', 'xapp-fixture-token')
})
afterEach(async () => {
  await transport.close()
  for (const socket of server.clients) socket.terminate()
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  )
  vi.restoreAllMocks()
})

describe('official Slack SDK transport', () => {
  it('acknowledges an actual Socket Mode envelope only after the application accepts it', async () => {
    let accept!: () => void
    const accepted = new Promise<void>((resolve) => {
      accept = resolve
    })
    const received: SlackEnvelope[] = []
    const states: string[] = []
    await transport.start(
      async (envelope) => {
        received.push(envelope)
        await accepted
      },
      (state) => states.push(state),
    )
    expect(states).toContain('connected')
    peer!.send(
      JSON.stringify({
        type: 'events_api',
        envelope_id: 'fixture-envelope',
        accepts_response_payload: false,
        payload: {
          type: 'event_callback',
          team_id: 'TTEAM123',
          api_app_id: 'AAPP123',
          event_id: 'Ev1',
          event: {
            type: 'app_mention',
            user: 'UOWNER123',
            channel: 'CROOM123',
            text: '<@UBOT123> a task',
            ts: '1.000001',
          },
        },
      }),
    )
    await expect.poll(() => received.length, { timeout: 5000 }).toBe(1)
    expect(acknowledgements).toHaveLength(0)
    accept()
    await expect.poll(() => acknowledgements.length, { timeout: 5000 }).toBe(1)
    expect(JSON.parse(acknowledgements[0]!)).toMatchObject({ envelope_id: 'fixture-envelope' })
    expect(received[0]).toMatchObject({ type: 'events_api', envelopeId: 'fixture-envelope' })
  })

  it('uses bot identity and escapes mentions in messages sent through the real SDK client', async () => {
    expect(await transport.identity()).toEqual({
      workspaceId: 'TTEAM123',
      workspaceName: 'Fixture',
      botUserId: 'UBOT123',
      appId: 'AAPP123',
    })
    await transport.post('CROOM123', '1.000001', { text: 'Hello <@UOTHER123> & <!channel>' })
    const request = calls.find((call) => call.method === 'chat.postMessage')
    expect(request?.options).toMatchObject({
      channel: 'CROOM123',
      thread_ts: '1.000001',
      text: 'Hello &lt;@UOTHER123&gt; &amp; &lt;!channel&gt;',
      parse: 'none',
      mrkdwn: false,
      unfurl_links: false,
      unfurl_media: false,
    })
    await transport.update('CROOM123', '1.000001', { text: 'Finished' })
    expect(calls.find((call) => call.method === 'chat.update')?.options).toMatchObject({
      ts: '1.000001',
      blocks: [],
    })
  })

  it('reports an uncertain mutation without retrying or echoing an SDK credential-bearing error', async () => {
    vi.mocked(WebClient.prototype.apiCall).mockRejectedValueOnce(
      new Error('Fixture error with xoxb-fixture-token'),
    )
    const outcome = transport.post('CROOM123', '1.000001', { text: 'Result' })
    await expect(outcome).rejects.toBeInstanceOf(SlackTransportError)
    await expect(outcome).rejects.toMatchObject({ kind: 'uncertain' })
    await expect(outcome).rejects.not.toThrow('xoxb-fixture-token')
    expect(WebClient.prototype.apiCall).toHaveBeenCalledOnce()
  })
})
