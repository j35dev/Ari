import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { AcpAuthRequiredError, AcpConnection, AcpConnectionError, acpPromptStallMs } from './connection'
import type { AcpChildProcess, AcpLaunch } from './connection'

const LAUNCH: AcpLaunch = { label: 'test-agent', command: 'fake', args: [] }

interface FakeChild extends AcpChildProcess {
  readonly sent: Record<string, unknown>[]
  /** Signals the connection escalated to, in order. */
  readonly signals: NodeJS.Signals[]
  stdin: PassThrough
  stdout: PassThrough
  stderr: PassThrough
  killed: boolean
  /** Fires registered exit listeners with the given code and ends stdout. */
  emitClose(code: number | null): void
}

function fakeChild(): FakeChild {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const exitListeners: ((code: number | null) => void)[] = []
  const child: FakeChild = {
    stdin,
    stdout,
    stderr,
    killed: false,
    sent: [],
    signals: [],
    emitClose(code) {
      for (const listener of [...exitListeners]) listener(code)
      stdout.end()
    },
    kill(signal) {
      if (signal !== undefined) child.signals.push(signal)
      if (child.killed) return true
      child.killed = true
      stdin.end()
      stderr.end()
      child.emitClose(null)
      return true
    },
    on(): unknown {
      return child
    },
    onExit(listener: (code: number | null) => void): unknown {
      exitListeners.push(listener)
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

/** Sentinel: the scripted agent never replies to this request (wedge sim). */
export const NO_REPLY = Symbol('no-reply')

/**
 * Scripts the fake agent: every incoming client request is answered through
 * `handler`; returning `undefined` answers with a method-not-found error;
 * returning `NO_REPLY` sends nothing at all.
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
          if (result === NO_REPLY) {
            // Total silence — the agent wedge signature.
          } else if (result !== undefined) {
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

  it('sends staged images as image blocks after the text', async () => {
    const child = fakeChild()
    script(child, STANDARD_AGENT)
    const connection = await AcpConnection.connect({ launch: LAUNCH, cwd: '/w', spawn: () => child })
    const created = await connection.newSession('/w')
    const stopReason = await connection.prompt(created.sessionId as string, 'look', {
      images: [{ data: 'aGk=', mimeType: 'image/png' }],
    })
    expect(stopReason).toBe('end_turn')
    const promptRequest = child.sent.find((m) => m['method'] === 'session/prompt') as
      | { params?: { prompt?: { type: string; text?: string; data?: string; mimeType?: string }[] } }
      | undefined
    expect(promptRequest?.params?.prompt).toEqual([
      { type: 'text', text: 'look' },
      { type: 'image', data: 'aGk=', mimeType: 'image/png' },
    ])
    connection.kill()
  })

  it('loadSession sends the resume frame and echoes the session id even with an empty body', async () => {
    // Spec: session/load's response body is null; the agent re-attaches the id.
    const child = fakeChild()
    script(child, (method) => {
      if (method === 'initialize') return { protocolVersion: 1, agentCapabilities: { loadSession: true } }
      if (method === 'session/load') return null
      return undefined
    })
    const connection = await AcpConnection.connect({ launch: LAUNCH, cwd: '/w', spawn: () => child })

    const resumed = await connection.loadSession('sess_old', '/next')
    expect(resumed.sessionId).toBe('sess_old')
    const load = child.sent.find((m) => m['method'] === 'session/load') as
      | { params?: Record<string, unknown> }
      | undefined
    expect(load?.params).toEqual({ sessionId: 'sess_old', cwd: '/next', mcpServers: [] })
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

  it('bridges elicitation/create through onClientRequest as a JSON-RPC success', async () => {
    const child = fakeChild()
    script(child, STANDARD_AGENT)
    const connection = await AcpConnection.connect({ launch: LAUNCH, cwd: '/w', spawn: () => child })
    connection.onClientRequest = async () => ({ action: 'accept', content: { strategy: 'balanced' } })
    child.stdout.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 43,
        method: 'elicitation/create',
        params: { mode: 'form', message: 'pick' },
      })}\n`,
    )
    await drain()
    const reply = child.sent.find((m) => m['id'] === 43 && m['method'] === undefined)
    expect(reply).toMatchObject({
      id: 43,
      result: { action: 'accept', content: { strategy: 'balanced' } },
    })
    connection.kill()
  })

  it('resumeSession sends session/resume and echoes the session id', async () => {
    const child = fakeChild()
    script(child, (method) => {
      if (method === 'initialize') {
        return { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: true } } }
      }
      if (method === 'session/resume') return null
      return undefined
    })
    const connection = await AcpConnection.connect({ launch: LAUNCH, cwd: '/w', spawn: () => child })
    const resumed = await connection.resumeSession('sess_old', '/next')
    expect(resumed.sessionId).toBe('sess_old')
    const resume = child.sent.find((m) => m['method'] === 'session/resume') as
      | { params?: Record<string, unknown> }
      | undefined
    expect(resume?.params).toEqual({ sessionId: 'sess_old', cwd: '/next', mcpServers: [] })
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

  it('fails the prompt legibly when the agent goes totally silent mid-turn', async () => {
    const child = fakeChild()
    // Answers everything EXCEPT session/prompt, which it never replies to —
    // the wedge signature.
    script(child, (method) =>
      method === 'session/new'
        ? { sessionId: 'sess_wedge' }
        : method === 'session/prompt'
          ? NO_REPLY
          : { ok: true },
    )
    const connection = await AcpConnection.connect({ launch: LAUNCH, cwd: '/w', spawn: () => child })
    const created = await connection.newSession('/w')
    await expect(
      connection.prompt(created.sessionId as string, 'hello?', { stallSilenceMs: 120 }),
    ).rejects.toThrow(/went silent for (120ms|0s).*wedged or waiting for login/s)
    expect(child.killed).toBe(false)
    connection.kill()
  })

  it('does not fail a silent prompt while the agent waits on a parked user question', async () => {
    const child = fakeChild()
    const promptIds: number[] = []
    script(child, (method, _params, id) => {
      if (method === 'session/new') return { sessionId: 'sess_park' }
      if (method === 'session/prompt') {
        // Answered manually below, only after the user responds — however
        // long that takes.
        promptIds.push(id as number)
        return NO_REPLY
      }
      return { ok: true }
    })
    const connection = await AcpConnection.connect({ launch: LAUNCH, cwd: '/w', spawn: () => child })
    const created = await connection.newSession('/w')
    let resolvePermission: ((outcome: unknown) => void) | undefined
    connection.onRequestPermission = () =>
      new Promise((resolve) => {
        resolvePermission = resolve
      })
    const promptPromise = connection.prompt(created.sessionId as string, 'do work', {
      stallSilenceMs: 120,
    })
    await drain()
    // The agent parks a permission request and goes quiet well past the
    // stall ceiling — silence while waiting on the user must not fail.
    child.stdout.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 99,
        method: 'session/request_permission',
        params: { sessionId: created.sessionId, options: [{ optionId: 'allow_once', name: 'Allow', kind: 'allow_once' }] },
      })}\n`,
    )
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(promptIds.length).toBe(1)
    // User finally answers; the agent completes the turn.
    resolvePermission?.({ outcome: { outcome: 'selected', optionId: 'allow_once' } })
    await drain()
    child.stdout.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: promptIds[0], result: { stopReason: 'end_turn' } })}\n`,
    )
    await expect(promptPromise).resolves.toBe('end_turn')
    connection.kill()
  })

  it('decodes npm fatal exits when an npx-launched adapter dies at startup', async () => {
    const child = fakeChild()
    // Never answers the handshake — npm died before the agent started.
    script(child, (method) => (method === 'initialize' ? NO_REPLY : { ok: true }))
    const connectionPromise = AcpConnection.connect({
      launch: { ...LAUNCH, viaNpx: true },
      cwd: '/w',
      spawn: () => child,
      initializeTimeoutMs: 5000,
    })
    // npm's silent ENOENT death (exit 254).
    child.emitClose(254)
    await expect(connectionPromise).rejects.toThrow(
      /initialization failed.*exit 254.*npx failed before the agent started/s,
    )
  })

  it('advertises the terminal-auth capability so agents offer their logins', async () => {
    const child = fakeChild()
    script(child, STANDARD_AGENT)
    const connection = await AcpConnection.connect({ launch: LAUNCH, cwd: '/w', spawn: () => child })
    const initialize = child.sent[0] as {
      params?: { clientCapabilities?: { _meta?: Record<string, unknown> } }
    }
    expect(initialize.params?.clientCapabilities?._meta).toEqual({ 'terminal-auth': true })
    connection.kill()
  })

  it('rejects auth walls with the logins the agent advertised', async () => {
    const child = fakeChild()
    script(child, (method, _params, id) => {
      if (method === 'initialize') {
        return {
          protocolVersion: 1,
          authMethods: [
            {
              id: 'claude-ai-login',
              name: 'Claude Subscription',
              type: 'terminal',
              _meta: { 'terminal-auth': { command: 'node', args: ['acp.js', '--cli', 'auth', 'login'] } },
            },
          ],
        }
      }
      if (method === 'session/new') {
        child.stdout.write(
          `${JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message: 'authRequired' } })}\n`,
        )
        return undefined
      }
      return undefined
    })
    const connection = await AcpConnection.connect({ launch: LAUNCH, cwd: '/w', spawn: () => child })
    expect(connection.terminalLogins.map((l) => l.methodId)).toEqual(['claude-ai-login'])

    const failure = await connection.newSession('/w').catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(AcpAuthRequiredError)
    const authError = failure as AcpAuthRequiredError
    expect(authError.code).toBe(-32000)
    expect(authError.message).toBe('test-agent needs you to sign in again')
    expect(authError.logins[0]?.command).toBe('node')
    connection.kill()
  })

  it('tells the user to log in manually when the agent offers no runnable login', async () => {
    const child = fakeChild()
    script(child, (method, _params, id) => {
      if (method === 'initialize') return { protocolVersion: 1 }
      if (method === 'session/new') {
        child.stdout.write(
          `${JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message: 'authRequired' } })}\n`,
        )
        return undefined
      }
      return undefined
    })
    const connection = await AcpConnection.connect({ launch: LAUNCH, cwd: '/w', spawn: () => child })
    await expect(connection.newSession('/w')).rejects.toThrow(/not authenticated yet — run its login flow/)
    connection.kill()
  })

  it('inbound traffic proves liveness and disarms the stall watchdog', async () => {
    const child = fakeChild()
    script(child, STANDARD_AGENT)
    const connection = await AcpConnection.connect({ launch: LAUNCH, cwd: '/w', spawn: () => child })
    const created = await connection.newSession('/w')
    // Stream updates every 40ms while the (delayed) answer is pending.
    const spam = setInterval(() => {
      child.stdout.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          method: 'session/update',
          params: { sessionId: created.sessionId, update: { sessionUpdate: 'ping' } },
        })}\n`,
      )
    }, 40)
    try {
      const stopReason = await connection.prompt(created.sessionId as string, 'work', {
        stallSilenceMs: 120,
      })
      expect(stopReason).toBe('end_turn')
    } finally {
      clearInterval(spam)
    }
    connection.kill()
  })
})

describe('AcpConnection.shutdown', () => {
  it('ends the transport and settles on the agent exiting by itself', async () => {
    const child = fakeChild()
    script(child, STANDARD_AGENT)
    // A cooperative stdio agent exits when its input closes.
    child.stdin.on('end', () => {
      if (!child.killed) child.kill()
    })
    const connection = await AcpConnection.connect({ launch: LAUNCH, cwd: '/w', spawn: () => child })
    await connection.shutdown()
    expect(connection.closed).toBe(true)
    expect(child.signals).toEqual([])
  })

  it('escalates to SIGTERM when the agent ignores the EOF', async () => {
    const child = fakeChild()
    script(child, STANDARD_AGENT)
    const connection = await AcpConnection.connect({ launch: LAUNCH, cwd: '/w', spawn: () => child })
    await connection.shutdown()
    expect(child.signals).toEqual(['SIGTERM'])
    expect(child.killed).toBe(true)
  }, 10000)

  it('is a no-op on an already-closed connection', async () => {
    const child = fakeChild()
    script(child, STANDARD_AGENT)
    const connection = await AcpConnection.connect({ launch: LAUNCH, cwd: '/w', spawn: () => child })
    connection.kill()
    await connection.waitClosed()
    child.signals.length = 0
    await connection.shutdown()
    expect(child.signals).toEqual([])
  })
})

describe('acpPromptStallMs', () => {
  it('parses the env knob with sane fallbacks', () => {
    expect(acpPromptStallMs(undefined)).toBe(300_000)
    expect(acpPromptStallMs('')).toBe(300_000)
    expect(acpPromptStallMs('30000')).toBe(30_000)
    expect(acpPromptStallMs('0')).toBe(0)
    expect(acpPromptStallMs('nonsense')).toBe(300_000)
    expect(acpPromptStallMs('-5')).toBe(300_000)
  })
})
