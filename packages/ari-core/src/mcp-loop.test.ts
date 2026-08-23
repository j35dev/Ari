import { describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent } from '@ari/contracts/agent-event'
import { runAgentLoop } from './agent-loop'
import type { Tool } from './tools'
import { AriCoreDriver, type AriCoreDriverOptions } from './ari-core-driver'
import { EndpointStore } from './endpoints'
import type { McpConnection } from './mcp'
import type { McpServerConfig } from './mcp-servers'

/**
 * Mount-wave tests: extra (MCP) tools inside the agent loop and the
 * AriCoreDriver's per-turn server mounting. Connection-level behavior is
 * covered in mcp.test.ts.
 */

const FAKE_SERVER = `
import readline from 'node:readline'

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\\n')
}

const tools = [
  {
    name: 'echo',
    description: 'Echoes text back.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
  },
]

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  const trimmed = line.trim()
  if (!trimmed) return
  let msg
  try {
    msg = JSON.parse(trimmed)
  } catch {
    return
  }
  if (msg.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'fake-mcp', version: '0.1.0' },
      },
    })
    return
  }
  if (msg.method === 'notifications/initialized') return
  if (msg.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: msg.id, result: { tools } })
    return
  }
  if (msg.method === 'tools/call') {
    const text = msg.params?.arguments?.text ?? ''
    send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'echo: ' + text }] } })
    return
  }
  if (msg.id !== undefined) {
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } })
  }
})
`

/** Stub MCP-shaped tool used for gating tests without a real server. */
function echoTool(): Tool & { calls: Record<string, unknown>[] } {
  const calls: Record<string, unknown>[] = []
  return {
    name: 'mcp_tester_echo',
    description: 'test double',
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    execute: async (args) => {
      calls.push(args)
      return `ran:${String(args['text'])}`
    },
    calls,
  }
}

function roundCalling(
  toolName: string,
  argsJson: string,
): (messages: unknown[]) => AsyncGenerator<AgentEvent> {
  let call = 0
  return async function* () {
    if (call++ === 0) {
      yield { type: 'tool-started', callId: 'c1', name: toolName, argsJson }
    } else {
      yield { type: 'text-delta', text: 'finished' }
    }
    yield { type: 'usage', inputTokens: 1, outputTokens: 1, costUsd: null }
    yield { type: 'done' }
  }
}

async function collect(options: Parameters<typeof runAgentLoop>[0]): Promise<AgentEvent[]> {
  const events: AgentEvent[] = []
  for await (const event of runAgentLoop(options)) events.push(event)
  return events
}

describe('agent loop with extra tools', () => {
  it('executes extra tools and feeds results back', async () => {
    const tool = echoTool()
    const events = await collect({
      round: roundCalling('mcp_tester_echo', JSON.stringify({ text: 'hello' })),
      systemPrompt: 's',
      userPrompt: 'u',
      workspacePath: '.',
      permissionMode: 'full',
      extraTools: [tool],
    })
    const completed = events.find((e) => e.type === 'tool-completed')
    if (completed?.type !== 'tool-completed') throw new Error('expected tool-completed')
    expect(completed.isError).toBe(false)
    expect(completed.resultJson).toContain('ran:hello')
    expect(tool.calls).toEqual([{ text: 'hello' }])
    expect(events.at(-1)).toEqual({ type: 'done' })
  })

  it('ask mode blocks extra tools like bash', async () => {
    const tool = echoTool()
    const events = await collect({
      round: roundCalling('mcp_tester_echo', '{}'),
      systemPrompt: 's',
      userPrompt: 'u',
      workspacePath: '.',
      permissionMode: 'ask',
      extraTools: [tool],
    })
    const completed = events.find((e) => e.type === 'tool-completed')
    if (completed?.type !== 'tool-completed') throw new Error('expected tool-completed')
    expect(completed.isError).toBe(true)
    expect(completed.resultJson).toContain("blocked by permission mode 'ask'")
    expect(tool.calls).toEqual([])
  })

  it('allow-edits still blocks external-execution extra tools', async () => {
    const tool = echoTool()
    const events = await collect({
      round: roundCalling('mcp_tester_echo', '{}'),
      systemPrompt: 's',
      userPrompt: 'u',
      workspacePath: '.',
      permissionMode: 'allow-edits',
      extraTools: [tool],
    })
    const completed = events.find((e) => e.type === 'tool-completed')
    if (completed?.type !== 'tool-completed') throw new Error('expected tool-completed')
    expect(completed.isError).toBe(true)
    expect(completed.resultJson).toContain("blocked by permission mode 'allow-edits'")
  })

  it('extra tools park on approvals and run once allowed', async () => {
    const tool = echoTool()
    const events = await collect({
      round: roundCalling('mcp_tester_echo', JSON.stringify({ text: 'ok' })),
      systemPrompt: 's',
      userPrompt: 'u',
      workspacePath: '.',
      permissionMode: 'ask',
      extraTools: [tool],
      requestApproval: async () => 'allow',
    })
    const requested = events.find((e) => e.type === 'approval-requested')
    if (requested?.type !== 'approval-requested') throw new Error('expected approval-requested')
    expect(requested.toolName).toBe('mcp_tester_echo')
    const completed = events.find((e) => e.type === 'tool-completed')
    if (completed?.type !== 'tool-completed') throw new Error('expected tool-completed')
    expect(completed.isError).toBe(false)
    expect(completed.resultJson).toContain('ran:ok')
  })

  it('a non-matching allowlist denies extra tools even in full mode', async () => {
    const tool = echoTool()
    const events = await collect({
      round: roundCalling('mcp_tester_echo', '{}'),
      systemPrompt: 's',
      userPrompt: 'u',
      workspacePath: '.',
      permissionMode: 'full',
      allowlist: [{ tool: 'mcp_tester_echo', pattern: 'mcp_other_*' }],
      extraTools: [tool],
    })
    const completed = events.find((e) => e.type === 'tool-completed')
    if (completed?.type !== 'tool-completed') throw new Error('expected tool-completed')
    expect(completed.isError).toBe(true)
    expect(completed.resultJson).toContain('blocked by permission allowlist')
    expect(tool.calls).toEqual([])
  })

  it('a matching allowlist rule binds by the prefixed tool name', async () => {
    // Matching allowlist + full mode → runs; this pins that rules scope to
    // the prefixed tool name.
    const tool = echoTool()
    const events = await collect({
      round: roundCalling('mcp_tester_echo', JSON.stringify({ text: 'listed' })),
      systemPrompt: 's',
      userPrompt: 'u',
      workspacePath: '.',
      permissionMode: 'full',
      allowlist: [{ tool: 'mcp_tester_echo', pattern: 'mcp_tester_*' }],
      extraTools: [tool],
    })
    const completed = events.find((e) => e.type === 'tool-completed')
    if (completed?.type !== 'tool-completed') throw new Error('expected tool-completed')
    expect(completed.isError).toBe(false)
    expect(tool.calls).toEqual([{ text: 'listed' }])
  })
})

describe('ari core driver MCP mounting', () => {
  async function makeEndpoints(dir: string): Promise<EndpointStore> {
    const endpoints = new EndpointStore({ dir })
    await endpoints.upsert({
      id: 'ep',
      name: 'Router',
      baseUrl: 'https://oai.test/v1',
      flavor: 'openai-chat',
      model: 'm',
      headers: {},
    })
    return endpoints
  }

  function driverWithRounds(
    endpoints: EndpointStore,
    options: AriCoreDriverOptions,
    rounds: string[][],
  ) {
    let index = 0
    return new AriCoreDriver(endpoints, {
      ...options,
      clients: {
        openai: async function* () {
          const names = rounds[Math.min(index++, rounds.length - 1)] ?? []
          for (const name of names) {
            yield {
              type: 'tool-started',
              callId: `c-${name}`,
              name,
              argsJson: JSON.stringify({ text: 'hi' }),
            }
          }
          if (index > 1 || names.length === 0) {
            yield { type: 'text-delta', text: 'all done' }
          }
          yield { type: 'usage', inputTokens: 1, outputTokens: 1, costUsd: null }
          yield { type: 'done' }
        },
      },
    })
  }

  async function writeFakeServer(dir: string): Promise<string> {
    const script = join(dir, 'fake-mcp-server.mjs')
    await writeFile(script, FAKE_SERVER, 'utf8')
    return script
  }

  async function collectStream(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
    const out: AgentEvent[] = []
    for await (const event of events) out.push(event)
    return out
  }

  function session(dir: string) {
    return {
      sessionId: 's1',
      workspacePath: dir,
      prompt: 'use mcp tools',
      modelId: 'ep',
      permissionMode: 'full' as const,
      resumeOf: null,
    }
  }

  it('spawns a real stdio server, merges its tools, and invokes one in the loop', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ari-mcp-loop-'))
    try {
      const script = await writeFakeServer(dir)
      const endpoints = await makeEndpoints(dir)
      const config: McpServerConfig = {
        id: 'srv-fake',
        name: 'fake',
        command: process.execPath,
        args: [script],
        env: {},
        disabled: false,
      }
      const driver = driverWithRounds(endpoints, { mcpServers: [config] }, [
        ['mcp_fake_echo'],
        [],
      ])
      const adapter = await driver.create(session(dir))
      const events = await collectStream(adapter.start())

      const completed = events.find((e) => e.type === 'tool-completed')
      if (completed?.type !== 'tool-completed') throw new Error('expected tool-completed')
      expect(completed.isError).toBe(false)
      expect(completed.resultJson).toContain('echo: hi')
      expect(events.at(-1)).toEqual({ type: 'done' })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('omits a dead server and the loop still runs to completion', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ari-mcp-deadloop-'))
    try {
      const endpoints = await makeEndpoints(dir)
      const config: McpServerConfig = {
        id: 'srv-dead',
        name: 'dead',
        command: 'definitely-not-a-real-binary-xyz',
        args: [],
        env: {},
        disabled: false,
      }
      const driver = driverWithRounds(endpoints, { mcpServers: [config] }, [
        ['mcp_dead_echo'],
        [],
      ])
      const adapter = await driver.create(session(dir))
      const events = await collectStream(adapter.start())

      const completed = events.find((e) => e.type === 'tool-completed')
      if (completed?.type !== 'tool-completed') throw new Error('expected tool-completed')
      // The mounted surface never existed, so the model's call degrades to
      // an errored result — never a crash escaping the loop.
      expect(completed.isError).toBe(true)
      expect(completed.resultJson).toContain('unknown tool')
      expect(events.at(-1)).toEqual({ type: 'done' })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('skips disabled servers without connecting', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ari-mcp-dis-'))
    try {
      const endpoints = await makeEndpoints(dir)
      let connects = 0
      const driver = driverWithRounds(endpoints, {
        mcpServers: [
          { id: 'off', name: 'off', command: 'x', args: [], env: {}, disabled: true },
        ],
        mcpConnect: async () => {
          connects++
          throw new Error('should not connect')
        },
      }, [[]])
      const adapter = await driver.create(session(dir))
      const events = await collectStream(adapter.start())
      expect(connects).toBe(0)
      expect(events.at(-1)).toEqual({ type: 'done' })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('disposes live connections when the turn ends and when disposed mid-wait', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ari-mcp-lifecycle-'))
    try {
      const endpoints = await makeEndpoints(dir)

      function fakeConnection(): {
        connection: McpConnection
        disposeCount: () => number
      } {
        let disposes = 0
        const connection = {
          listTools: async () => [
            { name: 'echo', description: 'stub', inputSchema: { type: 'object' } },
          ],
          callTool: async () => 'stub ran',
          dispose: async () => {
            disposes++
          },
        } as unknown as McpConnection
        return { connection, disposeCount: () => disposes }
      }

      // Natural end of turn disposes exactly once.
      const a = fakeConnection()
      const driverA = driverWithRounds(endpoints, {
        mcpServers: [{ id: 'a', name: 'a', command: 'x', args: [], env: {}, disabled: false }],
        mcpConnect: async () => a.connection,
      }, [['mcp_a_echo'], []])
      const adapterA = await driverA.create(session(dir))
      await collectStream(adapterA.start())
      await adapterA.dispose()
      expect(a.disposeCount()).toBe(1)

      // Dispose while the loop is running also disposes the connection.
      const b = fakeConnection()
      const driverB = driverWithRounds(endpoints, {
        mcpServers: [{ id: 'b', name: 'b', command: 'x', args: [], env: {}, disabled: false }],
        mcpConnect: async () => b.connection,
      }, [['mcp_b_echo'], []])
      const adapterB = await driverB.create(session(dir))
      const iterator = adapterB.start()[Symbol.asyncIterator]()
      for (;;) {
        const next = await iterator.next()
        if (next.done) break
      }
      await adapterB.dispose()
      expect(b.disposeCount()).toBe(1)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
