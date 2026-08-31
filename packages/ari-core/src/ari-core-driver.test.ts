import { describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent } from '@ari/contracts/agent-event'
import { AriCoreDriver } from './ari-core-driver'
import { EndpointStore } from './endpoints'
import type { ChatRequest } from './protocols/openai-chat'
import type { AnthropicChatRequest } from './protocols/anthropic-messages'
import type { OllamaChatRequest } from './protocols/ollama'
import { TRIMMED_TOOL_RESULTS_PLACEHOLDER } from './context-manager'

function makeSession(
  workspacePath: string,
  prompt: string,
  endpointId: string,
  permissionMode: 'ask' | 'allow-edits' | 'full' = 'ask',
) {
  return {
    sessionId: 's1',
    workspacePath,
    prompt,
    modelId: endpointId,
    permissionMode,
    resumeOf: null,
  }
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = []
  for await (const event of events) out.push(event)
  return out
}

describe('ari core driver flavor routing', () => {
  it('routes openai-chat endpoints through streamChatCompletion shape', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ari-driver-'))
    try {
      const endpoints = new EndpointStore({ dir })
      await endpoints.upsert({
        id: 'ep-oai',
        name: 'Router',
        baseUrl: 'https://oai.test/v1',
        flavor: 'openai-chat',
        model: 'gpt-test',
        headers: {},
      })
      const requests: ChatRequest[] = []
      const driver = new AriCoreDriver(endpoints, {
        clients: {
          openai: async function* (request) {
            requests.push(request)
            yield { type: 'text-delta', text: 'hi' }
            yield { type: 'usage', inputTokens: 1, outputTokens: 1, costUsd: null }
            yield { type: 'done' }
          },
        },
      })
      const adapter = await driver.create(makeSession(dir, 'hello', 'ep-oai'))
      const events = await collect(adapter.start())

      expect(requests).toHaveLength(1)
      expect(requests[0]?.model).toBe('gpt-test')
      expect(requests[0]?.baseUrl).toBe('https://oai.test/v1')
      const systemMessage = requests[0]?.messages?.[0]
      expect(systemMessage?.role).toBe('system')
      expect(typeof systemMessage?.content).toBe('string')
      expect(requests[0]?.messages?.at(-1)).toEqual({ role: 'user', content: 'hello' })
      expect(events.at(-1)).toEqual({ type: 'done' })
      expect(events.some((e) => e.type === 'text-delta')).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('routes anthropic-messages endpoints, hoisting the system prompt', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ari-driver-an-'))
    try {
      await writeFile(join(dir, 'note.txt'), 'note body', 'utf8')
      const endpoints = new EndpointStore({ dir })
      await endpoints.upsert({
        id: 'ep-an',
        name: 'Anthropic',
        baseUrl: 'https://an.test',
        flavor: 'anthropic-messages',
        model: 'claude-test',
        headers: {},
      })
      const requests: AnthropicChatRequest[] = []
      const driver = new AriCoreDriver(endpoints, {
        clients: {
          anthropic: async function* (request) {
            requests.push(request)
            if (requests.length === 1) {
              yield {
                type: 'tool-started',
                callId: 'c1',
                name: 'read',
                argsJson: '{"path":"note.txt"}',
              }
            } else {
              yield { type: 'text-delta', text: 'read it' }
            }
            yield { type: 'usage', inputTokens: 1, outputTokens: 1, costUsd: null }
            yield { type: 'done' }
          },
        },
      })
      const adapter = await driver.create(makeSession(dir, 'read the note', 'ep-an'))
      await collect(adapter.start())

      expect(requests).toHaveLength(2)
      const first = requests[0]
      expect(first?.system).toContain('Ari Core')
      expect(first?.messages).toEqual([{ role: 'user', content: 'read the note' }])

      // second round maps the tool exchange onto plain user/assistant turns
      const second = requests[1]
      expect(second?.system).toContain('Ari Core')
      expect(second?.messages).toEqual([
        { role: 'user', content: 'read the note' },
        { role: 'assistant', content: '[tool call read] {"path":"note.txt"}' },
        { role: 'user', content: '[tool result c1]\n"note body"' },
      ])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('routes ollama endpoints keeping the system role inline', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ari-driver-ol-'))
    try {
      const endpoints = new EndpointStore({ dir })
      await endpoints.upsert({
        id: 'ep-ol',
        name: 'Local',
        baseUrl: 'http://localhost:11434',
        flavor: 'ollama',
        model: 'llama-test',
        headers: {},
      })
      const requests: OllamaChatRequest[] = []
      const driver = new AriCoreDriver(endpoints, {
        clients: {
          ollama: async function* (request) {
            requests.push(request)
            yield { type: 'text-delta', text: 'local hi' }
            yield { type: 'usage', inputTokens: 1, outputTokens: 1, costUsd: null }
            yield { type: 'done' }
          },
        },
      })
      const adapter = await driver.create(makeSession(dir, 'ollama hello', 'ep-ol'))
      await collect(adapter.start())

      expect(requests).toHaveLength(1)
      expect(requests[0]?.model).toBe('llama-test')
      expect(requests[0]?.messages?.[0]?.role).toBe('system')
      expect(requests[0]?.messages?.at(-1)).toEqual({
        role: 'user',
        content: 'ollama hello',
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('trims oversized history before a round via the context manager', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ari-driver-trim-'))
    try {
      await writeFile(join(dir, 'note.txt'), 'secret file body', 'utf8')
      const endpoints = new EndpointStore({ dir })
      await endpoints.upsert({
        id: 'ep-trim',
        name: 'Tiny',
        baseUrl: 'https://tiny.test/v1',
        flavor: 'openai-chat',
        model: 'm',
        headers: {},
      })
      const requests: ChatRequest[] = []
      const driver = new AriCoreDriver(endpoints, {
        contextCharLimit: 60,
        clients: {
          openai: async function* (request) {
            requests.push(request)
            if (requests.length === 1) {
              yield {
                type: 'tool-started',
                callId: 'c1',
                name: 'read',
                argsJson: '{"path":"note.txt"}',
              }
            } else {
              yield { type: 'text-delta', text: 'got it' }
            }
            yield { type: 'usage', inputTokens: 1, outputTokens: 1, costUsd: null }
            yield { type: 'done' }
          },
        },
      })
      const adapter = await driver.create(makeSession(dir, 'read note', 'ep-trim'))
      const events = await collect(adapter.start())

      expect(events.at(-1)).toEqual({ type: 'done' })
      const secondRound = requests[1]?.messages ?? []
      expect(
        secondRound.some((m) => m.content === TRIMMED_TOOL_RESULTS_PLACEHOLDER),
      ).toBe(true)
      expect(secondRound.some((m) => m.content.includes('secret file body'))).toBe(false)
      // latest user message survives trimming
      expect(secondRound.some((m) => m.role === 'user' && m.content === 'read note')).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('errors clearly when the endpoint id is unknown', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ari-driver-miss-'))
    try {
      const endpoints = new EndpointStore({ dir })
      const driver = new AriCoreDriver(endpoints)
      const adapter = await driver.create(makeSession(dir, 'x', 'nope'))
      const events = await collect(adapter.start())
      const firstEvent = events[0]
      expect(firstEvent?.type).toBe('error')
      if (firstEvent?.type === 'error') expect(firstEvent.message).toContain('nope')
      expect(events.at(-1)).toEqual({ type: 'done' })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('strips the UI `ep:` prefix from modelId before endpoint lookup', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ari-core-ep-'))
    try {
      const endpoints = new EndpointStore({ dir })
      await endpoints.upsert({
        id: 'oai',
        name: 'Router',
        baseUrl: 'https://oai.test/v1',
        flavor: 'openai-chat',
        model: 'gpt-test',
        headers: {},
      })
      const requests: ChatRequest[] = []
      const driver = new AriCoreDriver(endpoints, {
        clients: {
          openai: async function* (request) {
            requests.push(request)
            yield { type: 'text-delta', text: 'hi' }
            yield { type: 'usage', inputTokens: 1, outputTokens: 1, costUsd: null }
            yield { type: 'done' }
          },
        },
      })
      // The ModelSelector and WelcomePanel namespace endpoint ids as `ep:<id>`.
      const adapter = await driver.create(makeSession(dir, 'hello', 'ep:oai'))
      const events = await collect(adapter.start())

      expect(requests).toHaveLength(1)
      expect(requests[0]?.model).toBe('gpt-test')
      expect(events.some((e) => e.type === 'error')).toBe(false)
      expect(events[0]).toEqual({ type: 'text-delta', text: 'hi' })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('ari core driver permission enforcement', () => {
  async function scriptedDriver(dir: string): Promise<AriCoreDriver> {
    const endpoints = new EndpointStore({ dir })
    await endpoints.upsert({
      id: 'ep-perm',
      name: 'Router',
      baseUrl: 'https://oai.test/v1',
      flavor: 'openai-chat',
      model: 'm',
      headers: {},
    })
    let round = 0
    return new AriCoreDriver(endpoints, {
      clients: {
        openai: async function* () {
          round++
          if (round === 1) {
            yield {
              type: 'tool-started',
              callId: 'c1',
              name: 'bash',
              argsJson: JSON.stringify({ command: 'echo gated-run' }),
            }
          } else {
            yield { type: 'text-delta', text: 'finished' }
          }
          yield { type: 'usage', inputTokens: 1, outputTokens: 1, costUsd: null }
          yield { type: 'done' }
        },
      },
    })
  }

  it('parks ask-mode bash calls on approval-requested and forwards decisions', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ari-driver-appr-'))
    try {
      const driver = await scriptedDriver(dir)
      const adapter = await driver.create(makeSession(dir, 'run', 'ep-perm', 'ask'))
      const iterator = adapter.start()[Symbol.asyncIterator]()
      const events: AgentEvent[] = []
      for (;;) {
        const next = await iterator.next()
        if (next.done) break
        events.push(next.value)
        if (next.value.type === 'approval-requested') break
      }
      const request = events.at(-1)
      if (request?.type !== 'approval-requested') throw new Error('expected approval-requested')
      expect(request.toolName).toBe('bash')
      expect(request.summaryJson).toContain('gated-run')

      adapter.respondApproval?.(request.approvalId, 'deny')
      const denied = await iterator.next()
      if (denied.done || denied.value.type !== 'tool-completed') {
        throw new Error('expected tool-completed after decision')
      }
      expect(denied.value.isError).toBe(true)
      expect(denied.value.resultJson).toContain("denied by user under permission mode 'ask'")

      for (;;) {
        const next = await iterator.next()
        if (next.done) break
        events.push(next.value)
      }
      expect(events.some((e) => e.type === 'text-delta')).toBe(true)
      expect(events.at(-1)).toEqual({ type: 'done' })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('runs bash without approvals in full mode', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ari-driver-full-'))
    try {
      const driver = await scriptedDriver(dir)
      const adapter = await driver.create(makeSession(dir, 'run', 'ep-perm', 'full'))
      const events = await collect(adapter.start())
      expect(events.some((e) => e.type === 'approval-requested')).toBe(false)
      const completed = events.find((e) => e.type === 'tool-completed')
      if (completed?.type !== 'tool-completed') throw new Error('expected tool-completed')
      expect(completed.isError).toBe(false)
      expect(completed.resultJson).toContain('gated-run')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('denies parked approvals when the adapter is disposed mid-wait', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ari-driver-dispose-'))
    try {
      const driver = await scriptedDriver(dir)
      const adapter = await driver.create(makeSession(dir, 'run', 'ep-perm', 'ask'))
      const iterator = adapter.start()[Symbol.asyncIterator]()
      for (;;) {
        const next = await iterator.next()
        if (next.done) throw new Error('stream ended before approval-requested')
        if (next.value.type === 'approval-requested') break
      }
      await adapter.dispose()
      const after = await iterator.next()
      if (after.done || after.value.type !== 'tool-completed') {
        throw new Error('expected tool-completed after dispose')
      }
      expect(after.value.isError).toBe(true)
      expect(after.value.resultJson).toContain("denied by user under permission mode 'ask'")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
