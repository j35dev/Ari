import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { AcpConnection, AcpConnectionError } from './connection'
import type { AcpChildProcess, AcpLaunch } from './connection'

const LAUNCH: AcpLaunch = { label: 'test-agent', command: 'fake', args: [] }

interface FakeChild extends AcpChildProcess {
  readonly sent: Record<string, unknown>[]
  stdin: PassThrough
  stdout: PassThrough
  stderr: PassThrough
  killed: boolean
}

function fakeChild(): FakeChild {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const child: FakeChild = {
    stdin,
    stdout,
    stderr,
    killed: false,
    sent: [],
    kill() {
      if (child.killed) return true
      child.killed = true
      stdin.end()
      stdout.end()
      stderr.end()
      return true
    },
    on() {
      return child
    },
  }
  let buffer = ''
  stdin.setEncoding('utf8')
  stdin.on('data', (chunk: string) => {
    buffer += chunk
    let index = buffer.indexOf('\n')
    while (index !== -1) {
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      if (line.trim().length > 0) child.sent.push(JSON.parse(line) as Record<string, unknown>)
      index = buffer.indexOf('\n')
    }
  })
  return child
}

type AgentHandler = (
  method: string | undefined,
  params: unknown,
  id: number | undefined,
) => unknown

/**
 * Scripts the fake agent: every incoming client request is answered through
 * `handler`; returning `undefined` answers with a method-not-found error.
 */
function script(child: FakeChild, handler: AgentHandler): void {
  let buffer = ''
  child.stdin.setEncoding('utf8')
  child.stdin.on('data', (chunk: string) => {
    buffer += chunk
    let index = buffer.indexOf('\n')
    while (index !== -1) {
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      if (line.trim().length > 0) {
        const message = JSON.parse(line) as {
          id?: number
          method?: string
          params?: unknown
        }
        if (message.method !== undefined && message.id !== undefined) {
          const result = handler(message.method, message.params, message.id)
          if (result !== undefined) {
            child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`)
          } else {
            child.stdout.write(
              `${JSON.stringify({
                jsonrpc: '2.0',
                id: message.id,
                error: { code: -32601, message: 'not implemented' },
              })}\n`,
            )
          }
        }
      }
      index = buffer.indexOf('\n')
    }
  })
}

const STANDARD_AGENT: AgentHandler = (method) => {
  if (method === 'initialize') return { protocolVersion: 1, agentInfo: { name: 'TestAgent', version: '1.2.3' } }
  if (method === 'session/new') return { sessionId: 'sess_9' }
  if (method === 'session/prompt') return { stopReason: 'end_turn' }
  return undefined
}

async function drain(ms = 15): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

describe('AcpConnection', () => {
  it('completes the initialize handshake and exposes agent info', async () => {
    const child = fakeChild()
    script(child, STANDARD_AGENT)
    const connection = await AcpConnection.connect({ launch: LAUNCH, cwd: '/w', spawn: () => child })
    expect(connection.initialize.agentInfo?.name).toBe('TestAgent')

    const created = await connection.newSession('/w')
    expect(created.sessionId).toBe('sess_9')
    expect(child.sent[0]?.['method']).toBe('initialize')
    expect(child.sent[1]?.['method']).toBe('session/new')
    connection.kill()
    expect(child.killed).toBe(true)
  })

  it('sends prompts as text content blocks and resolves the stop reason', async () => {
    const child = fakeChild()
    script(child, STANDARD_AGENT)
    const connection = await AcpConnection.connect({ launch: LAUNCH, cwd: '/w', spawn: () => child })
    const created = await connection.newSession('/w')
    const stopReason = await connection.prompt(created.sessionId as string, 'do things')
    expect(stopReason).toBe('end_turn')
    const promptRequest = child.sent.find((m) => m['method'] === 'session/prompt') as
      | { params?: { prompt?: { type: string; text: string }[] } }
      | undefined
    expect(promptRequest?.params?.prompt?.[0]).toEqual({ type: 'text', text: 'do things' })
    connection.kill()
  })

  it('routes session/update notifications to the hook', async () => {
    const child = fakeChild()
    script(child, STANDARD_AGENT)
    const connection = await AcpConnection.connect({ launch: LAUNCH, cwd: '/w', spawn: () => child })
    const seen: unknown[] = []
    connection.onSessionUpdate = (notification) => seen.push(notification)
    child.stdout.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 's',
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } },
        },
      })}\n`,
    )
    await drain()
    expect(seen.length).toBe(1)
    connection.kill()
  })

  it('bridges server permission requests through the handler', async () => {
    const child = fakeChild()
    script(child, STANDARD_AGENT)
    const connection = await AcpConnection.connect({ launch: LAUNCH, cwd: '/w', spawn: () => child })
    connection.onRequestPermission = async () => ({
      outcome: { outcome: 'selected', optionId: 'allow_once' },
    })
    child.stdout.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 42,
        method: 'session/request_permission',
        params: { sessionId: 's', options: [{ optionId: 'allow_once', name: 'Allow', kind: 'allow_once' }] },
      })}\n`,
    )
    await drain()
    const reply = child.sent.find((m) => m['id'] === 42 && m['method'] === undefined)
    expect(reply).toMatchObject({ id: 42, result: { outcome: { outcome: 'selected', optionId: 'allow_once' } } })
    connection.kill()
  })

  it('answers unadvertised client methods with method-not-found', async () => {
    const child = fakeChild()
    script(child, STANDARD_AGENT)
    const connection = await AcpConnection.connect({ launch: LAUNCH, cwd: '/w', spawn: () => child })
    child.stdout.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'fs/read_text_file', params: { path: '/x' } })}\n`,
    )
    await drain()
    const reply = child.sent.find((m) => m['id'] === 7)
    expect(reply?.['error']).toMatchObject({ code: -32601 })
    connection.kill()
  })

  it('fails with a legible error when the agent never initializes', async () => {
    const child = fakeChild()
    await expect(
      AcpConnection.connect({
        launch: LAUNCH,
        cwd: '/w',
        initializeTimeoutMs: 30,
        spawn: () => child,
      }),
    ).rejects.toBeInstanceOf(AcpConnectionError)
  })

  it('fails when the spawned binary does not exist', async () => {
    await expect(
      AcpConnection.connect({
        launch: { label: 'missing', command: 'ari-no-such-bin-xyz', args: [] },
        cwd: '/w',
        initializeTimeoutMs: 2000,
      }),
    ).rejects.toThrow(/missing/)
  })
})
