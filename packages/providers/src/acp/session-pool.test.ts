import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import type { AgentEvent } from '@ari/contracts/agent-event'
import { createAcpAdapter } from './acp-driver'
import type { AcpLaunch } from './connection'
import type { AdapterSession, ProviderAdapter } from '../driver'
import { AcpSessionPool } from './session-pool'

const LAUNCH: AcpLaunch = { label: 'pooled-agent', command: 'fake', args: [] }
const SESSION: AdapterSession = {
  sessionId: 'ari_1',
  workspacePath: '/w',
  prompt: 'start a background task',
  modelId: null,
  permissionMode: 'ask',
  resumeOf: null,
}

interface Child {
  stdin: PassThrough
  stdout: PassThrough
  stderr: PassThrough
  killed: boolean
  sent: { method?: string }[]
  kill(): boolean
  on(): Child
}

/** A scripted stdio agent: answers requests and records what it was sent. */
function agent(answer: (method: string) => unknown): Child {
  const child: Child = {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    killed: false,
    sent: [],
    kill() {
      if (child.killed) return true
      child.killed = true
      child.stdin.end()
      child.stdout.end()
      child.stderr.end()
      return true
    },
    on() {
      return child
    },
  }
  let buffer = ''
  child.stdin.setEncoding('utf8')
  child.stdin.on('data', (chunk: string) => {
    buffer += chunk
    let at = buffer.indexOf('\n')
    while (at !== -1) {
      const line = buffer.slice(0, at)
      buffer = buffer.slice(at + 1)
      if (line.trim()) {
        const message = JSON.parse(line) as { id?: number; method?: string }
        child.sent.push(message)
        if (message.method && message.id !== undefined) {
          const result = answer(message.method)
          if (result !== undefined)
            child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`)
        }
      }
      at = buffer.indexOf('\n')
    }
  })
  child.stdin.on('end', () => child.kill())
  return child
}

const standard = (method: string): unknown =>
  method === 'initialize'
    ? { protocolVersion: 1, agentCapabilities: { loadSession: true } }
    : method === 'session/new'
      ? { sessionId: 'agent_1' }
      : method === 'session/prompt'
        ? { stopReason: 'end_turn' }
        : method === 'session/cancel'
          ? undefined
          : null

async function drain(adapter: ProviderAdapter): Promise<AgentEvent[]> {
  const events: AgentEvent[] = []
  for await (const event of adapter.start()) events.push(event)
  return events
}

const count = (child: Child, method: string): number =>
  child.sent.filter((message) => message.method === method).length

describe('pooled ACP sessions', () => {
  it('keeps the agent alive after a turn and reuses it for the next one', async () => {
    const pool = new AcpSessionPool()
    const child = agent(standard)
    let spawns = 0
    const spawn = () => {
      spawns += 1
      return child
    }
    const first = await createAcpAdapter(LAUNCH, SESSION, spawn, undefined, [], null, pool)
    await drain(first)
    await first.dispose()
    // The turn ended but the process did not: its background work keeps running.
    expect(child.killed).toBe(false)
    expect(pool.size).toBe(1)

    const second = await createAcpAdapter(
      LAUNCH,
      { ...SESSION, prompt: 'and now?', resumeOf: 'agent_1' },
      spawn,
      undefined,
      [],
      null,
      pool,
    )
    const events = await drain(second)
    expect(events[0]).toEqual({ type: 'session-ref', ref: 'agent_1' })
    // No new process, handshake or session reload for the second turn.
    expect(spawns).toBe(1)
    expect(count(child, 'initialize')).toBe(1)
    expect(count(child, 'session/new')).toBe(1)
    expect(count(child, 'session/load')).toBe(0)
    expect(count(child, 'session/prompt')).toBe(2)

    await second.dispose()
    await pool.shutdownAll()
    expect(child.killed).toBe(true)
  }, 15_000)

  it('hands what the agent says between turns to the host', async () => {
    const pool = new AcpSessionPool()
    const background = vi.fn()
    pool.onBackground = background
    const child = agent(standard)
    const adapter = await createAcpAdapter(LAUNCH, SESSION, () => child, undefined, [], null, pool)
    await drain(adapter)
    await adapter.dispose()

    child.stdout.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'agent_1',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'task done' },
          },
        },
      })}\n`,
    )
    await vi.waitFor(() =>
      expect(background).toHaveBeenCalledWith('ari_1', [
        expect.objectContaining({ type: 'text-delta', text: 'task done' }),
      ]),
    )
    await pool.shutdownAll()
  }, 15_000)

  it('starts a fresh agent when the launch changed', async () => {
    const pool = new AcpSessionPool()
    const first = agent(standard)
    const second = agent(standard)
    const children = [first, second]
    const spawn = () => children.shift()!
    const a = await createAcpAdapter(LAUNCH, SESSION, spawn, undefined, [], null, pool)
    await drain(a)
    await a.dispose()
    const b = await createAcpAdapter(
      LAUNCH,
      { ...SESSION, workspacePath: '/elsewhere' },
      spawn,
      undefined,
      [],
      null,
      pool,
    )
    await drain(b)
    await vi.waitFor(() => expect(first.killed).toBe(true))
    expect(second.killed).toBe(false)
    await b.dispose()
    await pool.shutdownAll()
  }, 15_000)

  it('closes connections idle past the limit', async () => {
    const pool = new AcpSessionPool(1_000)
    const ended = vi.fn()
    pool.onEnded = ended
    const child = agent(standard)
    const adapter = await createAcpAdapter(LAUNCH, SESSION, () => child, undefined, [], null, pool)
    await drain(adapter)
    await adapter.dispose()
    expect(adapter.keepsBackgroundWork?.()).toBe(true)
    expect(pool.has('ari_1')).toBe(true)
    pool.reap(Date.now() + 500)
    expect(pool.size).toBe(1)
    pool.reap(Date.now() + 5_000)
    expect(pool.size).toBe(0)
    expect(pool.has('ari_1')).toBe(false)
    // The host hears of it, so it can end what the process still ran.
    expect(ended).toHaveBeenCalledWith('ari_1')
    await vi.waitFor(() => expect(child.killed).toBe(true))
  }, 15_000)

  it('reports a background shell from the turn and its end when the agent reports back', async () => {
    const pool = new AcpSessionPool()
    const background = vi.fn()
    pool.onBackground = background
    const update = (body: Record<string, unknown>) =>
      `${JSON.stringify({
        jsonrpc: '2.0',
        method: 'session/update',
        params: { sessionId: 'agent_1', update: body },
      })}\n`
    const child = agent((method) => {
      if (method === 'session/prompt') {
        // The agent launches a shell in the background, then ends its turn.
        child.stdout.write(
          update({
            sessionUpdate: 'tool_call',
            toolCallId: 'bg_1',
            status: 'pending',
            rawInput: { command: 'npm test', description: 'Run tests', run_in_background: true },
            _meta: { claudeCode: { toolName: 'Bash' } },
          }),
        )
        child.stdout.write(
          update({
            sessionUpdate: 'tool_call_update',
            toolCallId: 'bg_1',
            status: 'completed',
            _meta: { claudeCode: { toolName: 'Bash' } },
          }),
        )
      }
      return standard(method)
    })
    const adapter = await createAcpAdapter(LAUNCH, SESSION, () => child, undefined, [], null, pool)
    const events = await drain(adapter)
    expect(events.filter((event) => event.type === 'background-task')).toEqual([
      expect.objectContaining({ id: 'bg_1', kind: 'shell', label: 'Run tests', status: 'running' }),
    ])
    await adapter.dispose()

    child.stdout.write(
      update({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'All green.' },
      }),
    )
    await vi.waitFor(() =>
      expect(background).toHaveBeenCalledWith('ari_1', [
        { type: 'text-delta', text: 'All green.' },
        expect.objectContaining({ id: 'bg_1', status: 'completed' }),
      ]),
    )
    await pool.shutdownAll()
  }, 15_000)
})
