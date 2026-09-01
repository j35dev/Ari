import { PassThrough } from 'node:stream'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent } from '@ari/contracts/agent-event'
import {
  createAcpAdapter,
  AcpDriver,
  launchWithEffort,
  pickAgentMode,
  shouldFallBack,
  __resetLearnedAcpSelectors,
} from './acp-driver'
import { AcpAuthRequiredError, AcpConnectionError } from './connection'
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
  // A stdio agent exits when its input closes, so dispose settles on the
  // transport's own EOF instead of waiting out the teardown ladder.
  stdin.on('end', () => {
    if (!child.killed) child.kill()
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

const THOUGHT_LEVEL_AGENT: AgentHandler = (method, params, id) => {
  if (method === 'session/new') {
    return {
      sessionId: 'sess_acp_1',
      configOptions: [
        {
          id: 'effort',
          name: 'Effort',
          category: 'thought_level',
          type: 'select',
          currentValue: 'medium',
          options: [
            { value: 'low', name: 'Low' },
            { value: 'medium', name: 'Medium' },
            { value: 'high', name: 'High' },
          ],
        },
      ],
    }
  }
  if (method === 'session/set_config_option') return { configOptions: [] as unknown[] }
  return standardAgent()(method, params, id)
}

const PI_THINKING_AGENT: AgentHandler = (method, params, id) => {
  if (method === 'session/new') {
    return {
      sessionId: 'sess_acp_1',
      modes: {
        currentModeId: 'low',
        availableModes: [
          { id: 'off', name: 'Off' },
          { id: 'low', name: 'Low' },
          { id: 'xhigh', name: 'Extra high' },
        ],
      },
    }
  }
  if (method === 'session/set_mode') return {}
  return standardAgent()(method, params, id)
}

/** opencode's vocabulary: two modes, neither of them named like Ari's. */
const LEGACY_MODES_AGENT: AgentHandler = (method, params, id) => {
  if (method === 'session/new') {
    return {
      sessionId: 'sess_acp_1',
      modes: {
        currentModeId: 'build',
        availableModes: [
          { id: 'build', name: 'Build' },
          { id: 'plan', name: 'Plan' },
        ],
      },
    }
  }
  if (method === 'session/set_mode') return {}
  return standardAgent()(method, params, id)
}

async function collectTypes(adapter: ProviderAdapter): Promise<string[]> {
  return (await collectEvents(adapter)).map((event) => event.type)
}

async function collectEvents(adapter: ProviderAdapter): Promise<AgentEvent[]> {
  const events: AgentEvent[] = []
  const iterator = adapter.start()[Symbol.asyncIterator]()
  while (true) {
    const next = await iterator.next()
    if (next.done === true) break
    events.push(next.value)
  }
  return events
}

/** Mode ids sent through `session/set_mode` on a connection. */
function modeCalls(child: FakeChild): (string | undefined)[] {
  return child.sent
    .filter((m) => m['method'] === 'session/set_mode')
    .map((m) => (m['params'] as { modeId?: string }).modeId)
}

describe('createAcpAdapter', () => {
  beforeEach(() => {
    __resetLearnedAcpSelectors()
  })

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

  it('applies a thought_level config option when the session picked an effort', async () => {
    const child = fakeChild()
    script(child, THOUGHT_LEVEL_AGENT)
    const adapter = await createAcpAdapter(LAUNCH, { ...SESSION, effort: 'high' }, () => child)
    const thought = child.sent.filter(
      (m) =>
        m['method'] === 'session/set_config_option' &&
        (m['params'] as { configId?: string })?.configId === 'effort',
    ) as { params?: { value?: string } }[]
    expect(thought.map((r) => r.params?.value)).toEqual(['high'])
    await adapter.dispose()
  }, 15000)

  it('leaves thought_level untouched when the session has no effort pick', async () => {
    const child = fakeChild()
    script(child, THOUGHT_LEVEL_AGENT)
    const adapter = await createAcpAdapter(LAUNCH, SESSION, () => child)
    expect(child.sent.some((m) => m['method'] === 'session/set_config_option')).toBe(false)
    await adapter.dispose()
  }, 15000)

  it('sets pi-style thinking modes via session/set_mode for an effort pick', async () => {
    const child = fakeChild()
    script(child, PI_THINKING_AGENT)
    const adapter = await createAcpAdapter(
      LAUNCH,
      { ...SESSION, permissionMode: 'allow-edits', effort: 'xhigh' },
      () => child,
    )
    expect(modeCalls(child)).toEqual(['xhigh'])
    await adapter.dispose()
  }, 15000)

  it('does not drive a permission mode axis as thought', async () => {
    const child = fakeChild()
    script(child, LEGACY_MODES_AGENT)
    const adapter = await createAcpAdapter(
      LAUNCH,
      { ...SESSION, permissionMode: 'allow-edits', effort: 'high' },
      () => child,
    )
    expect(modeCalls(child)).toEqual(['build'])
    await adapter.dispose()
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

  it('hides the pi-acp startup prelude but keeps the real reply', async () => {
    const child = fakeChild()
    const startupInfo = '## Context\n- D:/project/AGENTS.md\n\n## Skills\n- C:/skills/example/SKILL.md\n'
    script(child, (method, params, id) => {
      if (method === 'session/new') {
        return { sessionId: 'sess_acp_1', _meta: { piAcp: { startupInfo } } }
      }
      if (method === 'session/prompt') {
        const sessionId = (params as { sessionId?: string }).sessionId
        for (const text of [startupInfo, 'Hi from Pi.']) {
          child.stdout.write(
            `${JSON.stringify({
              jsonrpc: '2.0',
              method: 'session/update',
              params: {
                sessionId,
                update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
              },
            })}\n`,
          )
        }
        return { stopReason: 'end_turn' }
      }
      return standardAgent()(method, params, id)
    })

    const adapter = await createAcpAdapter(LAUNCH, SESSION, () => child)
    const iterator = adapter.start()[Symbol.asyncIterator]()
    const text: string[] = []
    while (true) {
      const next = await iterator.next()
      if (next.done === true) break
      if (next.value.type === 'text-delta') text.push(next.value.text)
    }

    expect(text).toEqual(['Hi from Pi.'])
    await adapter.dispose()
  }, 15000)

  it('delivers steering as a chained follow-up prompt inside the same stream', async () => {
    const child = fakeChild()
    const prompts: string[] = []
    script(child, (method, params) => {
      if (method === 'session/prompt') {
        prompts.push((params as { prompt: { text: string }[] }).prompt[0]?.text ?? '')
        return { stopReason: 'end_turn' }
      }
      return standardAgent()(method, params, undefined)
    })
    const adapter = await createAcpAdapter(LAUNCH, SESSION, () => child)
    // Steering arrives while the first prompt is in flight (it resolves on a
    // later tick, so this genuinely races the stop reason).
    adapter.steer?.('actually focus on the tests')
    const types = await collectTypes(adapter)

    expect(types[types.length - 1]).toBe('done')
    expect(prompts).toEqual(['say hi', 'actually focus on the tests'])
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

  it('reports the agent-advertised logins for an auth wall on the handshake', async () => {
    const child = fakeChild()
    script(child, (method, _params, id) => {
      if (method === 'initialize') {
        return {
          protocolVersion: 1,
          authMethods: [
            {
              id: 'claude-ai-login',
              name: 'Claude Subscription',
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
    const walls: { label: string; logins: { methodId: string }[] }[] = []
    const failure = await createAcpAdapter(LAUNCH, SESSION, () => child, (wall) =>
      walls.push(wall),
    ).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(AcpAuthRequiredError)
    expect(walls).toHaveLength(1)
    expect(walls[0]?.label).toBe('test-agent')
    expect(walls[0]?.logins.map((l) => l.methodId)).toEqual(['claude-ai-login'])
  }, 15000)

  it('reports an auth wall that lands mid-turn, after the session opened', async () => {
    const child = fakeChild()
    script(child, (method, _params, id) => {
      if (method === 'initialize') {
        return {
          protocolVersion: 1,
          authMethods: [{ id: 'console-login', _meta: { 'terminal-auth': { command: 'node' } } }],
        }
      }
      if (method === 'session/new') return { sessionId: 'sess_expiring' }
      if (method === 'session/prompt') {
        child.stdout.write(
          `${JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message: 'authRequired' } })}\n`,
        )
        return undefined
      }
      return undefined
    })
    const walls: { logins: { methodId: string }[] }[] = []
    const adapter = await createAcpAdapter(LAUNCH, SESSION, () => child, (wall) => walls.push(wall))

    const events: string[] = []
    for await (const event of adapter.start()) events.push(event.type)

    expect(events).toContain('error')
    expect(walls[0]?.logins.map((l) => l.methodId)).toEqual(['console-login'])
    await adapter.dispose()
  }, 15000)

  it('resumes via session/load when the agent advertises loadSession', async () => {
    const child = fakeChild()
    script(child, (method) => {
      if (method === 'initialize') {
        return { protocolVersion: 1, agentCapabilities: { loadSession: true } }
      }
      if (method === 'session/load') return null // spec: empty body
      if (method === 'session/prompt') return { stopReason: 'end_turn' }
      if (method === 'session/new') throw new Error('must not create a fresh session')
      return undefined
    })
    const adapter = await createAcpAdapter(LAUNCH, { ...SESSION, resumeOf: 'sess_old' }, () => child)

    const load = child.sent.find((m) => m['method'] === 'session/load') as
      | { params?: { sessionId?: string; cwd?: string } }
      | undefined
    expect(load?.params).toEqual({ sessionId: 'sess_old', cwd: '/w', mcpServers: [] })

    // The resumed id is published so Ari can keep resuming on later turns.
    const first = adapter.start()[Symbol.asyncIterator]()
    const firstEvent = await first.next()
    expect(firstEvent.value).toEqual({ type: 'session-ref', ref: 'sess_old' })
    await adapter.dispose()
  }, 15000)

  it('falls back to a fresh session when session/load fails', async () => {
    const child = fakeChild()
    script(child, (method, params, id) => {
      if (method === 'initialize') {
        return { protocolVersion: 1, agentCapabilities: { loadSession: true } }
      }
      if (method === 'session/load') {
        child.stdout.write(
          `${JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32602, message: 'unknown session' } })}\n`,
        )
        return undefined
      }
      if (method === 'session/new') return { sessionId: 'sess_fresh' }
      if (method === 'session/prompt') return { stopReason: 'end_turn' }
      return undefined
    })
    const adapter = await createAcpAdapter(LAUNCH, { ...SESSION, resumeOf: 'sess_gone' }, () => child)

    expect(child.sent.some((m) => m['method'] === 'session/load')).toBe(true)
    expect(child.sent.some((m) => m['method'] === 'session/new')).toBe(true)
    const first = adapter.start()[Symbol.asyncIterator]()
    expect((await first.next()).value).toEqual({ type: 'session-ref', ref: 'sess_fresh' })
    await adapter.dispose()
  }, 15000)

  it('does not fold session/load history replay into the new turn', async () => {
    const child = fakeChild()
    script(child, (method, params) => {
      if (method === 'initialize') {
        return { protocolVersion: 1, agentCapabilities: { loadSession: true } }
      }
      if (method === 'session/load') {
        child.stdout.write(
          `${JSON.stringify({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: 'sess_old',
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'hello from turn 1' },
              },
            },
          })}\n`,
        )
        return null
      }
      if (method === 'session/prompt') {
        child.stdout.write(
          `${JSON.stringify({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: (params as { sessionId?: string }).sessionId,
              update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'four' } },
            },
          })}\n`,
        )
        return { stopReason: 'end_turn' }
      }
      if (method === 'session/new') throw new Error('must not create a fresh session')
      return undefined
    })
    const adapter = await createAcpAdapter(LAUNCH, { ...SESSION, resumeOf: 'sess_old' }, () => child)
    const events = await collectEvents(adapter)
    const texts = events.filter((e) => e.type === 'text-delta').map((e) => e.text)
    expect(texts).toEqual(['four'])
    await adapter.dispose()
  }, 15000)

  it('prefers session/resume over session/load when the agent advertises it', async () => {
    const child = fakeChild()
    script(child, (method) => {
      if (method === 'initialize') {
        return {
          protocolVersion: 1,
          agentCapabilities: { loadSession: true, sessionCapabilities: { resume: true } },
        }
      }
      if (method === 'session/resume') return { sessionId: 'sess_old' }
      if (method === 'session/load') throw new Error('must use session/resume')
      if (method === 'session/new') throw new Error('must not create a fresh session')
      if (method === 'session/prompt') return { stopReason: 'end_turn' }
      return undefined
    })
    const adapter = await createAcpAdapter(LAUNCH, { ...SESSION, resumeOf: 'sess_old' }, () => child)
    expect(child.sent.some((m) => m['method'] === 'session/resume')).toBe(true)
    expect(child.sent.some((m) => m['method'] === 'session/load')).toBe(false)
    await adapter.dispose()
  }, 15000)

  it('bridges ask_user_question into input-requested and replies as JSON-RPC success', async () => {
    const child = fakeChild()
    script(child, (method, _params, id) => {
      if (method === 'session/prompt') {
        child.stdout.write(
          `${JSON.stringify({
            jsonrpc: '2.0',
            id: 9101,
            method: '_x.ai/ask_user_question',
            params: {
              questions: [
                {
                  question: 'Which approach?',
                  options: [{ label: 'Conservative' }, { label: 'Rewrite' }],
                },
              ],
            },
          })}\n`,
        )
        setTimeout(() => {
          child.stdout.write(
            `${JSON.stringify({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } })}\n`,
          )
        }, 40)
        return undefined
      }
      return standardAgent()(method, _params, id)
    })
    const adapter = await createAcpAdapter(LAUNCH, SESSION, () => child)
    const iterator = adapter.start()[Symbol.asyncIterator]()
    const seen: string[] = []
    while (true) {
      const next = await iterator.next()
      if (next.done === true) break
      if (next.value.type === 'input-requested') {
        seen.push(next.value.prompt)
        adapter.respondInput(next.value.inputId, JSON.stringify({ answers: { '0': 'Rewrite' } }))
      }
    }
    expect(seen).toEqual(['Which approach?'])
    const reply = child.sent.find((m) => m['id'] === 9101 && m['method'] === undefined)
    expect(reply).toMatchObject({
      result: {
        outcome: 'accepted',
        answers: { 'Which approach?': 'Rewrite' },
      },
    })
    await adapter.dispose()
  }, 15000)

  it('answers exit_plan_mode with a success outcome instead of method-not-found', async () => {
    const child = fakeChild()
    script(child, (method, _params, id) => {
      if (method === 'session/prompt') {
        child.stdout.write(
          `${JSON.stringify({
            jsonrpc: '2.0',
            id: 9102,
            method: '_x.ai/exit_plan_mode',
            params: { planContent: '# Ship it\n\n1. Do the thing.' },
          })}\n`,
        )
        setTimeout(() => {
          child.stdout.write(
            `${JSON.stringify({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } })}\n`,
          )
        }, 40)
        return undefined
      }
      return standardAgent()(method, _params, id)
    })
    const adapter = await createAcpAdapter(LAUNCH, SESSION, () => child)
    const iterator = adapter.start()[Symbol.asyncIterator]()
    while (true) {
      const next = await iterator.next()
      if (next.done === true) break
      if (next.value.type === 'input-requested') {
        expect(JSON.parse(next.value.choicesJson ?? '{}')).toMatchObject({
          kind: 'plan-approval',
          planContent: '# Ship it\n\n1. Do the thing.',
        })
        adapter.respondInput(next.value.inputId, 'approved')
      }
    }
    const reply = child.sent.find((m) => m['id'] === 9102 && m['method'] === undefined)
    expect(reply).toMatchObject({ result: { outcome: 'approved' } })
    expect(reply).not.toHaveProperty('error')
    await adapter.dispose()
  }, 15000)

  it('bridges elicitation/create into input-requested', async () => {
    const child = fakeChild()
    script(child, (method, _params, id) => {
      if (method === 'session/prompt') {
        child.stdout.write(
          `${JSON.stringify({
            jsonrpc: '2.0',
            id: 9103,
            method: 'elicitation/create',
            params: {
              mode: 'form',
              message: 'How should I refactor?',
              requestedSchema: {
                type: 'object',
                properties: {
                  strategy: { type: 'string', enum: ['conservative', 'balanced'] },
                },
              },
            },
          })}\n`,
        )
        setTimeout(() => {
          child.stdout.write(
            `${JSON.stringify({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } })}\n`,
          )
        }, 40)
        return undefined
      }
      return standardAgent()(method, _params, id)
    })
    const adapter = await createAcpAdapter(LAUNCH, SESSION, () => child)
    const iterator = adapter.start()[Symbol.asyncIterator]()
    while (true) {
      const next = await iterator.next()
      if (next.done === true) break
      if (next.value.type === 'input-requested') {
        adapter.respondInput(
          next.value.inputId,
          JSON.stringify({ answers: { strategy: 'balanced' } }),
        )
      }
    }
    const reply = child.sent.find((m) => m['id'] === 9103 && m['method'] === undefined)
    expect(reply).toMatchObject({
      result: { action: 'accept', content: { strategy: 'balanced' } },
    })
    await adapter.dispose()
  }, 15000)

  it('skips resume when the agent does not advertise loadSession', async () => {
    const child = fakeChild()
    let sawLoad = false
    script(child, (method) => {
      if (method === 'initialize') return { protocolVersion: 1 }
      if (method === 'session/load') sawLoad = true
      if (method === 'session/new') return { sessionId: 'sess_new' }
      if (method === 'session/prompt') return { stopReason: 'end_turn' }
      return undefined
    })
    const adapter = await createAcpAdapter(LAUNCH, { ...SESSION, resumeOf: 'sess_old' }, () => child)

    expect(sawLoad).toBe(false)
    await adapter.dispose()
  }, 15000)

  it('leaves an agent that advertises no selectors untouched on a fresh session', async () => {
    const child = fakeChild()
    script(child, standardAgent())
    const adapter = await createAcpAdapter(
      LAUNCH,
      { ...SESSION, permissionMode: 'full' },
      () => child,
    )
    expect(modeCalls(child)).toEqual([])
    expect(child.sent.some((m) => m['method'] === 'session/set_config_option')).toBe(false)
    await adapter.dispose()
  }, 15000)

  it('moves a plan-capable agent into its write mode for the build modes', async () => {
    for (const mode of ['allow-edits', 'full'] as const) {
      __resetLearnedAcpSelectors()
      const child = fakeChild()
      script(child, LEGACY_MODES_AGENT)
      const adapter = await createAcpAdapter(LAUNCH, { ...SESSION, permissionMode: mode }, () => child)
      expect(modeCalls(child)).toEqual(['build'])
      await adapter.dispose()
    }
  }, 20000)

  it('selects the planning mode for ask', async () => {
    const child = fakeChild()
    script(child, LEGACY_MODES_AGENT)
    const adapter = await createAcpAdapter(LAUNCH, { ...SESSION, permissionMode: 'ask' }, () => child)
    expect(modeCalls(child)).toEqual(['plan'])
    await adapter.dispose()
  }, 15000)

  /**
   * The reported bug: turn 1 in Ask mode put opencode in `plan`, turn 2 resumed
   * that session, `session/load` answered with the spec's empty body, and the
   * switch to a build mode was never delivered — so the agent kept refusing to
   * write and asked the user to exit plan mode by hand.
   */
  it('re-applies the mode on a resumed session whose load body is empty', async () => {
    const first = fakeChild()
    script(first, LEGACY_MODES_AGENT)
    const askTurn = await createAcpAdapter(LAUNCH, { ...SESSION, permissionMode: 'ask' }, () => first)
    expect(modeCalls(first)).toEqual(['plan'])
    await askTurn.dispose()

    const second = fakeChild()
    script(second, (method, params, id) => {
      if (method === 'initialize') {
        return { protocolVersion: 1, agentCapabilities: { loadSession: true } }
      }
      if (method === 'session/load') return null // spec: empty body
      if (method === 'session/new') throw new Error('must not create a fresh session')
      return LEGACY_MODES_AGENT(method, params, id)
    })
    const buildTurn = await createAcpAdapter(
      LAUNCH,
      { ...SESSION, permissionMode: 'full', resumeOf: 'sess_acp_1' },
      () => second,
    )

    expect(modeCalls(second)).toEqual(['build'])
    await buildTurn.dispose()
  }, 20000)
})

describe('launchWithEffort', () => {
  it('prepends --effort on a grok native ACP launch', () => {
    expect(
      launchWithEffort({ label: 'grok (native ACP)', command: 'grok', args: ['agent', 'stdio'] }, 'high'),
    ).toEqual({
      label: 'grok (native ACP)',
      command: 'grok',
      args: ['--effort', 'high', 'agent', 'stdio'],
    })
  })

  it('leaves other agents untouched', () => {
    const launch = { label: 'opencode (native ACP)', command: 'opencode', args: ['acp'] }
    expect(launchWithEffort(launch, 'high')).toBe(launch)
  })
})

describe('pickAgentMode', () => {
  it("maps Ari's modes onto claude-code's vocabulary", () => {
    const modes = ['default', 'acceptEdits', 'bypassPermissions', 'plan']
    expect(pickAgentMode(modes, 'ask')).toBe('default')
    expect(pickAgentMode(modes, 'allow-edits')).toBe('acceptEdits')
    expect(pickAgentMode(modes, 'full')).toBe('bypassPermissions')
  })

  it("maps Ari's modes onto opencode's build/plan pair", () => {
    const modes = ['build', 'plan']
    expect(pickAgentMode(modes, 'ask')).toBe('plan')
    expect(pickAgentMode(modes, 'allow-edits')).toBe('build')
    expect(pickAgentMode(modes, 'full')).toBe('build')
  })

  it('falls back to any non-planning mode for the build modes', () => {
    const modes = ['plan', 'somethingUnnamed']
    expect(pickAgentMode(modes, 'allow-edits')).toBe('somethingUnnamed')
    expect(pickAgentMode(modes, 'full')).toBe('somethingUnnamed')
  })

  it('never guesses for ask, so an unknown agent keeps its default', () => {
    expect(pickAgentMode(['somethingUnnamed'], 'ask')).toBeNull()
    expect(pickAgentMode([], 'full')).toBeNull()
    expect(pickAgentMode([undefined, ''], 'allow-edits')).toBeNull()
  })

  it('refuses to answer a build mode with a read-only mode', () => {
    expect(pickAgentMode(['plan', 'readOnly', 'chat'], 'full')).toBeNull()
  })

  it("leaves an axis that is not about permissions alone (pi's thinking levels)", () => {
    // pi's ACP adapter models `modes` as reasoning effort, so the build-mode
    // escape hatch used to answer with `off` and mute the agent's thinking.
    const thinking = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh']
    expect(pickAgentMode(thinking, 'ask')).toBeNull()
    expect(pickAgentMode(thinking, 'allow-edits')).toBeNull()
    expect(pickAgentMode(thinking, 'full')).toBeNull()
  })
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

describe('shouldFallBack', () => {
  it('retries ordinary transport failures on the legacy CLI', () => {
    expect(shouldFallBack(new AcpConnectionError('broken exited mid-request'))).toBe(true)
    expect(shouldFallBack(new Error('ENOENT'))).toBe(true)
  })

  it('refuses to retry an auth wall — both transports share one credential store', () => {
    expect(shouldFallBack(new AcpAuthRequiredError('sign in again', []))).toBe(false)
  })
})

async function* emptyIterator(): AsyncGenerator<never, void, undefined> {}
