// @vitest-environment node
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExternalSource } from '@ari/contracts/external'
import type { PermissionMode } from '@ari/contracts/common'
import type { SlackConfigure, SlackSnapshot } from '@ari/contracts/slack'
import type {
  ExternalTaskHost,
  ExternalTaskView,
  ExternalPendingRequest,
} from '../../external/task-host'
import { ExternalTaskError } from '../../external/task-host'
import { SlackService } from './service'
import {
  SlackTransportError,
  type SlackEnvelope,
  type SlackIdentity,
  type SlackModal,
  type SlackReply,
  type SlackTransport,
} from './transport'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

class MemoryTransport implements SlackTransport {
  frames: { channel: string; thread: string; reply: SlackReply; timestamp: string }[] = []
  edits: { channel: string; timestamp: string; reply: SlackReply }[] = []
  modals: SlackModal[] = []
  handler: ((event: SlackEnvelope) => Promise<unknown>) | null = null
  nextError: SlackTransportError | null = null
  closed = false
  identity(): Promise<SlackIdentity> {
    return Promise.resolve({
      workspaceId: 'TTEAM123',
      workspaceName: 'Fixture team',
      botUserId: 'UBOT123',
      appId: 'AAPP123',
    })
  }
  start(
    handler: (event: SlackEnvelope) => Promise<unknown>,
    state: (state: 'connected' | 'reconnecting' | 'error') => void,
  ): Promise<void> {
    this.handler = handler
    state('connected')
    return Promise.resolve()
  }
  post(channel: string, thread: string, reply: SlackReply): Promise<string> {
    if (this.nextError) {
      const error = this.nextError
      this.nextError = null
      return Promise.reject(error)
    }
    const timestamp = `10.${String(this.frames.length + 1).padStart(6, '0')}`
    this.frames.push({ channel, thread, reply, timestamp })
    return Promise.resolve(timestamp)
  }
  update(channel: string, timestamp: string, reply: SlackReply): Promise<string> {
    this.edits.push({ channel, timestamp, reply })
    return Promise.resolve(timestamp)
  }
  openModal(_trigger: string, modal: SlackModal): Promise<void> {
    this.modals.push(modal)
    return Promise.resolve()
  }
  close(): Promise<void> {
    this.closed = true
    return Promise.resolve()
  }
}

class MemoryHost implements ExternalTaskHost {
  sessions = new Map<string, ExternalTaskView>()
  creates: string[] = []
  prompts: { sessionId: string; text: string; source: ExternalSource }[] = []
  answers: { request: ExternalPendingRequest; value: string }[] = []
  stopped: string[] = []
  requestIds = new Set<string>()
  beforeCreate: (() => Promise<void>) | null = null
  observer: (() => void) | null = null
  projects(): Promise<SlackSnapshot['projects']> {
    return Promise.resolve([
      {
        id: 'project_one',
        name: 'Ari',
        ready: true,
        reason: null,
        defaultAgent: {
          driverKind: 'claude',
          modelId: 'fixture-model',
          effort: 'high',
          permissionMode: 'full',
        },
      },
    ])
  }
  catalog(): Promise<SlackSnapshot['providers']> {
    return Promise.resolve([
      {
        driverKind: 'claude',
        available: true,
        models: [{ id: 'fixture-model', efforts: ['high'] }],
      },
    ])
  }
  async create(
    input: {
      sessionId: string
      projectId: string
      text: string
      source: ExternalSource
      permissionMode: PermissionMode
    },
    guard: () => void,
  ) {
    guard()
    await this.beforeCreate?.()
    guard()
    this.creates.push(input.sessionId)
    this.sessions.set(input.sessionId, {
      sessionId: input.sessionId,
      projectId: input.projectId,
      connectorId: input.source.connectorId,
      title: `Slack · ${input.text}`,
      permissionMode: input.permissionMode,
      archived: false,
      activeTurnId: null,
      queued: 0,
      workingChildren: 0,
      pending: [],
      lastTurn: null,
      seq: 0,
    })
    return {
      driverKind: 'claude' as const,
      modelId: 'fixture-model',
      effort: 'high',
      permissionMode: input.permissionMode,
      source: 'project' as const,
    }
  }
  view(id: string, projectId: string): Promise<ExternalTaskView | null> {
    const view = this.sessions.get(id)
    return Promise.resolve(view?.projectId === projectId ? structuredClone(view) : null)
  }
  hasRequest(_id: string, requestId: string): Promise<boolean> {
    return Promise.resolve(this.requestIds.has(requestId))
  }
  prompt(
    sessionId: string,
    _project: string,
    text: string,
    source: ExternalSource,
    _ceiling: PermissionMode,
    guard: () => void,
  ): Promise<{ queued: boolean }> {
    guard()
    const view = this.sessions.get(sessionId)!
    const queued = view.activeTurnId !== null
    this.prompts.push({ sessionId, text, source })
    this.requestIds.add(source.requestId)
    if (queued) view.queued++
    else view.activeTurnId = `turn_${this.prompts.length}`
    view.seq++
    this.observer?.()
    return Promise.resolve({ queued })
  }
  stop(id: string, _project: string, _ceiling: PermissionMode, guard: () => void): Promise<void> {
    guard()
    this.stopped.push(id)
    const view = this.sessions.get(id)!
    view.lastTurn = { id: view.activeTurnId!, outcome: 'interrupted', text: '', error: null }
    view.activeTurnId = null
    view.seq++
    this.observer?.()
    return Promise.resolve()
  }
  answer(
    _root: string,
    _project: string,
    request: ExternalPendingRequest,
    value: string,
    _ceiling: PermissionMode,
    guard: () => void,
  ): Promise<void> {
    guard()
    const view = this.sessions.get(request.sessionId)!
    if (
      !view.pending.some(
        (current) => current.turnId === request.turnId && current.id === request.id,
      )
    )
      return Promise.reject(new ExternalTaskError('stale', 'The request changed.'))
    this.answers.push({ request, value })
    view.pending = []
    view.seq++
    this.observer?.()
    return Promise.resolve()
  }
  subscribe(callback: () => void): () => void {
    this.observer = callback
    return () => {
      this.observer = null
    }
  }
}

let directory: string
let host: MemoryHost
let service: SlackService
let transports: MemoryTransport[]
const config: SlackConfigure = {
  botToken: 'xoxb-fixture-token',
  appToken: 'xapp-fixture-token',
  ownerUserId: 'UOWNER123',
  permissionMode: 'ask',
  routes: [{ channelId: 'CROOM123', projectId: 'project_one' }],
}
const box = {
  encrypt: (text: string) => Buffer.from(`fixture:${text}`).toString('base64'),
  decrypt: (cipher: string) => Buffer.from(cipher, 'base64').toString().slice('fixture:'.length),
}

function makeService() {
  return new SlackService({
    path: join(directory, 'state.json'),
    secrets: () => box,
    host,
    transport: () => {
      const transport = new MemoryTransport()
      transports.push(transport)
      return transport
    },
    postIntervalMs: 0,
  })
}
function mention(
  eventId: string,
  text: string,
  options: {
    thread?: string
    ts?: string
    user?: string
    channel?: string
    team?: string
    subtype?: string
    bot?: string
    app?: string
  } = {},
): SlackEnvelope {
  return {
    type: 'events_api',
    envelopeId: `delivery_${eventId}`,
    body: {
      type: 'event_callback',
      team_id: options.team ?? 'TTEAM123',
      api_app_id: options.app ?? 'AAPP123',
      event_id: eventId,
      event: {
        type: 'app_mention',
        user: options.user ?? 'UOWNER123',
        channel: options.channel ?? 'CROOM123',
        text: `<@UBOT123> ${text}`,
        ts: options.ts ?? '1.000001',
        ...(options.thread ? { thread_ts: options.thread } : {}),
        ...(options.subtype ? { subtype: options.subtype } : {}),
        ...(options.bot ? { bot_id: options.bot } : {}),
      },
    },
  }
}
function action(callbackId: string, user = 'UOWNER123', timestamp = '20.000001'): SlackEnvelope {
  return {
    type: 'interactive',
    envelopeId: `action_${timestamp}`,
    body: {
      type: 'block_actions',
      team: { id: 'TTEAM123' },
      user: { id: user },
      channel: { id: 'CROOM123' },
      message: { ts: '10.000002', thread_ts: '1.000001' },
      trigger_id: 'fixture-trigger',
      actions: [{ action_id: 'ari_approval', value: callbackId, action_ts: timestamp }],
    },
  }
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ari-slack-service-'))
  host = new MemoryHost()
  transports = []
  service = makeService()
  expect((await service.configure(config)).ok).toBe(true)
})
afterEach(async () => {
  await service.close()
  const pathFromTemp = relative(tmpdir(), directory)
  if (isAbsolute(pathFromTemp) || pathFromTemp.startsWith('..'))
    throw new Error('Unsafe fixture cleanup path')
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

describe('authorized Slack task loop', () => {
  it('stores a request before acknowledging, deduplicates retries, and continues its root thread', async () => {
    const gate = deferred()
    host.beforeCreate = () => gate.promise
    const event = mention('Ev1', 'fix the test')
    await service.receive(event)
    const saved: unknown = JSON.parse(await readFile(join(directory, 'state.json'), 'utf8'))
    expect(saved).toMatchObject({ requests: expect.any(Object) })
    expect(Object.values(service.store.state.requests)).toHaveLength(1)
    await service.receive({ ...event, envelopeId: 'another_socket_delivery' })
    expect(Object.values(service.store.state.requests)).toHaveLength(1)
    gate.resolve()
    await service.flush()
    expect(host.creates).toHaveLength(1)
    expect(host.prompts).toHaveLength(1)
    await service.receive(
      mention('Ev2', 'also cover keyboard navigation', { thread: '1.000001', ts: '2.000001' }),
    )
    await service.flush()
    expect(host.creates).toHaveLength(1)
    expect(host.prompts[1]?.sessionId).toBe(host.prompts[0]?.sessionId)
    expect(host.sessions.get(host.creates[0]!)?.queued).toBe(1)
    expect(transports[0]!.frames.every((frame) => frame.thread === '1.000001')).toBe(true)
  })

  it('keeps two threads separate and status queries out of the agent', async () => {
    await service.receive(mention('Ev1', 'first task'))
    await service.receive(mention('Ev2', 'second task', { ts: '2.000001' }))
    await service.flush()
    expect(new Set(host.creates).size).toBe(2)
    await service.receive(mention('Ev3', 'status', { thread: '1.000001', ts: '3.000001' }))
    await service.flush()
    expect(host.prompts).toHaveLength(2)
    expect(transports[0]!.frames.some((frame) => frame.reply.text.includes('is running'))).toBe(
      true,
    )
  })

  it('ignores other members, workspaces, apps, channels, bots, and edited messages', async () => {
    for (const options of [
      { user: 'UOTHER123' },
      { team: 'TOTHER123' },
      { app: 'AOTHER123' },
      { channel: 'COTHER123' },
      { bot: 'BOTHER123' },
      { subtype: 'message_changed' },
    ])
      await service.receive(mention(`Ev_${JSON.stringify(options)}`, 'run this', options))
    await service.flush()
    expect(host.creates).toHaveLength(0)
    expect(host.prompts).toHaveLength(0)
    expect(Object.values(service.store.state.requests)).toHaveLength(0)
  })

  it('refuses a project outside the channel mapping before reserving a session', async () => {
    await service.receive(mention('Ev1', 'in Private Project: inspect secrets'))
    await service.flush()
    expect(host.creates).toHaveLength(0)
    expect(Object.values(service.store.state.bindings)).toHaveLength(0)
    expect(transports[0]!.frames.some((frame) => frame.reply.text.includes('not mapped'))).toBe(
      true,
    )
  })

  it('fences a preparation and late socket delivery after disconnect', async () => {
    const gate = deferred()
    host.beforeCreate = () => gate.promise
    const lateHandler = transports[0]!.handler!
    await service.receive(mention('Ev1', 'paused preparation'))
    await vi.waitFor(() => expect(Object.values(service.store.state.bindings)).toHaveLength(1))
    await service.disconnect()
    gate.resolve()
    await service.flush()
    await lateHandler(mention('Ev2', 'late request', { ts: '2.000001' }))
    expect(host.creates).toHaveLength(0)
    expect(host.prompts).toHaveLength(0)
    expect(Object.values(service.store.state.requests)).toHaveLength(1)
    expect(transports[0]!.closed).toBe(true)
  })

  it('recovers a submitting prompt from its journal identity without resubmitting', async () => {
    await service.receive(mention('Ev1', 'one task'))
    await service.flush()
    const id = Object.keys(service.store.state.requests)[0]!
    await service.store.update((state) => {
      state.requests[id]!.phase = 'submitting'
    })
    await service.close()
    service = makeService()
    await service.startSaved()
    await service.flush()
    expect(host.creates).toHaveLength(1)
    expect(host.prompts).toHaveLength(1)
    expect(service.store.state.requests[id]?.phase).toBe('completed')
  })

  it('retains an unconfirmed creation identity across restart without another creation attempt', async () => {
    await service.receive(mention('Ev1', 'one task'))
    await service.flush()
    const id = Object.keys(service.store.state.requests)[0]!,
      sessionId = host.creates[0]!
    await service.store.update((state) => {
      state.requests[id]!.phase = 'creating'
      const binding = Object.values(state.bindings)[0]!
      binding.state = 'reserved'
    })
    host.sessions.delete(sessionId)
    host.requestIds.clear()
    await service.close()
    service = makeService()
    await service.startSaved()
    await service.flush()
    expect(host.creates).toHaveLength(1)
    expect(service.store.state.requests[id]).toMatchObject({ phase: 'uncertain', sessionId })
    expect((await service.snapshot()).uncertainRequests).toBe(1)
  })

  it('stores tokens encrypted and omits them from snapshots and request records', async () => {
    const stored = await readFile(join(directory, 'state.json'), 'utf8')
    expect(stored).not.toContain(config.botToken!)
    expect(stored).not.toContain(config.appToken!)
    const snapshot = JSON.stringify(await service.snapshot())
    expect(snapshot).not.toContain(config.botToken!)
    expect(snapshot).not.toContain(config.appToken!)
    expect(snapshot).not.toContain('secrets')
  })

  it('fails closed on unreadable history and requires explicit forgetting before reconnecting', async () => {
    await service.receive(mention('Ev1', 'A preserved task'))
    await service.flush()
    await service.close()
    await writeFile(join(directory, 'state.json'), '{broken history')
    service = makeService()
    expect((await service.snapshot()).status).toBe('error')
    expect((await service.configure(config)).ok).toBe(false)
    expect(await readFile(join(directory, 'state.json'), 'utf8')).toBe('{broken history')
    expect((await service.forget()).ok).toBe(true)
    expect((await service.snapshot()).hasCredentials).toBe(false)
    expect(host.sessions.size).toBe(1)
  })
})

describe('provider answers and outbound recovery', () => {
  async function approval() {
    await service.receive(mention('Ev1', 'approval task'))
    await service.flush()
    const view = host.sessions.get(host.creates[0]!)!
    view.pending = [
      {
        kind: 'approval',
        sessionId: view.sessionId,
        turnId: view.activeTurnId!,
        id: 'approval-one',
        prompt: 'Run tests',
        choicesJson: null,
        available: true,
        options: [{ optionId: 'allow-once-exact', name: 'Allow once', kind: 'allow_once' }],
      },
    ]
    view.seq++
    await service.flush()
    return Object.values(service.store.state.callbacks).find(
      (callback) => callback.kind === 'approval',
    )!
  }

  it('submits only the offered option and rejects other members and stale turns', async () => {
    const callback = await approval()
    await service.receive(action(callback.id, 'UOTHER123'))
    await service.flush()
    expect(host.answers).toHaveLength(0)
    await service.receive(action(callback.id))
    await service.flush()
    expect(host.answers[0]?.value).toBe('allow-once-exact')
    const view = host.sessions.get(host.creates[0]!)!
    view.activeTurnId = 'a-new-turn'
    view.pending = [{ ...host.answers[0]!.request, turnId: 'a-new-turn' }]
    await service.receive(action(callback.id, 'UOWNER123', '21.000001'))
    await service.flush()
    expect(host.answers).toHaveLength(1)
  })

  it('invalidates old buttons after an explicit reconnection', async () => {
    const callback = await approval()
    await service.configure({ ...config, botToken: undefined, appToken: undefined })
    await service.flush()
    await service.receive(action(callback.id))
    await service.flush()
    expect(host.answers).toHaveLength(0)
    expect(
      Object.values(service.store.state.callbacks).some(
        (value) => value.revision !== callback.revision,
      ),
    ).toBe(true)
  })

  it('updates one progress message and posts a final result once', async () => {
    await service.receive(mention('Ev1', 'task'))
    await service.flush()
    const view = host.sessions.get(host.creates[0]!)!
    view.lastTurn = {
      id: view.activeTurnId!,
      outcome: 'completed',
      text: 'The tests passed.',
      error: null,
    }
    view.activeTurnId = null
    view.seq++
    await service.flush()
    await service.flush()
    expect(
      transports[0]!.frames.filter((frame) => frame.reply.text.startsWith('Finished ·')),
    ).toHaveLength(1)
    expect(transports[0]!.edits).toHaveLength(1)
    expect(new Set(transports[0]!.edits.map((edit) => edit.timestamp)).size).toBe(1)
  })

  it('keeps an unconfirmed post uncertain rather than posting again or rerunning the agent', async () => {
    transports[0]!.nextError = new SlackTransportError('uncertain', 'Fixture lost response')
    await service.receive(mention('Ev1', 'one task'))
    await service.flush()
    const uncertain = Object.values(service.store.state.outbox).find(
      (entry) => entry.state === 'uncertain',
    )!
    await service.close()
    service = makeService()
    await service.startSaved()
    await service.flush()
    expect(service.store.state.outbox[uncertain.id]?.state).toBe('uncertain')
    expect(transports[1]!.frames.some((frame) => frame.reply.text === uncertain.reply.text)).toBe(
      false,
    )
    expect(host.prompts).toHaveLength(1)
  })

  it('preserves retry timing when Slack rate limits a delivery', async () => {
    transports[0]!.nextError = new SlackTransportError('rate_limit', 'Wait', 60)
    await service.receive(mention('Ev1', 'one task'))
    await service.flush()
    const delayed = Object.values(service.store.state.outbox).find(
      (entry) => entry.state === 'pending' && entry.retryAt > Date.now(),
    )!
    expect(delayed).toBeDefined()
    expect(delayed.retryAt - Date.now()).toBeGreaterThan(50_000)
    expect(host.prompts).toHaveLength(1)
  })
})
