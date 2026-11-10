import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { delegationSettingsSchema } from '@ari/contracts/agent-control'
import type { AppOpenReceipt, AppOpenTarget } from '@ari/contracts/rpc'
import type { Session } from '@ari/contracts/session'
import { AgentControlService, type ControlHost } from './agent-control'
import { SessionStore } from './session-store'

let dir: string
let store: SessionStore
let host: ControlHost
let service: AgentControlService
const session = (id: string, projectId = 'p'): Session => ({
  id,
  projectId,
  title: id,
  driverKind: 'claude',
  modelId: 'm',
  permissionMode: 'ask',
  status: 'idle',
  createdAt: 1,
  updatedAt: 1,
})
const applied = (target: AppOpenTarget, requestId: string): AppOpenReceipt => ({
  requestId,
  target,
  status: 'applied',
  observed: {
    target,
    mode: target.view === 'settings' ? 'settings' : target.view === 'changes' ? 'page' : 'chat',
  },
})
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ari-app-control-'))
  store = new SessionStore({ rootDir: dir })
  for (const value of [session('aria', 'helm'), session('s'), session('worker')])
    await store.append(value.id, { type: 'session.created', session: value })
  host = {
    store,
    version: 'test',
    policy: () => delegationSettingsSchema.parse({ approvalMode: 'never' }),
    providers: vi.fn(async () => []),
    create: vi.fn(),
    dispatch: vi.fn(async () => ({ accepted: false })),
    record: (id, event) => store.append(id, event),
    subscribe: (listener) => store.subscribe(listener),
    workspace: vi.fn(async () => null),
    isolate: vi.fn(),
    diff: vi.fn(),
    integrate: vi.fn(),
    approve: vi.fn(async () => false),
    release: vi.fn(),
    projects: async () => [{ projectId: 'p', name: 'P', path: dir, available: true }],
    openApp: vi.fn<NonNullable<ControlHost['openApp']>>(async (_callerId, target, requestId) =>
      applied(target, requestId),
    ),
  }
  service = new AgentControlService(host)
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})
const open = (params: object, caller = 'aria', key = JSON.stringify(params)) =>
  service.invoke(caller, 'app.open', { ...params, idempotencyKey: key })
const reload = () => {
  store = new SessionStore({ rootDir: dir })
  host.store = store
  service = new AgentControlService(host)
}
function attempts(method: keyof ControlHost): number {
  const value: unknown = Object.getOwnPropertyDescriptor(host, method)?.value
  if (!vi.isMockFunction(value)) throw new Error('Expected a fixture mock')
  return value.mock.calls.length
}

it('resolves exact existing targets through a cold store with no discovery, creation or turns', async () => {
  reload()
  for (const [params, target] of [
    [
      { view: 'session', sessionId: 's' },
      { view: 'session', sessionId: 's' },
    ],
    [{ view: 'aria' }, { view: 'aria', sessionId: 'aria' }],
    [{ view: 'settings' }, { view: 'settings' }],
    [
      { view: 'changes', sessionId: 's' },
      { view: 'changes', projectId: 'p', sessionId: 's' },
    ],
    [
      { view: 'changes', projectId: 'p' },
      { view: 'changes', projectId: 'p' },
    ],
  ])
    expect(await open(params!, 'aria', JSON.stringify(params))).toMatchObject({
      ok: true,
      result: { status: 'applied', target },
    })
  for (const method of ['providers', 'create', 'dispatch', 'workspace', 'isolate'] as const)
    expect(attempts(method)).toBe(0)
  expect((await store.load('s')).messages).toHaveLength(0)
})

it('refuses unrelated workers, archives, missing/ambiguous targets and permission escalation', async () => {
  expect(await open({ view: 'settings' }, 'worker')).toMatchObject({
    ok: false,
    error: { code: 'scope_denied' },
  })
  expect(await open({ view: 'changes' })).toMatchObject({
    ok: false,
    error: { code: 'invalid_request' },
  })
  expect(await open({ view: 'changes', projectId: 'p', sessionId: 's' })).toMatchObject({
    ok: false,
    error: { code: 'invalid_request' },
  })
  expect(await open({ view: 'changes', projectId: 'missing' })).toMatchObject({
    ok: false,
    error: { code: 'project_not_found' },
  })
  host.projects = async () => [{ projectId: 'p', name: 'P', path: dir, available: false }]
  expect(await open({ view: 'changes', projectId: 'p' })).toMatchObject({
    ok: false,
    error: { code: 'project_unavailable' },
  })
  host.projects = undefined
  expect(await open({ view: 'changes', projectId: 'p' })).toMatchObject({
    ok: false,
    error: { code: 'unsupported' },
  })
  expect(await open({ view: 'session', sessionId: 'title-substring' })).toMatchObject({
    ok: false,
    error: { code: 'session_not_found' },
  })
  await store.append('s', { type: 'session.updated', archived: true })
  expect(await open({ view: 'session', sessionId: 's' })).toMatchObject({
    ok: false,
    error: { code: 'scope_denied' },
  })
  await store.append('s', { type: 'session.updated', archived: false, permissionMode: 'full' })
  expect(await open({ view: 'session', sessionId: 's' })).toMatchObject({
    ok: false,
    error: { code: 'scope_denied' },
  })
  expect(attempts('openApp')).toBe(0)
})

it('checks the persisted canonical topic and source again after asynchronous resolution', async () => {
  let release!: () => void
  let entered!: () => void
  const gate = new Promise<void>((done) => {
    release = done
  })
  const started = new Promise<void>((done) => {
    entered = done
  })
  host.projects = async () => {
    entered()
    await gate
    return [{ projectId: 'p', name: 'P', path: dir, available: true }]
  }
  const pending = open({ view: 'changes', projectId: 'p' })
  await started
  await store.append('new-aria', {
    type: 'session.created',
    session: { ...session('new-aria', 'helm'), updatedAt: Date.now() + 100_000 },
  })
  expect(await store.currentHelmSession()).toBe('new-aria')
  release()
  expect(await pending).toMatchObject({ ok: false, error: { code: 'scope_denied' } })
  expect(await open({ view: 'settings' }, 'aria', 'old')).toMatchObject({
    ok: false,
    error: { code: 'scope_denied' },
  })
  expect(attempts('openApp')).toBe(0)
})

it('preserves the original target and result on same-key replay, reload and later topic changes', async () => {
  const params = { view: 'session', sessionId: 's' }
  const result = await open(params)
  expect(result.ok).toBe(true)
  expect(await open(params)).toEqual(result)
  await store.append('s', { type: 'session.updated', archived: true })
  reload()
  expect(await open(params)).toEqual(result)
  expect(await open({ view: 'settings' }, 'aria', JSON.stringify(params))).toMatchObject({
    ok: false,
    error: { code: 'invalid_request' },
  })
  expect(attempts('openApp')).toBe(1)
})

it('keeps a lost applied receipt inspectable and never repeats an uncertain action', async () => {
  const original = host.record.bind(host)
  host.record = async (id, event) => {
    const saved = await original(id, event)
    if (event.type === 'orchestration.operation.updated' && event.operation.status === 'completed')
      throw new Error('lost append acknowledgement')
    return saved
  }
  const result = await open({ view: 'session', sessionId: 's' })
  expect(result).toMatchObject({
    ok: false,
    error: {
      code: 'uncertain_outcome',
      details: { appOpen: { status: 'applied', target: { view: 'session', sessionId: 's' } } },
    },
  })
  host.record = original
  reload()
  expect(await open({ view: 'session', sessionId: 's' })).toEqual(result)
  expect(attempts('openApp')).toBe(1)
})

it('persists unconfirmed timeouts and mismatched acknowledgements without target substitution', async () => {
  host.openApp = vi.fn<NonNullable<ControlHost['openApp']>>(async (_caller, target, requestId) => ({
    requestId,
    target,
    status: 'unconfirmed',
    reason: 'ack_timeout',
  }))
  const timeout = await open({ view: 'settings' })
  reload()
  expect(await open({ view: 'settings' })).toEqual(timeout)
  expect(attempts('openApp')).toBe(1)
  host.openApp = vi.fn<NonNullable<ControlHost['openApp']>>(async (_caller, _target, requestId) =>
    applied({ view: 'session', sessionId: 'other' }, requestId),
  )
  const mismatch = await open({ view: 'session', sessionId: 's' }, 'aria', 'mismatch')
  expect(mismatch).toMatchObject({ ok: false, error: { code: 'uncertain_outcome' } })
  reload()
  expect(await open({ view: 'session', sessionId: 's' }, 'aria', 'mismatch')).toMatchObject({
    ok: false,
    error: {
      details: { appOpen: { status: 'unconfirmed', target: { view: 'session', sessionId: 's' } } },
    },
  })
  expect(attempts('openApp')).toBe(1)
})

it('checks requester cancellation after asynchronous target resolution without publishing', async () => {
  const signal = new AbortController()
  let release!: () => void
  let entered!: () => void
  const gate = new Promise<void>((done) => {
    release = done
  })
  const started = new Promise<void>((done) => {
    entered = done
  })
  host.projects = async () => {
    entered()
    await gate
    return [{ projectId: 'p', name: 'P', path: dir, available: true }]
  }
  const params = { view: 'changes', projectId: 'p', idempotencyKey: 'cancelled' }
  const request = service.invoke('aria', 'app.open', params, signal.signal)
  await started
  signal.abort()
  release()
  const result = await request
  expect(result).toMatchObject({
    ok: true,
    result: {
      status: 'unavailable',
      reason: 'disconnected',
      target: { view: 'changes', projectId: 'p' },
    },
  })
  expect(attempts('openApp')).toBe(0)
  reload()
  expect(await service.invoke('aria', 'app.open', params)).toEqual(result)
  expect(attempts('openApp')).toBe(0)
})
