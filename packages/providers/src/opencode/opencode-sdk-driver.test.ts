import type { AgentEvent } from '@ari/contracts/agent-event'
import { describe, expect, it, vi } from 'vitest'
import type { AdapterSession, Driver, ProviderAdapter } from '../driver'
import { fakeHttp } from './__fixtures__/fake-http'
import {
  OpencodeSdkDriver,
  opencodeCapabilities,
  parseAnswers,
  permissionReply,
  resolveOpencodeTransport,
} from './opencode-sdk-driver'
import type { OpencodeServer, OpencodeServerPool, ServerSpec } from './server'
import type { OcEvent, OpencodeWire } from './wire'
import { WireV1 } from './wire-v1'
import { WireV2 } from './wire-v2'

const base: AdapterSession = {
  sessionId: 'ari_1',
  workspacePath: 'D:\\work',
  prompt: 'do the thing',
  modelId: 'openrouter/anthropic/claude',
  permissionMode: 'ask',
  effort: 'high',
  resumeOf: null,
  runtimeEnv: { PATH: 'p', ARI_SESSION_ID: 'ari_1', EMPTY: undefined },
}

class FakeServer {
  readonly listeners = new Set<(event: OcEvent) => void>()
  readonly closedListeners = new Set<(reason: string) => void>()
  constructor(readonly wire: OpencodeWire) {}
  on(listener: (event: OcEvent) => void) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  onClosed(listener: (reason: string) => void) {
    this.closedListeners.add(listener)
    return () => this.closedListeners.delete(listener)
  }
  /** Feeds one raw SSE payload through the wire, as the real server does. */
  emit(raw: unknown) {
    for (const event of this.wire.normalize(raw)) for (const l of [...this.listeners]) l(event)
  }
  die(reason: string) {
    for (const l of [...this.closedListeners]) l(reason)
  }
}

function setup(
  generation: 'v1' | 'v2',
  routes: Record<string, unknown> = {},
  // Fixtures answer instantly, so the stale-idle window is off unless a test is about it.
  timing: { staleIdleMs?: number; errorSettleMs?: number } = { staleIdleMs: 0 },
  fallback?: Driver,
) {
  const { http, requests } = fakeHttp({
    'POST /session': { id: 'ses_new' },
    'POST /api/session': { data: { id: 'ses_new', permissions: [] } },
    ...routes,
  })
  const server = new FakeServer(generation === 'v1' ? new WireV1(http) : new WireV2(http, 0))
  const specs: ServerSpec[] = []
  const pool = {
    acquire: vi.fn(async (spec: ServerSpec) => {
      specs.push(spec)
      return server as unknown as OpencodeServer
    }),
    release: vi.fn(),
  }
  const driver = new OpencodeSdkDriver('opencode', {
    generation,
    pool: pool as unknown as OpencodeServerPool,
    timing,
    ...(fallback ? { fallback } : {}),
  })
  return { driver, server, pool, requests, specs }
}

/** Collects the stream until it ends, running `script` once the prompt went out. */
async function run(adapter: ProviderAdapter, script: () => void | Promise<void> = () => {}) {
  const events: AgentEvent[] = []
  const iterator = adapter.start()[Symbol.asyncIterator]()
  // Let the prompt request settle before the server "answers".
  await new Promise((resolve) => setTimeout(resolve, 0))
  await script()
  for (;;) {
    const next = await iterator.next()
    if (next.done) break
    events.push(next.value)
  }
  return events
}

function idleAdapter(): ProviderAdapter {
  return {
    start: () => (async function* (): AsyncGenerator<AgentEvent> {})(),
    interrupt: () => {},
    dispose: async () => {},
  }
}

const v1 = (type: string, properties: unknown) => ({ payload: { type, properties } })
const v2 = (type: string, data: unknown) => ({ type, data })

describe('transport selection', () => {
  it('defaults to the server and accepts acp and cli', () => {
    expect(resolveOpencodeTransport(undefined)).toBe('sdk')
    expect(resolveOpencodeTransport('ACP')).toBe('acp')
    expect(resolveOpencodeTransport('cli')).toBe('cli')
    expect(resolveOpencodeTransport('bogus')).toBe('sdk')
  })

  it('declares live steering only for OpenCode 2', () => {
    expect(opencodeCapabilities('v2').steering).toBe('live')
    expect(opencodeCapabilities('v1').steering).toBe('follow-up')
    expect(opencodeCapabilities('v1').liveResponses).toBe('approvals-and-input')
  })

  it('falls back to ACP when the server cannot start, before any prompt is sent', async () => {
    const fallbackAdapter = idleAdapter()
    const create = vi.fn(async (_session: AdapterSession) => fallbackAdapter)
    const fallback: Driver = { kind: 'opencode', create }
    const pool = {
      acquire: vi.fn(async () => Promise.reject(new Error('spawn ENOENT'))),
      release: vi.fn(),
    }
    const driver = new OpencodeSdkDriver('opencode', {
      generation: 'v1',
      fallback,
      pool: pool as unknown as OpencodeServerPool,
    })
    expect(await driver.create(base)).toBe(fallbackAdapter)
    expect(create).toHaveBeenCalledWith(base)
  })

  it('keeps a session parked on ACP there', async () => {
    const fallbackAdapter = idleAdapter()
    const fallback: Driver = {
      kind: 'opencode',
      hasLiveSession: (id) => id === 'ari_1',
      create: vi.fn(async () => fallbackAdapter),
    }
    const pool = { acquire: vi.fn(), release: vi.fn() }
    const driver = new OpencodeSdkDriver('opencode', {
      generation: 'v2',
      fallback,
      pool: pool as unknown as OpencodeServerPool,
    })
    expect(driver.hasLiveSession('ari_1')).toBe(true)
    expect(await driver.create(base)).toBe(fallbackAdapter)
    expect(pool.acquire).not.toHaveBeenCalled()
  })

  it('maps approval decisions and answers', () => {
    expect(permissionReply('allow')).toBe('once')
    expect(permissionReply('always-allow')).toBe('always')
    expect(permissionReply('deny')).toBe('reject')
    expect(permissionReply({ optionId: 'always' })).toBe('always')
    expect(permissionReply({ optionId: 'proceed' })).toBeNull()
    const one = [{ id: '0', question: 'Q', options: [], multiSelect: false }]
    expect(parseAnswers('free text', one)).toEqual({ '0': 'free text' })
    expect(parseAnswers('{"answers":{"0":["a","b"]}}', one)).toEqual({ '0': ['a', 'b'] })
    expect(parseAnswers('', one)).toEqual({})
  })
})

describe('classic OpenCode turn', () => {
  it('creates a session, prompts once, streams, and ends when the session goes idle', async () => {
    const { driver, server, pool, requests, specs } = setup('v1')
    const adapter = await driver.create(base)
    const events = await run(adapter, () => {
      server.emit(
        v1('message.part.delta', {
          sessionID: 'ses_new',
          partID: 'p1',
          field: 'text',
          delta: 'Done.',
        }),
      )
      server.emit(v1('session.idle', { sessionID: 'ses_elsewhere' }))
      server.emit(v1('session.idle', { sessionID: 'ses_new' }))
    })
    expect(events).toEqual([
      { type: 'session-ref', ref: 'ses_new' },
      { type: 'text-delta', text: 'Done.', streamId: 'p1' },
      { type: 'done', stopReason: 'completed' },
    ])
    expect(specs[0]?.env).toBe(base.runtimeEnv)
    expect(requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      'POST /session',
      'POST /session/ses_new/prompt_async',
    ])
    expect(requests[1]?.body).toMatchObject({
      parts: [{ type: 'text', text: 'do the thing' }],
      model: { providerID: 'openrouter', modelID: 'anthropic/claude' },
      variant: 'high',
    })
    await adapter.dispose()
    expect(pool.release).toHaveBeenCalledTimes(1)
    expect(server.listeners.size).toBe(0)
  })

  it('resumes an existing session and updates its rules only when the mode changes', async () => {
    const { driver, server, requests } = setup('v1', { 'GET /session/ses_old': { id: 'ses_old' } })
    for (const mode of ['full', 'full', 'ask'] as const) {
      const adapter = await driver.create({ ...base, resumeOf: 'ses_old', permissionMode: mode })
      await run(adapter, () => server.emit(v1('session.idle', { sessionID: 'ses_old' })))
      await adapter.dispose()
    }
    expect(requests.filter((r) => r.method === 'PATCH').map((r) => r.body)).toEqual([
      { permission: [{ permission: '*', pattern: '*', action: 'allow' }] },
      {
        permission: [
          { permission: 'edit', pattern: '*', action: 'ask' },
          { permission: 'bash', pattern: '*', action: 'ask' },
          { permission: 'webfetch', pattern: '*', action: 'ask' },
        ],
      },
    ])
    expect(requests.some((r) => r.method === 'POST' && r.path === '/session')).toBe(false)
  })

  it('starts fresh when the session to resume is gone', async () => {
    const { driver, server, requests } = setup('v1', {
      'GET /session/ses_gone': new Response('', { status: 404 }),
    })
    const adapter = await driver.create({ ...base, resumeOf: 'ses_gone' })
    const events = await run(adapter, () =>
      server.emit(v1('session.idle', { sessionID: 'ses_new' })),
    )
    expect(events[0]).toEqual({ type: 'session-ref', ref: 'ses_new' })
    expect(requests.some((r) => r.path === '/session/ses_gone/prompt_async')).toBe(false)
  })

  it('round-trips a permission and a question to their endpoints', async () => {
    const { driver, server, requests } = setup('v1')
    const adapter = await driver.create(base)
    const events = await run(adapter, async () => {
      server.emit(
        v1('permission.asked', {
          id: 'per_1',
          sessionID: 'ses_new',
          permission: 'bash',
          patterns: ['ls'],
        }),
      )
      server.emit(
        v1('permission.asked', { id: 'per_x', sessionID: 'ses_other', permission: 'bash' }),
      )
      server.emit(
        v1('question.asked', {
          id: 'que_1',
          sessionID: 'ses_new',
          questions: [
            { question: 'Pick', header: 'Pick', options: [{ label: 'A' }, { label: 'B' }] },
          ],
        }),
      )
      adapter.respondApproval!('per_x', 'allow')
      adapter.respondApproval!('per_1', 'always-allow')
      adapter.respondApproval!('per_1', 'allow')
      adapter.respondInput!('que_1', '{"answers":{"0":"B"}}')
      await new Promise((resolve) => setTimeout(resolve, 0))
      server.emit(v1('session.idle', { sessionID: 'ses_new' }))
    })
    expect(events.filter((e) => e.type === 'approval-requested')).toHaveLength(1)
    expect(events.filter((e) => e.type === 'input-requested')).toHaveLength(1)
    expect(requests.slice(2).map((r) => [r.path, r.body])).toEqual([
      ['/permission/per_1/reply', { reply: 'always' }],
      ['/question/que_1/reply', { answers: [['B']] }],
    ])
  })

  it('rejects a question the user dismissed', async () => {
    const { driver, server, requests } = setup('v1')
    const adapter = await driver.create(base)
    await run(adapter, async () => {
      server.emit(
        v1('question.asked', { id: 'que_1', sessionID: 'ses_new', questions: [{ question: 'Q' }] }),
      )
      adapter.respondInput!('que_1', '')
      await new Promise((resolve) => setTimeout(resolve, 0))
      server.emit(v1('session.idle', { sessionID: 'ses_new' }))
    })
    expect(requests.at(-1)?.path).toBe('/question/que_1/reject')
  })

  it('interrupts with abort and ends at once', async () => {
    const { driver, server, requests } = setup('v1')
    const adapter = await driver.create(base)
    const events = await run(adapter, async () => {
      adapter.interrupt()
      server.emit(v1('session.idle', { sessionID: 'ses_new' }))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(events.at(-1)).toEqual({ type: 'done', stopReason: 'interrupted' })
    expect(requests.at(-1)?.path).toBe('/session/ses_new/abort')
  })

  it('ignores the previous turn’s idle echo until the session shows it is working', async () => {
    const { driver, server } = setup('v1', {}, { staleIdleMs: 60_000 })
    const adapter = await driver.create(base)
    const events = await run(adapter, () => {
      server.emit(v1('session.idle', { sessionID: 'ses_new' }))
      server.emit(v1('session.status', { sessionID: 'ses_new', status: { type: 'busy' } }))
      server.emit(
        v1('message.part.delta', { sessionID: 'ses_new', partID: 'p', field: 'text', delta: 'ok' }),
      )
      server.emit(v1('session.idle', { sessionID: 'ses_new' }))
    })
    expect(events.map((e) => e.type)).toEqual(['session-ref', 'text-delta', 'done'])
  })

  it('ends a turn whose prompt failed with only an error and no idle', async () => {
    const { driver, server } = setup('v1', {}, { staleIdleMs: 0, errorSettleMs: 10 })
    const adapter = await driver.create(base)
    const events = await run(adapter, () =>
      server.emit(
        v1('session.error', {
          sessionID: 'ses_new',
          error: { name: 'UnknownError', data: { message: 'Agent not found' } },
        }),
      ),
    )
    expect(events.slice(1)).toEqual([
      { type: 'error', message: 'Agent not found', rawJson: null },
      { type: 'done', stopReason: 'error' },
    ])
  })

  it('follows the session when the prompt request times out after the work began', async () => {
    let timeOut: (error: Error) => void = () => {}
    const { driver, server } = setup('v1', {
      'POST /session/ses_new/prompt_async': () =>
        new Promise<never>((_resolve, reject) => {
          timeOut = reject
        }),
    })
    const adapter = await driver.create(base)
    const events = await run(adapter, async () => {
      server.emit(v1('session.status', { sessionID: 'ses_new', status: { type: 'busy' } }))
      timeOut(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))
      await new Promise((resolve) => setTimeout(resolve, 0))
      server.emit(
        v1('message.part.delta', { sessionID: 'ses_new', partID: 'p', field: 'text', delta: 'ok' }),
      )
      server.emit(v1('session.idle', { sessionID: 'ses_new' }))
    })
    expect(events.map((e) => e.type)).toEqual(['session-ref', 'text-delta', 'done'])
    expect(events.at(-1)).toEqual({ type: 'done', stopReason: 'completed' })
  })

  it('fails the turn when the server dies or refuses the prompt', async () => {
    const dying = setup('v1')
    const adapter = await dying.driver.create(base)
    const events = await run(adapter, () => dying.server.die('OpenCode server exited (code 1)'))
    expect(events.slice(-2)).toEqual([
      { type: 'error', message: 'OpenCode server exited (code 1)', rawJson: null },
      { type: 'done', stopReason: 'error' },
    ])
    const refusing = setup('v1', {
      'POST /session/ses_new/prompt_async': new Response('bad model', { status: 400 }),
    })
    const refused = await run(await refusing.driver.create(base))
    const refusal = refused.at(-2)
    expect(refusal?.type === 'error' && refusal.message).toContain('bad model')
    expect(refused.at(-1)).toEqual({ type: 'done', stopReason: 'error' })
  })

  it('interrupts a turn that is disposed while still running', async () => {
    const { driver, requests, pool } = setup('v1')
    const adapter = await driver.create(base)
    await new Promise((resolve) => setTimeout(resolve, 0))
    await adapter.dispose()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(requests.at(-1)?.path).toBe('/session/ses_new/abort')
    expect(pool.release).toHaveBeenCalledTimes(1)
  })

  it('runs a named command through the command route', async () => {
    const { driver, server, requests } = setup('v1')
    const adapter = await driver.create({
      ...base,
      prompt: '/review HEAD',
      command: { name: 'review', args: 'HEAD' },
    })
    await run(adapter, () => server.emit(v1('session.idle', { sessionID: 'ses_new' })))
    expect(requests[1]).toMatchObject({
      path: '/session/ses_new/command',
      body: {
        command: 'review',
        arguments: 'HEAD',
        model: 'openrouter/anthropic/claude',
        variant: 'high',
      },
    })
  })

  it('lists the server’s commands as provider-run commands', async () => {
    const { driver, pool } = setup('v1', {
      'GET /command': [{ name: 'deploy', description: 'Ship it', source: 'skill' }],
    })
    expect(await driver.listCommands({ sessionId: 'ari_1', workspacePath: 'D:\\work' })).toEqual([
      { name: 'deploy', description: 'Ship it', argumentHint: null, source: 'skill', run: 'rpc' },
    ])
    expect(pool.release).toHaveBeenCalledTimes(1)
  })
})

describe('OpenCode 2 turn', () => {
  it('gives the session its shell environment and answers forms with typed values', async () => {
    const { driver, server, requests } = setup('v2')
    const adapter = await driver.create(base)
    await run(adapter, async () => {
      server.emit(
        v2('form.created', {
          form: {
            id: 'frm_1',
            sessionID: 'ses_new',
            title: 'Setup',
            fields: [
              { key: 'n', type: 'integer', title: 'How many?' },
              { key: 'go', type: 'boolean', title: 'Go?' },
            ],
          },
        }),
      )
      adapter.respondInput!('frm_1', '{"answers":{"n":"3","go":"true"}}')
      await new Promise((resolve) => setTimeout(resolve, 0))
      server.emit(v2('session.execution.succeeded', { sessionID: 'ses_new' }))
    })
    expect(requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      'POST /api/session',
      'PUT /api/session/ses_new/environment',
      'POST /api/session/ses_new/model',
      'POST /api/session/ses_new/prompt',
      'POST /api/session/ses_new/form/frm_1/reply',
    ])
    expect(requests[1]?.body).toEqual({ variables: { PATH: 'p', ARI_SESSION_ID: 'ari_1' } })
    expect(requests[4]?.body).toEqual({ answer: { n: 3, go: true } })
  })

  it('steers a running turn, and refuses once it ended', async () => {
    const { driver, server, requests } = setup('v2', {
      'POST /api/session/ses_new/prompt': { data: {} },
    })
    const adapter = await driver.create(base)
    let accepted: boolean | undefined
    const events = await run(adapter, async () => {
      accepted = await adapter.steer!('also this')
      server.emit(v2('session.execution.interrupted', { sessionID: 'ses_new', reason: 'user' }))
    })
    expect(accepted).toBe(true)
    expect(requests.at(-1)?.body).toEqual({ text: 'also this', delivery: 'steer' })
    expect(events.at(-1)).toEqual({ type: 'done', stopReason: 'interrupted' })
    expect(await adapter.steer!('too late')).toBe(false)
  })

  it('reports a steer the server refused as not delivered', async () => {
    const { driver, server } = setup('v2', {
      // The first call is the turn's prompt; the session is gone by the steer.
      'POST /api/session/ses_new/prompt': (n: number) =>
        n === 1 ? { data: {} } : new Response('', { status: 404 }),
    })
    const adapter = await driver.create(base)
    await run(adapter, async () => {
      expect(await adapter.steer!('hello?')).toBe(false)
      server.emit(v2('session.execution.succeeded', { sessionID: 'ses_new' }))
    })
  })

  it('runs a resumed Full access session when its rules cannot be updated, and says so', async () => {
    const { driver, server } = setup('v2', {
      'GET /api/session/ses_old': { data: { id: 'ses_old' } },
      'PATCH /api/session/ses_old': new Response('', { status: 404 }),
    })
    const adapter = await driver.create({ ...base, resumeOf: 'ses_old', permissionMode: 'full' })
    const events = await run(adapter, () =>
      server.emit(v2('session.execution.succeeded', { sessionID: 'ses_old' })),
    )
    expect(events.map((e) => e.type)).toEqual(['session-ref', 'notice', 'done'])
  })

  describe('a server that drops session rules (OpenCode 2 previews)', () => {
    const preview = () => {
      const fallbackAdapter = idleAdapter()
      const create = vi.fn(async (_session: AdapterSession) => fallbackAdapter)
      const fallback: Driver = { kind: 'opencode', create }
      const setupResult = setup(
        'v2',
        {
          // No `permissions` echoed: the rules were not stored.
          'POST /api/session': { data: { id: 'ses_new' } },
          'GET /api/session/ses_old': { data: { id: 'ses_old' } },
          'PATCH /api/session/ses_old': new Response('', { status: 404 }),
        },
        { staleIdleMs: 0 },
        fallback,
      )
      return { ...setupResult, create, fallbackAdapter }
    }

    it('never prompts under Ask or Allow edits; the turn goes to the fallback', async () => {
      const { driver, requests, create, fallbackAdapter, pool } = preview()
      for (const permissionMode of ['ask', 'allow-edits'] as const)
        expect(await driver.create({ ...base, permissionMode })).toBe(fallbackAdapter)
      expect(create).toHaveBeenCalledTimes(2)
      // The first turn learned it and removed its session; the second asked nothing.
      expect(requests.map((r) => `${r.method} ${r.path}`)).toEqual([
        'POST /api/session',
        'DELETE /api/session/ses_new',
      ])
      expect(requests.some((r) => r.path.endsWith('/prompt'))).toBe(false)
      expect(pool.release).toHaveBeenCalledTimes(2)
    })

    it('does not resume a session there under Ask either', async () => {
      const { driver, requests, create } = preview()
      await driver.create({ ...base, resumeOf: 'ses_old' })
      expect(create).toHaveBeenCalledTimes(1)
      expect(requests.some((r) => r.path.endsWith('/prompt'))).toBe(false)
    })

    it('still runs Full access turns', async () => {
      const { driver, server, create } = preview()
      const adapter = await driver.create({ ...base, permissionMode: 'full' })
      const events = await run(adapter, () =>
        server.emit(v2('session.execution.succeeded', { sessionID: 'ses_new' })),
      )
      expect(events.at(-1)).toEqual({ type: 'done', stopReason: 'completed' })
      expect(create).not.toHaveBeenCalled()
    })

    it('refuses with a clear reason when there is no fallback', async () => {
      const { driver } = setup('v2', { 'POST /api/session': { data: { id: 'ses_new' } } })
      await expect(driver.create(base)).rejects.toThrow(/cannot apply per-session permission rules/)
    })
  })
})
