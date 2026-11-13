import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AcpAuthRequiredError,
  AcpConnection,
  AcpConnectionError,
  acpPromptStallMs,
} from './connection'
import type { AcpChildProcess, AcpLaunch } from './connection'
import { probeSessionMeta } from './launches'

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

type AgentHandler = (method: string | undefined, params: unknown, id: number | undefined) => unknown

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
  if (method === 'initialize')
    return { protocolVersion: 1, agentInfo: { name: 'TestAgent', version: '1.2.3' } }
  if (method === 'session/new') return { sessionId: 'sess_9' }
  if (method === 'session/prompt') return { stopReason: 'end_turn' }
  return undefined
}

async function drain(ms = 15): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

describe('AcpConnection', () => {
  it('bounds a usage prompt even when the agent never answers', async () => {
    const child = fakeChild()
    script(child, (method, params, id) =>
      method === 'session/prompt' ? NO_REPLY : STANDARD_AGENT(method, params, id),
    )
    const connection = await AcpConnection.connect({ launch: LAUNCH, cwd: '/', spawn: () => child })
    try {
      await expect(
        connection.prompt('probe', '/usage', { timeoutMs: 25, stallSilenceMs: 0 }),
      ).rejects.toThrow('timed out after 25ms')
    } finally {
      await connection.shutdown()
    }
  })

  it('fails a prompt at once when the agent logs an exhausted usage limit', async () => {
    const child = fakeChild()
    // OpenCode: the prompt is never answered, it retries quietly, and the
    // reason only reaches stderr.
    script(child, (method, params, id) =>
      method === 'session/prompt' ? NO_REPLY : STANDARD_AGENT(method, params, id),
    )
    const connection = await AcpConnection.connect({ launch: LAUNCH, cwd: '/', spawn: () => child })
    try {
      const prompt = connection.prompt('sess_9', 'hi', { stallSilenceMs: 60_000 })
      await drain()
      const line =
        'timestamp=2026-11-13T08:26:38.683Z level=ERROR run=14f93b49 message="stream error" providerID=opencode modelID=deepseek-v4.1-flash-free agent=build error.error="AI_APICallError: Free usage limit reached. Subscribe to OpenCode Go to keep going: https://opencode.ai/go"\n'
      // Split across chunks, as a pipe may deliver it.
      child.stderr.write(line.slice(0, 60))
      child.stderr.write(line.slice(60))
      await expect(prompt).rejects.toThrow(
        'Free usage limit reached. Subscribe to OpenCode Go to keep going: https://opencode.ai/go',
      )
      await drain()
      expect(child.sent).toContainEqual(
        expect.objectContaining({ method: 'session/cancel', params: { sessionId: 'sess_9' } }),
      )
    } finally {
      await connection.shutdown()
    }
  })

  it("names the agent's last error when a silent prompt stalls", async () => {
    const child = fakeChild()
    script(child, (method, params, id) =>
      method === 'session/prompt' ? NO_REPLY : STANDARD_AGENT(method, params, id),
    )
    const connection = await AcpConnection.connect({ launch: LAUNCH, cwd: '/', spawn: () => child })
    try {
      const prompt = connection.prompt('sess_9', 'hi', { stallSilenceMs: 120 })
      child.stderr.write(
        'level=ERROR service=provider message="request failed" error="upstream returned 503"\n',
      )
      await expect(prompt).rejects.toThrow(
        'The agent stopped responding. Its last error: upstream returned 503',
      )
    } finally {
      await connection.shutdown()
    }
  })

  it('reads namespaced billing extensions through the response multiplexer', async () => {
    const child = fakeChild()
    script(child, (method, params, id) =>
      method === '_x.ai/billing'
        ? { config: { creditUsagePercent: 23 } }
        : STANDARD_AGENT(method, params, id),
    )
    const connection = await AcpConnection.connect({ launch: LAUNCH, cwd: '/', spawn: () => child })
    try {
      await expect(connection.requestExtension('_x.ai/billing', {})).resolves.toEqual({
        config: { creditUsagePercent: 23 },
      })
    } finally {
      await connection.shutdown()
    }
  })

  it('passes launch overrides and inherited environment to the real child', async () => {
    const connection = await AcpConnection.connect({
      cwd: process.cwd(),
      // A full runtime env with a stale CODEX_PATH must not beat the launch.
      runtimeEnv: { ...process.env, CODEX_PATH: '/stale/codex' },
      launch: {
        label: 'environment fixture',
        command: process.execPath,
        env: { CODEX_PATH: '/fixture/CLI with spaces/codex' },
        args: [
          '-e',
          `
          require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
            const message = JSON.parse(line);
            if (message.method === 'initialize') {
              console.log(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {
                protocolVersion: 1,
                agentInfo: { name: process.env.CODEX_PATH, version: process.env.PATH ?? process.env.Path }
              } }));
            }
          });
        `,
        ],
      },
    })
    try {
      expect(connection.initialize.agentInfo?.name).toBe('/fixture/CLI with spaces/codex')
      expect(connection.initialize.agentInfo?.version).toBe(
        process.env['PATH'] ?? process.env['Path'],
      )
    } finally {
      await connection.shutdown()
    }
  })

  it('completes the initialize handshake and exposes agent info', async () => {
    const child = fakeChild()
    script(child, STANDARD_AGENT)
    const connection = await AcpConnection.connect({
      launch: LAUNCH,
      cwd: '/w',
      spawn: () => child,
    })
    expect(connection.initialize.agentInfo?.name).toBe('TestAgent')

    const created = await connection.newSession('/w')
    expect(created.sessionId).toBe('sess_9')
    expect(child.sent[0]?.['method']).toBe('initialize')
    expect(child.sent[1]?.['method']).toBe('session/new')
    connection.kill()
    expect(child.killed).toBe(true)
  })

  it('sends the session meta with every way of opening a session, and none by default', async () => {
    const sessionMeta = { systemPrompt: { append: 'You are running inside Ari.' } }
    const child = fakeChild()
    script(child, STANDARD_AGENT)
    const connection = await AcpConnection.connect({
      launch: LAUNCH,
      cwd: '/w',
      spawn: () => child,
      sessionMeta,
    })
    await connection.newSession('/w')
    await connection.loadSession('sess_9', '/w').catch(() => undefined)
    await connection.resumeSession('sess_9', '/w').catch(() => undefined)
    const opens = child.sent.filter((m) => String(m['method']).startsWith('session/')) as {
      method: string
      params?: { _meta?: unknown; sessionId?: string }
    }[]
    expect(opens.map((m) => m.method)).toEqual(['session/new', 'session/load', 'session/resume'])
    for (const open of opens) expect(open.params?._meta).toEqual(sessionMeta)
    expect(opens[1]?.params?.sessionId).toBe('sess_9')
    connection.kill()

    const plain = fakeChild()
    script(plain, STANDARD_AGENT)
    const bare = await AcpConnection.connect({ launch: LAUNCH, cwd: '/w', spawn: () => plain })
    await bare.newSession('/w')
    const created = plain.sent.find((m) => m['method'] === 'session/new') as
      { params?: Record<string, unknown> } | undefined
    expect(created?.params && '_meta' in created.params).toBe(false)
    bare.kill()
  })

  it.each(['claude', 'codex'] as const)(
    'opens a %s background probe over stdio with the appropriate MCP policy',
    async (kind) => {
      const connection = await AcpConnection.connect({
        cwd: process.cwd(),
        sessionMeta: probeSessionMeta(kind),
        launch: {
          label: 'background discovery fixture',
          command: process.execPath,
          args: [
            '-e',
            `
          require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
            const message = JSON.parse(line);
            let result;
            if (message.method === 'initialize') result = { protocolVersion: 1 };
            if (message.method === 'session/new') {
              const params = message.params;
              result = { sessionId: params._meta?.claudeCode?.options?.strictMcpConfig === true ? 'isolated' : 'ordinary',
                configOptions: [{ category: 'model', type: 'select', id: 'model', name: 'Model',
                  currentValue: 'fixture', options: [{ value: 'fixture', name: 'Fixture' }] }] };
              if (params.mcpServers.length !== 0) throw new Error('Probe received client MCP servers');
            }
            if (result) console.log(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
          });
        `,
          ],
        },
      })
      try {
        const session = await connection.newSession(process.cwd())
        expect(session.sessionId).toBe(kind === 'claude' ? 'isolated' : 'ordinary')
        expect(session.configOptions?.[0]?.currentValue).toBe('fixture')
      } finally {
        await connection.shutdown()
      }
    },
  )

  it('hands HTTP MCP servers to session/new unless the agent opted out', async () => {
    const httpServer = {
      type: 'http' as const,
      name: 'ari-browser',
      url: 'http://127.0.0.1:9/mcp',
      headers: [{ name: 'Authorization', value: 'Bearer t' }],
    }
    const withHttp = fakeChild()
    script(withHttp, (method) => {
      if (method === 'initialize') {
        return {
          protocolVersion: 1,
          agentCapabilities: { mcpCapabilities: { http: true } },
        }
      }
      if (method === 'session/new') return { sessionId: 'sess_mcp' }
      return undefined
    })
    const httpConn = await AcpConnection.connect({
      launch: LAUNCH,
      cwd: '/w',
      spawn: () => withHttp,
      mcpServers: [httpServer],
    })
    await httpConn.newSession('/w')
    const created = withHttp.sent.find((m) => m['method'] === 'session/new') as
      { params?: { mcpServers?: unknown[] } } | undefined
    expect(created?.params?.mcpServers).toEqual([httpServer])
    httpConn.kill()

    const implied = fakeChild()
    script(implied, STANDARD_AGENT)
    const impliedConn = await AcpConnection.connect({
      launch: LAUNCH,
      cwd: '/w',
      spawn: () => implied,
      mcpServers: [httpServer],
    })
    await impliedConn.newSession('/w')
    const impliedNew = implied.sent.find((m) => m['method'] === 'session/new') as
      { params?: { mcpServers?: unknown[] } } | undefined
    // No `mcpCapabilities.http` means the agent did not advertise HTTP.
    expect(impliedNew?.params?.mcpServers).toEqual([])
    impliedConn.kill()

    const optedOut = fakeChild()
    script(optedOut, (method) => {
      if (method === 'initialize') {
        return { protocolVersion: 1, agentCapabilities: { mcpCapabilities: { http: false } } }
      }
      if (method === 'session/new') return { sessionId: 'sess_no_http' }
      return undefined
    })
    const opted = await AcpConnection.connect({
      launch: LAUNCH,
      cwd: '/w',
      spawn: () => optedOut,
      mcpServers: [httpServer],
    })
    await opted.newSession('/w')
    const skipped = optedOut.sent.find((m) => m['method'] === 'session/new') as
      { params?: { mcpServers?: unknown[] } } | undefined
    expect(skipped?.params?.mcpServers).toEqual([])
    opted.kill()
  })

  it('always forwards stdio MCP servers so the in-app browser reaches every agent', async () => {
    const stdioServer = {
      name: 'ari-browser',
      command: '/bin/proxy',
      args: ['/tmp/proxy.mjs'],
      env: [{ name: 'ARI_BROWSER_MCP_URL', value: 'http://127.0.0.1:9/mcp' }],
    }
    const child = fakeChild()
    script(child, STANDARD_AGENT)
    const connection = await AcpConnection.connect({
      launch: LAUNCH,
      cwd: '/w',
      spawn: () => child,
      mcpServers: [stdioServer],
    })
    await connection.newSession('/w')
    const created = child.sent.find((m) => m['method'] === 'session/new') as
      { params?: { mcpServers?: unknown[] } } | undefined
    expect(created?.params?.mcpServers).toEqual([stdioServer])
    connection.kill()
  })

  it('sends HTTP MCP only when advertised, and stdio otherwise', async () => {
    const httpServer = {
      type: 'http' as const,
      name: 'ari-browser',
      url: 'http://127.0.0.1:9/mcp',
      headers: [{ name: 'Authorization', value: 'Bearer t' }],
    }
    const stdioServer = {
      name: 'ari-browser',
      command: '/bin/proxy',
      args: ['/tmp/proxy.mjs'],
    }
    const both = [httpServer, stdioServer]
    const httpChild = fakeChild()
    script(httpChild, (method) => {
      if (method === 'initialize') {
        return { protocolVersion: 1, agentCapabilities: { mcpCapabilities: { http: true } } }
      }
      if (method === 'session/new') return { sessionId: 'sess_http' }
      return undefined
    })
    const httpConn = await AcpConnection.connect({
      launch: LAUNCH,
      cwd: '/w',
      spawn: () => httpChild,
      mcpServers: both,
    })
    await httpConn.newSession('/w')
    const httpNew = httpChild.sent.find((m) => m['method'] === 'session/new') as
      { params?: { mcpServers?: unknown[] } } | undefined
    expect(httpNew?.params?.mcpServers).toEqual([httpServer])
    httpConn.kill()

    const stdioChild = fakeChild()
    script(stdioChild, STANDARD_AGENT)
    const stdioConn = await AcpConnection.connect({
      launch: LAUNCH,
      cwd: '/w',
      spawn: () => stdioChild,
      mcpServers: both,
    })
    await stdioConn.newSession('/w')
    const stdioNew = stdioChild.sent.find((m) => m['method'] === 'session/new') as
      { params?: { mcpServers?: unknown[] } } | undefined
    expect(stdioNew?.params?.mcpServers).toEqual([stdioServer])
    stdioConn.kill()
  })

  it('sends prompts as text content blocks and resolves the stop reason', async () => {
    const child = fakeChild()
    script(child, STANDARD_AGENT)
    const connection = await AcpConnection.connect({
      launch: LAUNCH,
      cwd: '/w',
      spawn: () => child,
    })
    const created = await connection.newSession('/w')
    const stopReason = await connection.prompt(created.sessionId as string, 'do things')
    expect(stopReason).toBe('end_turn')
    const promptRequest = child.sent.find((m) => m['method'] === 'session/prompt') as
      { params?: { prompt?: { type: string; text: string }[] } } | undefined
    expect(promptRequest?.params?.prompt?.[0]).toEqual({ type: 'text', text: 'do things' })
    connection.kill()
  })

  it('sends staged images as image blocks after the text', async () => {
    const child = fakeChild()
    script(child, STANDARD_AGENT)
    const connection = await AcpConnection.connect({
      launch: LAUNCH,
      cwd: '/w',
      spawn: () => child,
    })
    const created = await connection.newSession('/w')
    const stopReason = await connection.prompt(created.sessionId as string, 'look', {
      images: [{ data: 'aGk=', mimeType: 'image/png' }],
    })
    expect(stopReason).toBe('end_turn')
    const promptRequest = child.sent.find((m) => m['method'] === 'session/prompt') as
      | {
          params?: { prompt?: { type: string; text?: string; data?: string; mimeType?: string }[] }
        }
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
      if (method === 'initialize')
        return { protocolVersion: 1, agentCapabilities: { loadSession: true } }
      if (method === 'session/load') return null
      return undefined
    })
    const connection = await AcpConnection.connect({
      launch: LAUNCH,
      cwd: '/w',
      spawn: () => child,
    })

    const resumed = await connection.loadSession('sess_old', '/next')
    expect(resumed.sessionId).toBe('sess_old')
    const load = child.sent.find((m) => m['method'] === 'session/load') as
      { params?: Record<string, unknown> } | undefined
    expect(load?.params).toEqual({ sessionId: 'sess_old', cwd: '/next', mcpServers: [] })
    expect(load?.params).not.toHaveProperty('_meta')
    connection.kill()
  })

  it('sends the browser MCP list on load and resume, and the stdio proxy when HTTP is refused', async () => {
    const httpServer = {
      type: 'http' as const,
      name: 'ari-browser',
      url: 'http://127.0.0.1:9/mcp',
      headers: [{ name: 'Authorization', value: 'Bearer t' }],
    }
    const stdioServer = { name: 'ari-browser', command: 'node', args: ['proxy.js'], env: [] }
    const httpChild = fakeChild()
    script(httpChild, (method) => {
      if (method === 'initialize')
        return { protocolVersion: 1, agentCapabilities: { mcpCapabilities: { http: true } } }
      return null
    })
    const httpConn = await AcpConnection.connect({
      launch: LAUNCH,
      cwd: '/w',
      spawn: () => httpChild,
      mcpServers: [httpServer, stdioServer],
    })
    await httpConn.loadSession('sess_old', '/next')
    await httpConn.resumeSession('sess_old', '/next')
    for (const method of ['session/load', 'session/resume']) {
      const frame = httpChild.sent.find((message) => message['method'] === method) as
        { params?: Record<string, unknown> } | undefined
      expect(frame?.params?.['mcpServers']).toEqual([httpServer])
      expect(frame?.params).not.toHaveProperty('_meta')
    }
    httpConn.kill()

    const stdioChild = fakeChild()
    script(stdioChild, (method) => {
      if (method === 'initialize') {
        return { protocolVersion: 1, agentCapabilities: { mcpCapabilities: { http: false } } }
      }
      return null
    })
    const stdioConn = await AcpConnection.connect({
      launch: LAUNCH,
      cwd: '/w',
      spawn: () => stdioChild,
      mcpServers: [httpServer, stdioServer],
    })
    await stdioConn.resumeSession('sess_old', '/next')
    const resumed = stdioChild.sent.find((message) => message['method'] === 'session/resume') as
      { params?: { mcpServers?: unknown[] } } | undefined
    expect(resumed?.params?.mcpServers).toEqual([stdioServer])
    stdioConn.kill()
  })

  it('routes session/update notifications to the hook', async () => {
    const child = fakeChild()
    script(child, STANDARD_AGENT)
    const connection = await AcpConnection.connect({
      launch: LAUNCH,
      cwd: '/w',
      spawn: () => child,
    })
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
    const connection = await AcpConnection.connect({
      launch: LAUNCH,
      cwd: '/w',
      spawn: () => child,
    })
    connection.onRequestPermission = async () => ({
      outcome: { outcome: 'selected', optionId: 'allow_once' },
    })
    child.stdout.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 42,
        method: 'session/request_permission',
        params: {
          sessionId: 's',
          options: [{ optionId: 'allow_once', name: 'Allow', kind: 'allow_once' }],
        },
      })}\n`,
    )
    await drain()
    const reply = child.sent.find((m) => m['id'] === 42 && m['method'] === undefined)
    expect(reply).toMatchObject({
      id: 42,
      result: { outcome: { outcome: 'selected', optionId: 'allow_once' } },
    })
    connection.kill()
  })

  it('bridges elicitation/create through onClientRequest as a JSON-RPC success', async () => {
    const child = fakeChild()
    script(child, STANDARD_AGENT)
    const connection = await AcpConnection.connect({
      launch: LAUNCH,
      cwd: '/w',
      spawn: () => child,
    })
    connection.onClientRequest = async () => ({
      action: 'accept',
      content: { strategy: 'balanced' },
    })
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
    const connection = await AcpConnection.connect({
      launch: LAUNCH,
      cwd: '/w',
      spawn: () => child,
    })
    const resumed = await connection.resumeSession('sess_old', '/next')
    expect(resumed.sessionId).toBe('sess_old')
    const resume = child.sent.find((m) => m['method'] === 'session/resume') as
      { params?: Record<string, unknown> } | undefined
    expect(resume?.params).toEqual({ sessionId: 'sess_old', cwd: '/next', mcpServers: [] })
    connection.kill()
  })

  it('answers unadvertised client methods with method-not-found', async () => {
    const child = fakeChild()
    script(child, STANDARD_AGENT)
    const connection = await AcpConnection.connect({
      launch: LAUNCH,
      cwd: '/w',
      spawn: () => child,
    })
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
    const connection = await AcpConnection.connect({
      launch: LAUNCH,
      cwd: '/w',
      spawn: () => child,
    })
    const created = await connection.newSession('/w')
    await expect(
      connection.prompt(created.sessionId as string, 'hello?', { stallSilenceMs: 120 }),
    ).rejects.toThrow('The agent stopped responding. Retry to reconnect.')
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
    const connection = await AcpConnection.connect({
      launch: LAUNCH,
      cwd: '/w',
      spawn: () => child,
    })
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
        params: {
          sessionId: created.sessionId,
          options: [{ optionId: 'allow_once', name: 'Allow', kind: 'allow_once' }],
        },
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

  describe('a half-installed npx entry', () => {
    let cache: string
    let entry: string
    beforeEach(async () => {
      cache = await mkdtemp(join(tmpdir(), 'ari-npx-'))
      entry = join(cache, '_npx', 'fca12915ff656968')
      await mkdir(join(entry, 'node_modules'), { recursive: true })
    })
    afterEach(() => rm(cache, { recursive: true, force: true }))

    /** npm's own words when the entry has node_modules but no manifest. */
    function dieLikeNpm(child: FakeChild): void {
      child.stderr.write(
        `npm error code ENOENT\nnpm error enoent Could not read package.json: Error: ENOENT: no such file or directory, open '${join(entry, 'package.json')}'\n`,
      )
      setTimeout(() => child.emitClose(254), 5)
    }

    it('is cleared and the launch retried once, so the adapter installs afresh', async () => {
      const broken = fakeChild()
      const healthy = fakeChild()
      // The retry installs before it answers, well past the usual ceiling.
      healthy.stdin.once('data', () => {
        setTimeout(() => {
          healthy.stdout.write(
            `${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { agentInfo: { name: 'TestAgent' } } })}\n`,
          )
        }, 120)
      })
      const children = [broken, healthy]
      const connectionPromise = AcpConnection.connect({
        launch: { ...LAUNCH, viaNpx: true, args: ['-y', 'some-adapter@1.0.0'] },
        cwd: '/w',
        spawn: () => children.shift() ?? fakeChild(),
        initializeTimeoutMs: 40,
      })
      dieLikeNpm(broken)
      const connection = await connectionPromise
      expect(connection.initialize.agentInfo?.name).toBe('TestAgent')
      expect(existsSync(entry)).toBe(false)
      expect(children).toHaveLength(0)
      connection.kill()
    })

    it('is left alone by a probe, which may not install anything', async () => {
      const broken = fakeChild()
      let spawns = 0
      const connectionPromise = AcpConnection.connect({
        launch: { ...LAUNCH, viaNpx: true, args: ['--no-install', 'some-adapter@1.0.0'] },
        cwd: '/w',
        spawn: () => {
          spawns++
          return broken
        },
      })
      dieLikeNpm(broken)
      await expect(connectionPromise).rejects.toThrow(/Could not read package\.json/)
      expect(existsSync(entry)).toBe(true)
      expect(spawns).toBe(1)
    })

    it('is left alone while another npx still holds the install lock', async () => {
      // A second launch that arrives mid-install fails the same way; clearing
      // the dir then would pull it out from under the first.
      await mkdir(join(entry, 'concurrency.lock'))
      const waiting = fakeChild()
      let spawns = 0
      const connectionPromise = AcpConnection.connect({
        launch: { ...LAUNCH, viaNpx: true, args: ['-y', 'some-adapter@1.0.0'] },
        cwd: '/w',
        spawn: () => {
          spawns++
          return waiting
        },
      })
      dieLikeNpm(waiting)
      await expect(connectionPromise).rejects.toThrow(/Could not read package\.json/)
      expect(existsSync(join(entry, 'node_modules'))).toBe(true)
      expect(spawns).toBe(1)
    })

    it('is not cleared when npm fails for any other reason', async () => {
      const failing = fakeChild()
      await writeFile(join(entry, 'package.json'), '{}')
      const connectionPromise = AcpConnection.connect({
        launch: { ...LAUNCH, viaNpx: true, args: ['-y', 'some-adapter@1.0.0'] },
        cwd: '/w',
        spawn: () => failing,
      })
      dieLikeNpm(failing)
      await expect(connectionPromise).rejects.toThrow(AcpConnectionError)
      expect(existsSync(join(entry, 'node_modules'))).toBe(true)
    })
  })

  it('advertises the terminal-auth capability so agents offer their logins', async () => {
    const child = fakeChild()
    script(child, STANDARD_AGENT)
    const connection = await AcpConnection.connect({
      launch: LAUNCH,
      cwd: '/w',
      spawn: () => child,
    })
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
              _meta: {
                'terminal-auth': { command: 'node', args: ['acp.js', '--cli', 'auth', 'login'] },
              },
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
    const connection = await AcpConnection.connect({
      launch: LAUNCH,
      cwd: '/w',
      spawn: () => child,
    })
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
    const connection = await AcpConnection.connect({
      launch: LAUNCH,
      cwd: '/w',
      spawn: () => child,
    })
    await expect(connection.newSession('/w')).rejects.toThrow(
      /not authenticated yet — run its login flow/,
    )
    connection.kill()
  })

  it('inbound traffic proves liveness and disarms the stall watchdog', async () => {
    const child = fakeChild()
    let promptId: number | undefined
    script(child, (method, params, id) => {
      if (method === 'session/prompt') {
        promptId = id
        return NO_REPLY
      }
      return STANDARD_AGENT(method, params, id)
    })
    const connection = await AcpConnection.connect({
      launch: LAUNCH,
      cwd: '/w',
      spawn: () => child,
    })
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
      const prompt = connection.prompt(created.sessionId as string, 'work', {
        stallSilenceMs: 120,
      })
      await drain(240)
      child.stdout.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'end_turn' } })}\n`,
      )
      await expect(prompt).resolves.toBe('end_turn')
    } finally {
      clearInterval(spam)
    }
    connection.kill()
  })
})

describe('ACP prompt watchdog lifecycle', () => {
  const stallSilenceMs = 1_200_000
  let child: FakeChild
  let connection: AcpConnection
  const promptIds: number[] = []
  const reply = (id: number, stopReason = 'end_turn') =>
    child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result: { stopReason } })}\n`)
  const update = (body: Record<string, unknown>) =>
    child.stdout.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'sess_9', update: body } })}\n`,
    )

  beforeEach(async () => {
    vi.useFakeTimers()
    promptIds.length = 0
    child = fakeChild()
    script(child, (method, params, id) => {
      if (method === 'session/prompt') {
        promptIds.push(id as number)
        return NO_REPLY
      }
      return STANDARD_AGENT(method, params, id)
    })
    connection = await AcpConnection.connect({ launch: LAUNCH, cwd: '/w', spawn: () => child })
    await connection.newSession('/w')
  })

  afterEach(() => {
    connection.kill()
    vi.useRealTimers()
  })

  it('gives an automatic result prompt a full deadline after a long idle gap', async () => {
    const first = connection.prompt('sess_9', 'delegate work', { stallSilenceMs })
    reply(promptIds[0]!)
    await first
    await vi.advanceTimersByTimeAsync(stallSilenceMs * 3)
    const settled = vi.fn()
    const prompt = connection.prompt('sess_9', 'A delegated session reported back', {
      stallSilenceMs,
    })
    void prompt.then(settled, settled)
    await vi.advanceTimersByTimeAsync(stallSilenceMs - 1)
    expect(settled).not.toHaveBeenCalled()
    reply(promptIds[1]!)
    await expect(prompt).resolves.toBe('end_turn')
  })

  it('removes every watchdog when the turn ends and stays silent while idle', async () => {
    const prompt = connection.prompt('sess_9', 'work', { stallSilenceMs })
    reply(promptIds[0]!)
    await expect(prompt).resolves.toBe('end_turn')
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(stallSilenceMs * 3)
    expect(connection.reusable).toBe(true)
  })

  it('settles a paused turn even when cancel never gets a prompt reply', async () => {
    const prompt = connection.prompt('sess_9', 'work', {
      stallSilenceMs,
      timeoutMs: stallSilenceMs,
    })
    connection.cancel('sess_9')
    await expect(prompt).resolves.toBe('cancelled')
    expect(vi.getTimerCount()).toBe(0)
    expect(connection.reusable).toBe(false)
    await vi.advanceTimersByTimeAsync(stallSilenceMs * 3)
    // The abandoned id cannot revive the cancelled turn.
    reply(promptIds[0]!)
    expect(connection.reusable).toBe(false)
  })

  it.each(['pending', 'in_progress'])(
    'allows a %s tool to wait on delegated sessions past the silence limit',
    async (status) => {
      const settled = vi.fn()
      const prompt = connection.prompt('sess_9', 'wait for the children', { stallSilenceMs })
      void prompt.then(settled, settled)
      update({
        sessionUpdate: 'tool_call',
        toolCallId: 'wait',
        status,
        rawInput: { command: 'ari session wait child' },
      })
      await vi.advanceTimersByTimeAsync(stallSilenceMs * 3)
      expect(settled).not.toHaveBeenCalled()
      update({ sessionUpdate: 'tool_call_update', toolCallId: 'wait', status: 'completed' })
      await vi.advanceTimersByTimeAsync(stallSilenceMs - 1)
      expect(settled).not.toHaveBeenCalled()
      reply(promptIds[0]!)
      await expect(prompt).resolves.toBe('end_turn')
    },
  )

  it.each(['completed', 'failed'])('detects a real hang after a long tool %s', async (status) => {
    const prompt = connection.prompt('sess_9', 'run a long build', { stallSilenceMs })
    const failure = expect(prompt).rejects.toThrow(
      'The agent stopped responding. Retry to reconnect.',
    )
    update({ sessionUpdate: 'tool_call_update', toolCallId: 'build', status: 'in_progress' })
    await vi.advanceTimersByTimeAsync(stallSilenceMs * 3)
    update({ sessionUpdate: 'tool_call_update', toolCallId: 'build', status })
    await vi.advanceTimersByTimeAsync(stallSilenceMs)
    await failure
    expect(connection.reusable).toBe(false)
  })

  it('does not carry unfinished background tools into the next prompt watchdog', async () => {
    const first = connection.prompt('sess_9', 'launch work in the background', { stallSilenceMs })
    update({ sessionUpdate: 'tool_call', toolCallId: 'old', status: 'in_progress' })
    reply(promptIds[0]!)
    await first
    const next = connection.prompt('sess_9', 'do more work', { stallSilenceMs })
    const failure = expect(next).rejects.toThrow('The agent stopped responding.')
    await vi.advanceTimersByTimeAsync(stallSilenceMs)
    await failure
  })

  it.each(['Agent', 'Task'])(
    'allows a prompt held open for native async %s results',
    async (toolName) => {
      const settled = vi.fn()
      const prompt = connection.prompt('sess_9', 'delegate a native task', { stallSilenceMs })
      void prompt.then(settled, settled)
      update({
        sessionUpdate: 'tool_call',
        toolCallId: 'agent',
        status: 'pending',
        rawInput: { run_in_background: true },
        _meta: { claudeCode: { toolName } },
      })
      // The launch tool ends; the child still runs and the adapter holds its RPC.
      update({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'agent',
        status: 'completed',
        _meta: {
          claudeCode: { toolName, toolResponse: { status: 'async_launched', agentId: 'a7' } },
        },
      })
      await vi.advanceTimersByTimeAsync(stallSilenceMs * 3)
      expect(settled).not.toHaveBeenCalled()
      reply(promptIds[0]!)
      await expect(prompt).resolves.toBe('end_turn')
      expect(vi.getTimerCount()).toBe(0)
    },
  )

  it('resumes hang detection after a native subagent is stopped', async () => {
    const prompt = connection.prompt('sess_9', 'delegate work', { stallSilenceMs })
    const failure = expect(prompt).rejects.toThrow('The agent stopped responding.')
    update({
      sessionUpdate: 'tool_call',
      toolCallId: 'agent',
      status: 'pending',
      rawInput: { run_in_background: true },
      _meta: { claudeCode: { toolName: 'Agent' } },
    })
    update({ sessionUpdate: 'tool_call_update', toolCallId: 'agent', status: 'completed' })
    await vi.advanceTimersByTimeAsync(stallSilenceMs * 3)
    update({
      sessionUpdate: 'tool_call',
      toolCallId: 'stop',
      status: 'completed',
      rawInput: { task_id: 'agent' },
      _meta: { claudeCode: { toolName: 'TaskStop' } },
    })
    await vi.advanceTimersByTimeAsync(stallSilenceMs)
    await failure
  })

  it('does not let a detached background shell suppress a foreground hang', async () => {
    const prompt = connection.prompt('sess_9', 'launch a background shell', { stallSilenceMs })
    const failure = expect(prompt).rejects.toThrow('The agent stopped responding.')
    update({
      sessionUpdate: 'tool_call',
      toolCallId: 'shell',
      status: 'pending',
      rawInput: { run_in_background: true },
      _meta: { claudeCode: { toolName: 'Bash' } },
    })
    update({ sessionUpdate: 'tool_call_update', toolCallId: 'shell', status: 'completed' })
    await vi.advanceTimersByTimeAsync(stallSilenceMs)
    await failure
  })

  it('keeps adapter setup timing details out of a real timeout message', async () => {
    child.stderr.write(
      '[session/create] sessionId=internal phase=modes durationMs=1 totalMs=1921\n',
    )
    const prompt = connection.prompt('sess_9', 'work', { stallSilenceMs })
    const failure = expect(prompt).rejects.toThrow(
      /^The agent stopped responding\. Retry to reconnect\.$/,
    )
    await vi.advanceTimersByTimeAsync(stallSilenceMs)
    await failure
  })

  it('still detects a process failure while a long tool is running', async () => {
    const prompt = connection.prompt('sess_9', 'run a long tool', { stallSilenceMs })
    const failure = expect(prompt).rejects.toThrow('exited mid-request')
    update({ sessionUpdate: 'tool_call', toolCallId: 'build', status: 'in_progress' })
    child.emitClose(1)
    await failure
    expect(vi.getTimerCount()).toBe(0)
  })

  it('clears cancellation watchdogs even if stdin throws', async () => {
    const prompt = connection.prompt('sess_9', 'work', { stallSilenceMs })
    const write = vi.spyOn(child.stdin, 'write').mockImplementation(() => {
      throw new Error('broken pipe')
    })
    expect(() => connection.cancel('sess_9')).toThrow('broken pipe')
    await expect(prompt).resolves.toBe('cancelled')
    expect(vi.getTimerCount()).toBe(0)
    write.mockRestore()
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
    const connection = await AcpConnection.connect({
      launch: LAUNCH,
      cwd: '/w',
      spawn: () => child,
    })
    await connection.shutdown()
    expect(connection.closed).toBe(true)
    expect(child.signals).toEqual([])
  })

  it('escalates to SIGTERM when the agent ignores the EOF', async () => {
    const child = fakeChild()
    script(child, STANDARD_AGENT)
    const connection = await AcpConnection.connect({
      launch: LAUNCH,
      cwd: '/w',
      spawn: () => child,
    })
    await connection.shutdown()
    expect(child.signals).toEqual(['SIGTERM'])
    expect(child.killed).toBe(true)
  }, 10000)

  it('is a no-op on an already-closed connection', async () => {
    const child = fakeChild()
    script(child, STANDARD_AGENT)
    const connection = await AcpConnection.connect({
      launch: LAUNCH,
      cwd: '/w',
      spawn: () => child,
    })
    connection.kill()
    await connection.waitClosed()
    child.signals.length = 0
    await connection.shutdown()
    expect(child.signals).toEqual([])
  })
})

describe('acpPromptStallMs', () => {
  it('parses the env knob with sane fallbacks', () => {
    expect(acpPromptStallMs(undefined)).toBe(1_200_000)
    expect(acpPromptStallMs('')).toBe(1_200_000)
    expect(acpPromptStallMs('30000')).toBe(30_000)
    expect(acpPromptStallMs('0')).toBe(0)
    expect(acpPromptStallMs('nonsense')).toBe(1_200_000)
    expect(acpPromptStallMs('-5')).toBe(1_200_000)
  })
})
