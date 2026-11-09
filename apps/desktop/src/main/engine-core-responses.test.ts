// @vitest-environment node
import { AriCoreDriver, type AriCoreDriverOptions } from '@ari/ari-core/driver'
import { EndpointStore } from '@ari/ari-core/endpoints'
import type { ChatRequest } from '@ari/ari-core/openai'
import type { AgentEvent } from '@ari/contracts/agent-event'
import type { Command } from '@ari/contracts/commands'
import type { JournalEvent } from '@ari/contracts/events'
import { SessionStore } from '@ari/engine/session-store'
import { getProviderCapabilities, type Driver, type ProviderAdapter } from '@ari/providers/driver'
import { DriverRegistry } from '@ari/providers/registry'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Engine } from './engine'

let dir: string
let store: SessionStore
let engine: Engine | undefined
let events: JournalEvent[]
const sessionId = 'core-response'

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ari-engine-core-responses-'))
  store = new SessionStore({ rootDir: join(dir, 'sessions') })
  engine = undefined
  events = []
})

afterEach(async () => {
  // Interrupt even a failed assertion's parked real Core request before wiping.
  if (engine) {
    await engine.dispatch({ type: 'turn.interrupt', sessionId })
    await engine.quiesce(sessionId)
  }
  await store.closeJournal(sessionId)
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

function dispatch(command: Command) {
  if (!engine) throw new Error('engine not started')
  return engine.dispatch(command)
}

async function startCore(
  client: (request: ChatRequest) => AsyncGenerator<AgentEvent>,
  options: AriCoreDriverOptions = {},
  wrap: (driver: AriCoreDriver) => Driver = (driver) => driver,
  flavor: 'openai-chat' | 'anthropic-messages' | 'ollama' = 'openai-chat',
) {
  const endpoints = new EndpointStore({ dir: join(dir, 'endpoints') })
  await endpoints.upsert({
    id: 'fixture',
    name: 'Local deterministic client',
    baseUrl: 'http://127.0.0.1:1/v1',
    flavor,
    model: 'fixture-model',
    headers: {},
  })
  const registry = new DriverRegistry()
  registry.register(
    wrap(
      new AriCoreDriver(endpoints, { ...options, clients: { ...options.clients, openai: client } }),
    ),
  )
  engine = new Engine({
    store,
    registry,
    publish: (_id, event) => events.push(event),
    resolveWorkspace: async () => dir,
    git: { captureCheckpoint: async () => ({ ok: true, value: null }) },
  })
  await store.append(sessionId, {
    type: 'session.created',
    session: {
      id: sessionId,
      projectId: 'scratch',
      title: 'Core response fixture',
      driverKind: 'ari-core',
      modelId: 'ep:fixture:fixture-model',
      permissionMode: 'ask',
      status: 'idle',
      createdAt: 1,
      updatedAt: 1,
    },
  })
  expect(
    await dispatch({ type: 'turn.start', sessionId, text: 'Run fixture', attachments: [] }),
  ).toEqual({ accepted: true })
  return engine
}

function writeCall(callId = 'write-one', path = 'allowed.txt'): AgentEvent {
  return {
    type: 'tool-started',
    callId,
    name: 'write',
    argsJson: JSON.stringify({ path, content: 'explicitly approved fixture' }),
  }
}

function questionCall(callId = 'question-one'): AgentEvent {
  return {
    type: 'tool-started',
    callId,
    name: 'ask_user_question',
    argsJson: JSON.stringify({ questions: [{ id: 'color', question: 'Which color?' }] }),
  }
}

function rounds(first: AgentEvent[], requests: ChatRequest[]) {
  return async function* (request: ChatRequest): AsyncGenerator<AgentEvent> {
    requests.push(request)
    if (requests.length === 1) yield* first
    else yield { type: 'text-delta', text: 'Fixture completed' }
    yield { type: 'done' }
  }
}

async function approval() {
  await expect.poll(async () => (await store.load(sessionId)).pendingApprovals.length).toBe(1)
  const request = (await store.load(sessionId)).pendingApprovals[0]
  if (!request) throw new Error('no approval')
  return request
}

async function input() {
  await expect.poll(async () => (await store.load(sessionId)).pendingInputs.length).toBe(1)
  const request = (await store.load(sessionId)).pendingInputs[0]
  if (!request) throw new Error('no input')
  return request
}

describe('Engine commands with the actual AriCoreDriver', () => {
  it('keeps approval/input disabled for the text-only Ollama transport', async () => {
    let streaming = false
    const active = await startCore(
      async function* () {
        yield { type: 'error', message: 'wrong protocol', rawJson: null }
      },
      {
        clients: {
          ollama: async function* (request) {
            streaming = true
            yield { type: 'text-delta', text: 'Ollama text fixture' }
            await new Promise<void>((resolve) => {
              if (request.signal?.aborted) resolve()
              else request.signal?.addEventListener('abort', () => resolve(), { once: true })
            })
            yield { type: 'done' }
          },
        },
      },
      (driver) => driver,
      'ollama',
    )
    await expect.poll(() => streaming).toBe(true)
    expect(active.liveCapabilities(sessionId)).toEqual({
      approval: false,
      question: false,
      steer: true,
    })
    expect(
      await dispatch({
        type: 'approval.respond',
        sessionId,
        approvalId: 'not-supported',
        decision: 'allow',
      }),
    ).toMatchObject({ accepted: false, reason: expect.stringContaining('callback is unavailable') })
    expect(
      await dispatch({
        type: 'input.respond',
        sessionId,
        inputId: 'not-supported',
        value: 'answer',
      }),
    ).toMatchObject({ accepted: false, reason: expect.stringContaining('callback is unavailable') })
  })

  it.each(['allow', 'deny'] as const)(
    'delivers an exact %s option once, preserving ask mode',
    async (optionId) => {
      const requests: ChatRequest[] = []
      const active = await startCore(rounds([writeCall()], requests))
      const request = await approval()
      expect(existsSync(join(dir, 'allowed.txt'))).toBe(false)
      expect(
        await dispatch({ type: 'approval.respond', sessionId, approvalId: 'stale', optionId }),
      ).toMatchObject({ accepted: false })
      expect(
        await dispatch({
          type: 'approval.respond',
          sessionId,
          approvalId: request.approvalId,
          optionId: 'forged',
        }),
      ).toMatchObject({ accepted: false })
      expect((await store.load(sessionId)).pendingApprovals).toEqual([request])
      const command: Command = {
        type: 'approval.respond',
        sessionId,
        approvalId: request.approvalId,
        optionId,
      }
      expect(await dispatch(command)).toEqual({ accepted: true })
      expect(await dispatch(command)).toMatchObject({ accepted: false })
      await active.quiesce(sessionId)
      expect(events.filter((event) => event.type === 'approval.responded')).toEqual([
        expect.objectContaining({ approvalId: request.approvalId, optionId }),
      ])
      expect((await store.load(sessionId)).session?.permissionMode).toBe('ask')
      expect(requests).toHaveLength(2)
      if (optionId === 'allow') {
        expect(await readFile(join(dir, 'allowed.txt'), 'utf8')).toBe('explicitly approved fixture')
        expect(
          requests[1]?.messages.some(
            (message) => message.role === 'tool' && message.content.includes('Wrote'),
          ),
        ).toBe(true)
      } else {
        expect(existsSync(join(dir, 'allowed.txt'))).toBe(false)
        expect(
          requests[1]?.messages.some(
            (message) => message.role === 'tool' && message.content.includes('denied by user'),
          ),
        ).toBe(true)
      }
      expect(await dispatch(command)).toMatchObject({ accepted: false })
      expect(active.liveCapabilities(sessionId)).toEqual({
        approval: false,
        question: false,
        steer: false,
      })
    },
  )

  it('does not turn allow-once into permission for a second tool call', async () => {
    const requests: ChatRequest[] = []
    const active = await startCore(
      rounds([writeCall(), writeCall('write-two', 'second.txt')], requests),
    )
    const first = await approval()
    expect(
      await dispatch({
        type: 'approval.respond',
        sessionId,
        approvalId: first.approvalId,
        decision: 'allow',
      }),
    ).toEqual({ accepted: true })
    await expect
      .poll(async () => (await store.load(sessionId)).pendingApprovals[0]?.approvalId)
      .not.toBe(first.approvalId)
    const second = await approval()
    expect(existsSync(join(dir, 'second.txt'))).toBe(false)
    expect(
      await dispatch({
        type: 'approval.respond',
        sessionId,
        approvalId: first.approvalId,
        decision: 'allow',
      }),
    ).toMatchObject({ accepted: false })
    expect(
      await dispatch({
        type: 'approval.respond',
        sessionId,
        approvalId: second.approvalId,
        decision: 'deny',
      }),
    ).toEqual({ accepted: true })
    await active.quiesce(sessionId)
    expect(existsSync(join(dir, 'allowed.txt'))).toBe(true)
    expect(existsSync(join(dir, 'second.txt'))).toBe(false)
  })

  it('answers a real Core question once and passes the exact answer to the model', async () => {
    const requests: ChatRequest[] = []
    const active = await startCore(rounds([questionCall(), questionCall('question-two')], requests))
    const first = await input()
    expect(
      await dispatch({ type: 'input.respond', sessionId, inputId: 'stale', value: 'wrong' }),
    ).toMatchObject({ accepted: false })
    const value = JSON.stringify({ answers: { color: 'ultramarine' } })
    const command: Command = { type: 'input.respond', sessionId, inputId: first.inputId, value }
    expect(await dispatch(command)).toEqual({ accepted: true })
    await expect
      .poll(async () => (await store.load(sessionId)).pendingInputs[0]?.inputId)
      .not.toBe(first.inputId)
    const second = await input()
    expect(await dispatch(command)).toMatchObject({ accepted: false })
    expect((await store.load(sessionId)).pendingInputs).toEqual([second])
    expect(
      await dispatch({ type: 'input.respond', sessionId, inputId: second.inputId, value: 'teal' }),
    ).toEqual({ accepted: true })
    await active.quiesce(sessionId)
    expect(
      requests[1]?.messages
        .filter((message) => message.role === 'tool')
        .map((message) => message.content),
    ).toEqual([JSON.stringify('Which color?: ultramarine'), JSON.stringify('Which color?: teal')])
    expect(events.filter((event) => event.type === 'input.responded')).toHaveLength(2)
    expect(await dispatch(command)).toMatchObject({ accepted: false })
  })

  it('steers the live Core model call through the queued Engine command without replaying a turn', async () => {
    const requests: ChatRequest[] = []
    const active = await startCore(async function* (request) {
      requests.push(request)
      if (requests.length === 1) {
        await new Promise<void>((resolve) => {
          if (request.signal?.aborted) resolve()
          else request.signal?.addEventListener('abort', () => resolve(), { once: true })
        })
      } else yield { type: 'text-delta', text: 'Steered fixture completed' }
      yield { type: 'done' }
    })
    await expect.poll(() => requests.length).toBe(1)
    const turnId = (await store.load(sessionId)).activeTurnId
    const text = 'Use the revised fixture instruction'
    expect(await dispatch({ type: 'message.enqueue', sessionId, text, attachments: [] })).toEqual({
      accepted: true,
    })
    expect(await dispatch({ type: 'message.steer', sessionId, text, attachments: [] })).toEqual({
      accepted: true,
    })
    await active.quiesce(sessionId)
    expect(requests[0]?.signal?.aborted).toBe(true)
    expect(requests).toHaveLength(2)
    expect(requests[1]?.messages.filter((message) => message.content === text)).toEqual([
      { role: 'user', content: text },
    ])
    expect(events.filter((event) => event.type === 'turn.started')).toEqual([
      expect.objectContaining({ turnId }),
    ])
    expect((await store.load(sessionId)).queuedMessages).toEqual([])
    expect(
      await dispatch({ type: 'message.steer', sessionId, text, attachments: [] }),
    ).toMatchObject({ accepted: false })
  })

  it.each(['approval', 'input'] as const)(
    'cancels a parked %s without executing or continuing work',
    async (kind) => {
      const requests: ChatRequest[] = []
      const active = await startCore(
        rounds([kind === 'approval' ? writeCall() : questionCall()], requests),
      )
      const command: Command =
        kind === 'approval'
          ? {
              type: 'approval.respond',
              sessionId,
              approvalId: (await approval()).approvalId,
              decision: 'allow',
            }
          : { type: 'input.respond', sessionId, inputId: (await input()).inputId, value: 'late' }
      expect(await dispatch({ type: 'turn.interrupt', sessionId })).toEqual({ accepted: true })
      expect(await dispatch(command)).toMatchObject({ accepted: false })
      await active.quiesce(sessionId)
      expect(requests).toHaveLength(1)
      expect(existsSync(join(dir, 'allowed.txt'))).toBe(false)
      expect(await store.load(sessionId)).toMatchObject({
        activeTurnId: null,
        pendingApprovals: [],
        pendingInputs: [],
      })
      expect(
        events.filter(
          (event) => event.type === 'approval.responded' || event.type === 'input.responded',
        ),
      ).toEqual([])
    },
  )

  it('keeps allowlist restrictions after explicit approval', async () => {
    const requests: ChatRequest[] = []
    const active = await startCore(rounds([writeCall()], requests), {
      allowlist: [{ tool: 'write', pattern: '*permitted.txt*' }],
    })
    const request = await approval()
    expect(
      await dispatch({
        type: 'approval.respond',
        sessionId,
        approvalId: request.approvalId,
        decision: 'allow',
      }),
    ).toEqual({ accepted: true })
    await active.quiesce(sessionId)
    expect(existsSync(join(dir, 'allowed.txt'))).toBe(false)
    expect(requests[1]?.messages.some((message) => message.content.includes('allowlist'))).toBe(
      true,
    )
  })

  it.each(['undeclared', 'unsupported'] as const)(
    'keeps %s adapter controls disabled even when the Core methods exist',
    async (declaration) => {
      const requests: ChatRequest[] = []
      const active = await startCore(rounds([writeCall()], requests), {}, (driver) => ({
        kind: driver.kind,
        capabilities: () => getProviderCapabilities(driver),
        create: async (session) => {
          const adapter = await driver.create(session)
          const { capabilities: _declaration, ...methods } = adapter
          const masked: ProviderAdapter =
            declaration === 'undeclared'
              ? methods
              : {
                  ...methods,
                  capabilities: () => ({
                    ...getProviderCapabilities(adapter),
                    liveResponses: false,
                    steering: false,
                  }),
                }
          return masked
        },
      }))
      const request = await approval()
      expect(active.liveCapabilities(sessionId)).toEqual({
        approval: false,
        question: false,
        steer: false,
      })
      expect(
        await dispatch({
          type: 'approval.respond',
          sessionId,
          approvalId: request.approvalId,
          decision: 'allow',
        }),
      ).toMatchObject({
        accepted: false,
        reason: expect.stringContaining('callback is unavailable'),
      })
      expect(existsSync(join(dir, 'allowed.txt'))).toBe(false)
    },
  )

  it('does not recover response callbacks by replaying a live journal in a new Engine', async () => {
    const requests: ChatRequest[] = []
    await startCore(rounds([writeCall()], requests))
    const request = await approval()
    const coldStore = new SessionStore({ rootDir: join(dir, 'sessions') })
    const cold = new Engine({
      store: coldStore,
      registry: new DriverRegistry(),
      publish: () => undefined,
    })
    expect(cold.liveCapabilities(sessionId)).toEqual({
      approval: false,
      question: false,
      steer: false,
    })
    expect(
      await cold.dispatch({
        type: 'approval.respond',
        sessionId,
        approvalId: request.approvalId,
        decision: 'allow',
      }),
    ).toMatchObject({ accepted: false, reason: expect.stringContaining('callback is unavailable') })
    expect(requests).toHaveLength(1)
    expect(existsSync(join(dir, 'allowed.txt'))).toBe(false)
    await coldStore.closeJournal(sessionId)
  })
})
