// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, beforeEach, expect, it, vi, type Mock } from 'vitest'
import { delegationSettingsSchema } from '@ari/contracts/agent-control'
import type { AgentEvent } from '@ari/contracts/agent-event'
import type { Session } from '@ari/contracts/session'
import { AgentControlService, type ControlHost } from '@ari/engine/agent-control'
import { SessionStore } from '@ari/engine/session-store'
import type { AdapterSession } from '@ari/providers/driver'
import { DriverRegistry } from '@ari/providers/registry'
import { Engine } from './engine'

let dir: string
let store: SessionStore
let engine: Engine
let host: ControlHost
let service: AgentControlService
let created: AdapterSession[]
let createdProviders: string[]
let releases: (() => void)[]
let pauseFirst: boolean
let pauseFollowing: boolean
let finishFirst: () => void
let finishFollowing: () => void
let interrupt: Mock<() => void>
let steer: Mock<() => Promise<boolean>>

const session = (id: string, projectId = 'project', fields: Partial<Session> = {}): Session => ({
  id,
  projectId,
  title: id,
  driverKind: 'claude',
  modelId: 'old',
  effort: 'high',
  permissionMode: 'allow-edits',
  status: 'idle',
  createdAt: 1,
  updatedAt: 1,
  ...fields,
})

function gate(): { promise: Promise<void>; release: () => void } {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  releases.push(release)
  return { promise, release }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ari-control-visibility-'))
  store = new SessionStore({ rootDir: dir })
  releases = []
  created = []
  createdProviders = []
  pauseFirst = false
  pauseFollowing = false
  const first = gate()
  const following = gate()
  finishFirst = first.release
  finishFollowing = following.release
  interrupt = vi.fn(first.release)
  steer = vi.fn(async () => true)
  const registry = new DriverRegistry()
  for (const kind of ['claude', 'codex'] as const) {
    registry.register({
      kind,
      create: async (input) => {
        created.push(input)
        createdProviders.push(kind)
        const index = created.length
        return {
          start: () =>
            (async function* (): AsyncGenerator<AgentEvent> {
              yield { type: 'text-delta', text: `Reply ${index}.` }
              if (index === 1 && pauseFirst) await first.promise
              if (index > 1 && pauseFollowing) await following.promise
              yield { type: 'done' }
            })(),
          steer,
          interrupt,
          dispose: async () => undefined,
        }
      },
    })
  }
  engine = new Engine({
    store,
    registry,
    publish: () => undefined,
    git: { captureCheckpoint: async () => ({ ok: true, value: null }) },
  })
  for (const row of [
    session('aria', 'helm'),
    session('root'),
    session('worker', 'project', { parentSessionId: 'root', rootSessionId: 'root' }),
    session('work', 'web', { createdBy: { kind: 'session', sessionId: 'aria' } }),
  ])
    await store.append(row.id, { type: 'session.created', session: row })
  host = makeHost(store, engine)
  service = new AgentControlService(host)
})

function makeHost(store: SessionStore, engine: Engine): ControlHost {
  return {
    store,
    version: 'test',
    policy: () => delegationSettingsSchema.parse({ approvalMode: 'never' }),
    providers: async () => [
      {
        driverKind: 'claude',
        available: true,
        models: [
          { id: 'old', label: 'Old', efforts: [{ id: 'low' }, { id: 'high' }] },
          { id: 'second', label: 'Second', efforts: [{ id: 'low' }] },
        ],
      },
      {
        driverKind: 'codex',
        available: true,
        models: [
          { id: 'new', label: 'New', aliases: ['alias'], efforts: [{ id: 'low' }, { id: 'high' }] },
        ],
      },
    ],
    dispatch: (command, origin) => engine.dispatch(command, origin),
    record: (id, event) => engine.record(id, event),
    subscribe: (listener) => store.subscribe(listener),
    create: (row) => engine.createSession(row),
    workspace: async () => dir,
    isolate: async () => {
      throw new Error('No workspace launch in this fixture')
    },
    diff: async () => ({}),
    integrate: async () => ({}),
    approve: async () => true,
    release: async () => undefined,
  }
}

afterEach(async () => {
  releases.forEach((release) => release())
  await engine.shutdown()
  for (const row of await store.listSessions()) await store.closeJournal(row.id)
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

async function start(id: string, paused = false): Promise<string> {
  pauseFirst = paused
  expect(
    await engine.dispatch({
      type: 'turn.start',
      sessionId: id,
      text: 'Original task',
      attachments: [],
    }),
  ).toMatchObject({ accepted: true })
  await expect.poll(() => created.length).toBeGreaterThan(0)
  return (await store.load(id)).activeTurnId!
}

const switchTo = (targetSessionId = 'work', idempotencyKey = 'switch') => ({
  targetSessionId,
  driverKind: 'codex',
  modelId: 'alias',
  effort: 'low',
  idempotencyKey,
})

async function reload(): Promise<void> {
  await engine.shutdown()
  for (const row of await store.listSessions()) await store.closeJournal(row.id)
  store = new SessionStore({ rootDir: dir })
  engine = new Engine({ store, registry: new DriverRegistry(), publish: () => undefined })
  host = makeHost(store, engine)
  service = new AgentControlService(host)
}

it('reports a busy assignment as future work, with the observed turn kept separate and durable', async () => {
  const running = await start('worker', true)
  const params = {
    targetSessionId: 'worker',
    text: 'Next navigation task',
    idempotencyKey: 'next-task',
  }
  const receipt = await service.invoke('root', 'session.prompt', params)
  expect(receipt).toMatchObject({
    ok: true,
    result: {
      queued: true,
      execution: 'future_turn',
      observedActiveTurnId: running,
      turnId: running,
    },
  })
  expect(steer).not.toHaveBeenCalled()
  expect((await store.load('worker')).activeTurnId).toBe(running)
  const read = await service.invoke('root', 'session.read', { targetSessionId: 'worker' })
  expect(read).toMatchObject({
    ok: true,
    result: {
      queuedMessageCount: 1,
      queuedMessagesTruncated: false,
      queuedMessages: [
        {
          text: params.text,
          origin: { kind: 'session', sessionId: 'root' },
          held: true,
          truncated: false,
        },
      ],
    },
  })
  finishFirst()
  await expect.poll(() => created.length).toBe(2)
  await engine.quiesce('worker')
  expect((await store.load('worker')).queuedMessages).toEqual([])
  expect(created[1]!.prompt).toContain(params.text)
  await reload()
  const dispatch = vi.spyOn(host, 'dispatch')
  expect(await service.invoke('root', 'session.prompt', params)).toEqual(receipt)
  expect(dispatch).not.toHaveBeenCalled()
})

it('reads FIFO queue summaries within shared message/count and text budgets after a fresh store load', async () => {
  await store.append('worker', {
    type: 'assistant.parts.appended',
    messageId: 'reply',
    parts: [{ type: 'text', text: 'Journal reply' }],
  })
  for (const text of ['ABCDEF', '0123456789', 'Hidden queued text']) {
    await store.append('worker', {
      type: 'message.enqueued',
      text,
      attachments: [],
      held: true,
      origin: { kind: 'session', sessionId: 'root' },
    })
  }
  await reload()
  const read = await service.invoke('root', 'session.read', {
    targetSessionId: 'worker',
    tailMessages: 2,
    maxChars: 10,
  })
  expect(read).toMatchObject({
    ok: true,
    result: {
      queuedMessageCount: 3,
      queuedMessages: [
        { text: 'ABCDEF', held: true, truncated: false },
        { text: '0123', held: true, truncated: true },
      ],
      queuedMessagesTruncated: true,
      messages: [],
      truncated: true,
    },
  })
  const all = await service.invoke('root', 'session.read', {
    targetSessionId: 'worker',
    tailMessages: 200,
  })
  expect(all).toMatchObject({
    ok: true,
    result: {
      queuedMessagesTruncated: false,
      queuedMessageCount: 3,
      messages: [{ text: 'Journal reply' }],
    },
  })
  expect((await store.load('worker')).queuedMessages.map((q) => q.text)).toEqual([
    'ABCDEF',
    '0123456789',
    'Hidden queued text',
  ])
})

it('shares the character budget with journal messages, retaining the conservative overall cap signal', async () => {
  await store.append('worker', { type: 'message.enqueued', text: 'Queue', attachments: [] })
  await store.append('worker', {
    type: 'assistant.parts.appended',
    messageId: 'reply',
    parts: [{ type: 'text', text: 'Reply' }],
  })
  expect(
    await service.invoke('root', 'session.read', { targetSessionId: 'worker', maxChars: 8 }),
  ).toMatchObject({
    result: {
      queuedMessages: [{ text: 'Queue', held: false }],
      messages: [{ text: 'Rep' }],
      truncated: true,
    },
  })
  expect(
    await service.invoke('root', 'session.read', { targetSessionId: 'worker', maxChars: 10 }),
  ).toMatchObject({
    result: { queuedMessagesTruncated: false, truncated: true },
  })
})

it('passes CLI turn selection to actual reads without losing the initial split-turn instruction', async () => {
  const cli = createRequire(import.meta.url)('../../resources/cli/ari.cjs') as {
    parse(argv: string[]): { params: Record<string, unknown> }
  }
  await start('worker', true)
  for (let index = 0; index < 9; index++) {
    await store.append('worker', {
      type: 'assistant.parts.appended',
      messageId: `chunk-${index}`,
      parts: [{ type: 'text', text: `Investigation chunk ${index}` }],
    })
  }
  const normal = await service.invoke(
    'root',
    'session.read',
    cli.parse(['session', 'read', 'worker']).params,
  )
  expect(normal).toMatchObject({ result: { truncated: true, queuedMessageCount: 0 } })
  expect(JSON.stringify(normal)).not.toContain('Original task')
  const full = await service.invoke(
    'root',
    'session.read',
    cli.parse(['session', 'read', 'worker', '--turns', '1']).params,
  )
  expect(full).toMatchObject({ result: { truncated: false } })
  expect(JSON.stringify(full)).toContain('Original task')
  const tail = await service.invoke(
    'root',
    'session.read',
    cli.parse(['session', 'read', 'worker', '--turns', '1', '--tail', '3']).params,
  )
  expect(JSON.stringify(tail)).not.toContain('Original task')
})

it('retains queue read scope for siblings, unrelated sessions and cross-project callers', async () => {
  for (const row of [
    session('sibling', 'project', { parentSessionId: 'root' }),
    session('other'),
    session('foreign', 'foreign'),
  ]) {
    await store.append(row.id, { type: 'session.created', session: row })
  }
  await store.append('worker', {
    type: 'message.enqueued',
    text: 'Private assignment',
    attachments: [],
    held: true,
  })
  for (const caller of ['sibling', 'other', 'foreign']) {
    expect(
      await service.invoke(caller, 'session.read', { targetSessionId: 'worker' }),
    ).toMatchObject({ ok: false, error: { code: 'scope_denied' } })
  }
  expect(await service.invoke('aria', 'session.read', { targetSessionId: 'worker' })).toMatchObject(
    { result: { queuedMessages: [{ text: 'Private assignment' }] } },
  )
})

it.each(['work', 'aria'])(
  'fences the active %s switch, keeps the original adapter, and durably reuses timing',
  async (target) => {
    const running = await start(target, true)
    const params = switchTo(target)
    const receipt = await service.invoke('aria', 'session.switch', params)
    expect(receipt).toMatchObject({
      ok: true,
      result: {
        effective: 'next_turn',
        afterTurnId: running,
        agent: {
          driverKind: 'codex',
          modelId: 'new',
          effort: 'low',
          permissionMode: 'allow-edits',
        },
      },
    })
    expect((await store.load(target)).activeTurnId).toBe(running)
    expect(created[0]).toMatchObject({ modelId: 'old', effort: 'high' })
    expect(interrupt).not.toHaveBeenCalled()
    expect(steer).not.toHaveBeenCalled()
    await engine.dispatch({
      type: 'message.enqueue',
      sessionId: target,
      text: 'Continue on selected model',
      attachments: [],
    })
    finishFirst()
    await expect.poll(() => created.length).toBe(2)
    await engine.quiesce(target)
    expect(created[1]).toMatchObject({ modelId: 'new', effort: 'low', resumeOf: null })
    expect(createdProviders).toEqual(['claude', 'codex'])
    expect(created[1]!.prompt).toContain('Original task')
    expect(created[1]!.prompt).toContain('Reply 1.')
    await reload()
    const dispatch = vi.spyOn(host, 'dispatch')
    expect(await service.invoke('aria', 'session.switch', params)).toEqual(receipt)
    expect(dispatch).not.toHaveBeenCalled()
  },
)

it('fences a same-provider model/effort switch even when it produces no provider-switch divider', async () => {
  const running = await start('work', true)
  const receipt = await service.invoke('aria', 'session.switch', {
    ...switchTo(),
    driverKind: 'claude',
    modelId: 'second',
  })
  expect(receipt).toMatchObject({ result: { effective: 'next_turn', afterTurnId: running } })
  expect(created[0]).toMatchObject({ modelId: 'old', effort: 'high' })
  await engine.dispatch({
    type: 'message.enqueue',
    sessionId: 'work',
    text: 'Continue',
    attachments: [],
  })
  finishFirst()
  await expect.poll(() => created.length).toBe(2)
  await engine.quiesce('work')
  expect(created[1]).toMatchObject({ modelId: 'second', effort: 'low' })
  expect(createdProviders).toEqual(['claude', 'claude'])
  expect(interrupt).not.toHaveBeenCalled()
})

it.each(['settles', 'starts'])(
  'captures switch timing after a catalog delay while the target %s',
  async (change) => {
    if (change === 'settles') await start('work', true)
    const catalog = gate()
    const providers = host.providers
    host.providers = vi.fn(async () => {
      await catalog.promise
      return providers()
    })
    const switching = service.invoke('aria', 'session.switch', switchTo())
    await expect.poll(() => vi.mocked(host.providers).mock.calls.length).toBe(1)
    if (change === 'settles') {
      finishFirst()
      await engine.quiesce('work')
    } else await start('work', true)
    const atDispatch = (await store.load('work')).activeTurnId
    catalog.release()
    expect(await switching).toMatchObject({
      result: {
        effective: atDispatch ? 'next_turn' : 'ready',
        afterTurnId: atDispatch,
      },
    })
  },
)

it('uses the Engine dispatch fence when a turn starts behind async authorization', async () => {
  const authorization = gate()
  await engine.shutdown()
  const registry = new DriverRegistry()
  registry.register({
    kind: 'claude',
    create: async (input) => {
      created.push(input)
      return {
        start: () =>
          (async function* (): AsyncGenerator<AgentEvent> {
            await authorization.promise
            yield { type: 'done' }
          })(),
        interrupt: authorization.release,
        dispose: async () => undefined,
      }
    },
  })
  const turnGate = gate()
  const authorize = vi.fn(async () => {
    await turnGate.promise
    return null
  })
  engine = new Engine({ store, registry, publish: () => undefined, authorizeTurn: authorize })
  host = makeHost(store, engine)
  service = new AgentControlService(host)
  const starting = engine.dispatch({
    type: 'turn.start',
    sessionId: 'work',
    text: 'First task',
    attachments: [],
  })
  await expect.poll(() => authorize.mock.calls.length).toBe(1)
  const dispatch = vi.spyOn(host, 'dispatch')
  const switching = service.invoke('aria', 'session.switch', switchTo())
  await expect.poll(() => dispatch.mock.calls.length).toBe(1)
  expect((await store.load('work')).activeTurnId).toBeNull()
  turnGate.release()
  await starting
  const running = (await store.load('work')).activeTurnId
  expect(await switching).toMatchObject({
    result: { effective: 'next_turn', afterTurnId: running },
  })
})

it('returns ready with no active fence even after a previous turn, without starting work', async () => {
  await start('work')
  await engine.quiesce('work')
  const receipt = await service.invoke('aria', 'session.switch', switchTo())
  expect(receipt).toMatchObject({ ok: true, result: { effective: 'ready', afterTurnId: null } })
  expect((await store.load('work')).activeTurnId).toBeNull()
  expect(created).toHaveLength(1)
  pauseFollowing = true
  await engine.dispatch({
    type: 'turn.start',
    sessionId: 'work',
    text: 'Later assignment',
    attachments: [],
  })
  await expect.poll(() => created.length).toBe(2)
  expect((await store.load('work')).activeTurnId).not.toBeNull()
  expect(await service.invoke('aria', 'session.switch', switchTo())).toEqual(receipt)
  finishFollowing()
  await engine.quiesce('work')
  await reload()
  expect(await service.invoke('aria', 'session.switch', switchTo())).toEqual(receipt)
})

it('supports only the current nonarchived Aria self, retaining other scope and catalog refusals', async () => {
  await store.append('old-aria', {
    type: 'session.created',
    session: session('old-aria', 'helm', { updatedAt: 0 }),
  })
  expect(await store.currentHelmSession()).toBe('aria')
  for (const [caller, target] of [
    ['aria', 'old-aria'],
    ['root', 'root'],
    ['aria', 'root'],
    ['aria', 'worker'],
  ] as const) {
    expect(
      await service.invoke(caller!, 'session.switch', switchTo(target, caller + target)),
    ).toMatchObject({ ok: false, error: { code: 'scope_denied' } })
  }
  for (const params of [
    { ...switchTo('self'), modelId: 'missing' },
    { ...switchTo('self'), driverKind: 'opencode' },
  ]) {
    expect(await service.invoke('aria', 'session.switch', params)).toMatchObject({ ok: false })
    expect((await store.load('aria')).session?.driverKind).toBe('claude')
  }
  expect(await service.invoke('aria', 'session.switch', switchTo('self', 'self'))).toMatchObject({
    ok: true,
    result: { sessionId: 'aria', effective: 'ready', afterTurnId: null },
  })
  await store.append('aria', { type: 'session.updated', archived: true })
  expect(
    await service.invoke('aria', 'session.switch', switchTo('self', 'archived')),
  ).toMatchObject({ ok: false, error: { code: 'scope_denied' } })
})

it('rechecks archive and permission ceilings after catalog resolution', async () => {
  for (const mutation of ['caller_archive', 'target_archive', 'higher_permission'] as const) {
    const catalog = gate()
    const providers = makeHost(store, engine).providers
    host.providers = vi.fn(async () => {
      await catalog.promise
      return providers()
    })
    const switching = service.invoke('aria', 'session.switch', switchTo('work', mutation))
    await expect.poll(() => vi.mocked(host.providers).mock.calls.length).toBe(1)
    await store.append(
      mutation === 'caller_archive' ? 'aria' : 'work',
      mutation === 'higher_permission'
        ? { type: 'session.updated', permissionMode: 'full' }
        : { type: 'session.updated', archived: true },
    )
    catalog.release()
    expect(await switching).toMatchObject({ ok: false, error: { code: 'scope_denied' } })
    expect((await store.load('work')).session?.modelId).toBe('old')
    await store.append('aria', { type: 'session.updated', archived: false })
    await store.append('work', {
      type: 'session.updated',
      archived: false,
      permissionMode: 'allow-edits',
    })
  }
})

it('refuses a noncurrent Aria self-switch after a newer nonarchived topic exists', async () => {
  await store.append('new-aria', {
    type: 'session.created',
    session: session('new-aria', 'helm', { updatedAt: 2 }),
  })
  expect(await store.currentHelmSession()).toBe('new-aria')
  expect(
    await service.invoke('aria', 'session.switch', switchTo('self', 'obsolete-self')),
  ).toMatchObject({ ok: false, error: { code: 'scope_denied' } })
  expect((await store.load('aria')).session?.modelId).toBe('old')
  expect(
    await service.invoke('new-aria', 'session.switch', switchTo('self', 'current-self')),
  ).toMatchObject({
    ok: true,
    result: { sessionId: 'new-aria', effective: 'ready', afterTurnId: null },
  })
  expect(await store.currentHelmSession()).toBe('new-aria')
})

it('refuses a stale Aria self-switch when a new topic becomes current during catalog lookup', async () => {
  expect(await store.currentHelmSession()).toBe('aria')
  const catalog = gate()
  const providers = host.providers
  host.providers = vi.fn(async () => {
    await catalog.promise
    return providers()
  })
  const dispatch = vi.spyOn(host, 'dispatch')
  const switching = service.invoke('aria', 'session.switch', switchTo('self', 'replaced-self'))
  await expect.poll(() => vi.mocked(host.providers).mock.calls.length).toBe(1)
  await store.append('new-aria', {
    type: 'session.created',
    session: session('new-aria', 'helm', { updatedAt: 2 }),
  })
  expect(await store.currentHelmSession()).toBe('new-aria')
  catalog.release()
  expect(await switching).toMatchObject({ ok: false, error: { code: 'scope_denied' } })
  expect(dispatch).not.toHaveBeenCalled()
  expect((await store.load('aria')).session?.modelId).toBe('old')
})

it('checks persisted current-topic metadata on a cold store before allowing a new self-switch', async () => {
  await store.append('new-aria', {
    type: 'session.created',
    session: session('new-aria', 'helm', { updatedAt: 2 }),
  })
  expect(await store.currentHelmSession()).toBe('new-aria')
  await reload()
  const dispatch = vi.spyOn(host, 'dispatch')
  expect(
    await service.invoke('aria', 'session.switch', switchTo('aria', 'cold-stale-self')),
  ).toMatchObject({ ok: false, error: { code: 'scope_denied' } })
  expect(await store.currentHelmSession()).toBe('new-aria')
  expect(dispatch).not.toHaveBeenCalled()
  expect((await store.load('aria')).session?.modelId).toBe('old')
})

it('retains an accepted self-switch receipt after topic replacement and reload without dispatching again', async () => {
  expect(await store.currentHelmSession()).toBe('aria')
  const params = switchTo('self', 'accepted-self')
  const receipt = await service.invoke('aria', 'session.switch', params)
  expect(receipt).toMatchObject({ ok: true, result: { effective: 'ready', afterTurnId: null } })
  await store.append('new-aria', {
    type: 'session.created',
    session: session('new-aria', 'helm', { updatedAt: 2 }),
  })
  expect(await store.currentHelmSession()).toBe('new-aria')
  await reload()
  const dispatch = vi.spyOn(host, 'dispatch')
  expect(await service.invoke('aria', 'session.switch', params)).toEqual(receipt)
  expect(dispatch).not.toHaveBeenCalled()
})

it('retains explicitly requested project-session switches from a noncurrent Aria caller', async () => {
  await store.append('new-aria', {
    type: 'session.created',
    session: session('new-aria', 'helm', { updatedAt: 2 }),
  })
  expect(await store.currentHelmSession()).toBe('new-aria')
  expect(
    await service.invoke('aria', 'session.switch', switchTo('work', 'project-switch')),
  ).toMatchObject({ ok: true, result: { effective: 'ready', afterTurnId: null } })
})
