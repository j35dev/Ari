import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { createAcpAdapter, AcpDriver } from './acp-driver'
import type { AcpLaunch } from './connection'
import type { AdapterSession, ProviderAdapter } from '../driver'

const LAUNCH: AcpLaunch = { label: 'test-agent', command: 'fake', args: [] }

const SESSION: AdapterSession = {
  sessionId: 'ari_1',
  workspacePath: '/w',
  prompt: 'say hi',
  modelId: null,
  permissionMode: 'ask',
  resumeOf: null,
}

type FakeChild = {
  stdin: PassThrough
  stdout: PassThrough
  stderr: PassThrough
  killed: boolean
  sent: Record<string, unknown>[]
  kill(): boolean
  on(event: 'error', listener: (error: Error) => void): unknown
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

type AgentHandler = (method?: string, params?: unknown, id?: number) => unknown

/** Answers every client request through `handler`; no answer = silence. */
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
        const message = JSON.parse(line) as { id?: number; method?: string; params?: unknown }
        if (message.method !== undefined && message.id !== undefined) {
          const result = handler(message.method, message.params, message.id)
          if (result !== undefined) {
            child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`)
          }
        }
      }
      index = buffer.indexOf('\n')
    }
  })
}

function standardAgent(extra: AgentHandler = () => undefined): AgentHandler {
  return (method, params, id) => {
    if (method === 'initialize') return { protocolVersion: 1 }
    if (method === 'session/new') return { sessionId: 'sess_acp_1' }
    if (method === 'session/prompt') return { stopReason: 'end_turn' }
    return extra(method, params, id)
  }
}

const CONFIG_OPTIONS_AGENT: AgentHandler = (method, params, id) => {
  if (method === 'session/new') {
    return {
      sessionId: 'sess_acp_1',
      configOptions: [
        {
          id: 'model',
          name: 'Model',
          category: 'model',
          type: 'select',
          currentValue: 'm1',
          options: [
            { value: 'm1', name: 'Model One' },
            { value: 'm2', name: 'Model Two' },
          ],
        },
        {
          id: 'mode',
          name: 'Mode',
          category: 'mode',
          type: 'select',
          currentValue: 'default',
          options: [
            { value: 'default', name: 'Default' },
            { value: 'bypassPermissions', name: 'Full access' },
          ],
        },
      ],
    }
  }
  if (method === 'session/set_config_option') return { configOptions: [] as unknown[] }
  return standardAgent()(method, params, id)
}

async function collectTypes(adapter: ProviderAdapter): Promise<string[]> {
  const types: string[] = []
  const iterator = adapter.start()[Symbol.asyncIterator]()
  while (true) {
    const next = await iterator.next()
    if (next.done === true) break
    types.push(next.value.type)
  }
  return types
}

describe('createAcpAdapter', () => {
  it('applies the requested model and permission mode via config options', async () => {
    const child = fakeChild()
    script(child, CONFIG_OPTIONS_AGENT)
    const adapter = await createAcpAdapter(
      LAUNCH,
      { ...SESSION, modelId: 'm2', permissionMode: 'full' },
      () => child,
    )
    const configRequests = child.sent.filter((m) => m['method'] === 'session/set_config_option') as {
      params?: { configId?: string; value?: string }
    }[]
    expect(configRequests.map((r) => r.params?.configId)).toEqual(['model', 'mode'])
    expect(configRequests[0]?.params).toMatchObject({ configId: 'model', value: 'm2' })
    expect(configRequests[1]?.params).toMatchObject({ configId: 'mode', value: 'bypassPermissions' })

    await collectTypes(adapter)
    await adapter.dispose()
    expect(child.killed).toBe(true)
  }, 15000)

  it('keeps the agent default when the requested model is not advertised', async () => {
    const child = fakeChild()
    script(child, CONFIG_OPTIONS_AGENT)
    const adapter = await createAcpAdapter(
      LAUNCH,
      { ...SESSION, modelId: 'not-offered' },
      () => child,
    )
    // No model change may be sent; the mode mapping still applies its match.
    const modelRequests = child.sent.filter(
      (m) => m['method'] === 'session/set_config_option' && (m['params'] as { configId?: string })?.configId === 'model',
    )
    expect(modelRequests).toEqual([])
    await collectTypes(adapter)
    await adapter.dispose()
  }, 15000)

  it('streams a full turn and closes on the stop reason', async () => {
    const child = fakeChild()
    script(child, (method, params, id) => {
      if (method === 'session/prompt') {
        child.stdout.write(
          `${JSON.stringify({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: (params as { sessionId?: string }).sessionId,
              update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi there' } },
            },
          })}\n`,
        )
        return { stopReason: 'end_turn' }
      }
      return standardAgent()(method, params, id)
    })
    const adapter = await createAcpAdapter(LAUNCH, SESSION, () => child)
    const types = await collectTypes(adapter)
    expect(types[types.length - 1]).toBe('done')
    expect(types).toContain('text-delta')
    await adapter.dispose()
  }, 15000)

  it('bridges permission requests into approval events and back', async () => {
    const child = fakeChild()
    script(child, (method, _params, id) => {
      if (method === 'session/prompt') {
        child.stdout.write(
          `${JSON.stringify({
            jsonrpc: '2.0',
            id: 9001,
            method: 'session/request_permission',
            params: {
              sessionId: 'sess_acp_1',
              toolCall: {
                toolCallId: 't1',
                title: 'Run tests',
                kind: 'execute',
                rawInput: { command: 'vitest' },
              },
              options: [
                { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
                { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
              ],
            },
          })}\n`,
        )
        // The prompt only completes after the permission round-trips.
        setTimeout(() => {
          child.stdout.write(
            `${JSON.stringify({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } })}\n`,
          )
        }, 40)
        return undefined
      }
      if (id === 9001) return { outcome: { outcome: 'selected', optionId: 'allow_once' } }
      return standardAgent()(method, _params, id)
    })

    const adapter = await createAcpAdapter(LAUNCH, SESSION, () => child)
    const iterator = adapter.start()[Symbol.asyncIterator]()
    const approvals: { approvalId: string; toolName: string }[] = []
    while (true) {
      const next = await iterator.next()
      if (next.done === true) break
      if (next.value.type === 'approval-requested') {
        const event = next.value as { approvalId: string; toolName: string; summaryJson: string }
        approvals.push(event)
        expect(event.toolName).toBe('Run tests')
        expect(JSON.parse(event.summaryJson)).toMatchObject({ rawInput: { command: 'vitest' } })
        adapter.respondApproval(event.approvalId, 'allow')
      }
    }
    expect(approvals.length).toBe(1)
    const reply = child.sent.find((m) => m['id'] === 9001 && m['method'] === undefined)
    expect(reply).toMatchObject({
      result: { outcome: { outcome: 'selected', optionId: 'allow_once' } },
    })
    await adapter.dispose()
  }, 15000)

  it('surfaces auth walls with an actionable message', async () => {
    const child = fakeChild()
    script(child, (method, _params, id) => {
      if (method === 'initialize') return { protocolVersion: 1 }
      if (method === 'session/new') {
        child.stdout.write(
          `${JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message: 'auth required' } })}\n`,
        )
        return undefined
      }
      return undefined
    })
    await expect(createAcpAdapter(LAUNCH, SESSION, () => child)).rejects.toThrow(/not authenticated/)
  }, 15000)
})

describe('AcpDriver', () => {
  it('falls back to the legacy driver when no launch is available', async () => {
    const fallbackCreate = vi.fn(async (): Promise<ProviderAdapter> => ({
      start: () => ({ [Symbol.asyncIterator]: () => emptyIterator() }),
      interrupt: () => undefined,
      dispose: async () => undefined,
    }))
    const driver = new AcpDriver('claude', null, { kind: 'claude', create: fallbackCreate })
    await driver.create(SESSION)
    expect(fallbackCreate).toHaveBeenCalledWith(SESSION)
  })

  it('falls back when the ACP handshake fails', async () => {
    const fallbackCreate = vi.fn(async (): Promise<ProviderAdapter> => ({
      start: () => ({ [Symbol.asyncIterator]: () => emptyIterator() }),
      interrupt: () => undefined,
      dispose: async () => undefined,
    }))
    const driver = new AcpDriver(
      'opencode',
      { label: 'broken', command: 'ari-missing-bin-xyz', args: [] },
      { kind: 'opencode', create: fallbackCreate },
    )
    const adapter = await driver.create({ ...SESSION, workspacePath: process.cwd() })
    expect(fallbackCreate).toHaveBeenCalledTimes(1)
    expect(typeof adapter.start).toBe('function')
  }, 20000)

  it('throws when neither transport exists', async () => {
    const driver = new AcpDriver('pi', null, null)
    await expect(driver.create(SESSION)).rejects.toThrow(/no transport available/)
  })
})

async function* emptyIterator(): AsyncGenerator<never, void, undefined> {}
