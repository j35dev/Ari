import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { delegationSettingsSchema } from '@ari/contracts/agent-control'
import type { Session } from '@ari/contracts/session'
import { AgentControlService, type ControlHost } from './agent-control'
import { SessionStore } from './session-store'
import { decideCommand } from './dispatcher'

let dir: string
let store: SessionStore
let host: ControlHost
let service: AgentControlService
let seq = 0
const root: Session = {
  id: 'root',
  projectId: 'p',
  title: 'Root',
  driverKind: 'claude',
  modelId: null,
  permissionMode: 'ask',
  status: 'idle',
  createdAt: 1,
  updatedAt: 1,
}
const spawn = {
  title: 'Worker',
  driverKind: 'claude',
  workspaceMode: 'shared',
  prompt: 'Implement',
  idempotencyKey: 'one',
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ari-control-'))
  store = new SessionStore({ rootDir: dir })
  await store.append(root.id, { type: 'session.created', session: root })
  host = {
    store,
    version: 'test',
    policy: () =>
      delegationSettingsSchema.parse({ approvalMode: 'never', allowSharedWorkspace: true }),
    providers: async () => [
      { driverKind: 'claude', available: true, models: [{ id: 'model', label: 'Model' }] },
    ],
    create: async (session) => {
      await store.append(session.id, { type: 'session.created', session })
    },
    dispatch: async (command, origin) => {
      if (!('sessionId' in command)) return { accepted: false }
      const decision = decideCommand(
        await store.load(command.sessionId),
        command,
        { turnId: `t${++seq}`, messageId: `m${seq}` },
        origin,
      )
      for (const event of decision.events) await store.append(command.sessionId, event)
      return decision
    },
    record: (id, event) => store.append(id, event),
    subscribe: (listener) => store.subscribe(listener),
    workspace: async () => dir,
    isolate: async () => {
      throw new Error('unexpected isolated spawn')
    },
    diff: async () => ({}),
    integrate: async () => ({}),
    approve: async () => true,
    release: async () => undefined,
  }
  service = new AgentControlService(host)
})
afterEach(async () => {
  for (const row of await store.listSessions()) await store.closeJournal(row.id)
  await rm(dir, { recursive: true, force: true })
})

it('deduplicates concurrent spawn retries and sends the assignment exactly once', async () => {
  const replies = await Promise.all(
    Array.from({ length: 5 }, () => service.invoke('root', 'session.spawn', spawn)),
  )
  expect(replies.every((r) => r.ok)).toBe(true)
  expect(new Set(replies.map((r) => JSON.stringify(r))).size).toBe(1)
  const child = (await store.listSessions()).find((s) => s.parentSessionId === 'root')!
  const model = await store.load(child.id)
  expect(model.messages).toHaveLength(1)
  expect(model.messages[0]?.origin).toEqual({ kind: 'session', sessionId: 'root' })
  expect(
    await service.invoke('root', 'session.spawn', { ...spawn, title: 'Different' }),
  ).toMatchObject({ ok: false, error: { code: 'invalid_request' } })
})

it('reserves root-wide slots atomically and prevents recursive delegation and escalation', async () => {
  host.policy = () =>
    delegationSettingsSchema.parse({
      approvalMode: 'never',
      allowSharedWorkspace: true,
      maxConcurrentChildren: 1,
    })
  const replies = await Promise.all(
    ['one', 'two'].map((idempotencyKey) =>
      service.invoke('root', 'session.spawn', { ...spawn, idempotencyKey }),
    ),
  )
  expect(replies.filter((r) => r.ok)).toHaveLength(1)
  expect(replies.find((r) => !r.ok)).toMatchObject({ error: { code: 'delegation_limit' } })
  const child = (await store.listSessions()).find((s) => s.parentSessionId === 'root')!
  expect(await service.invoke(child.id, 'session.spawn', spawn)).toMatchObject({
    error: { code: 'max_depth' },
  })
  await service.invoke('root', 'session.stop', {
    targetSessionId: child.id,
    idempotencyKey: 'stop',
  })
  expect(
    await service.invoke('root', 'session.spawn', {
      ...spawn,
      idempotencyKey: 'full',
      permissionMode: 'full',
    }),
  ).toMatchObject({ error: { code: 'scope_denied' } })
})

it('denies unrelated transcripts, forged senders and unavailable models', async () => {
  await host.create({ ...root, id: 'other' })
  expect(await service.invoke('root', 'session.read', { targetSessionId: 'other' })).toMatchObject({
    error: { code: 'scope_denied' },
  })
  expect(
    await service.invoke('root', 'session.message', {
      targetSessionId: 'self',
      text: 'Hi',
      origin: { kind: 'human' },
      idempotencyKey: 'fake',
    }),
  ).toMatchObject({ error: { code: 'invalid_request' } })
  expect(
    await service.invoke('root', 'session.spawn', { ...spawn, modelId: 'missing' }),
  ).toMatchObject({ error: { code: 'model_unavailable' } })
})

it('requires approval, rechecks changed policy and denies sibling/cross-project access', async () => {
  host.policy = () => delegationSettingsSchema.parse({ allowSharedWorkspace: true })
  host.approve = async () => false
  expect(await service.invoke('root', 'session.spawn', spawn)).toMatchObject({
    error: { code: 'delegation_approval_required' },
  })
  expect(await store.listSessions()).toHaveLength(1)
  host.approve = async () => {
    host.policy = () => delegationSettingsSchema.parse({ enabled: false })
    return true
  }
  expect(
    await service.invoke('root', 'session.spawn', { ...spawn, idempotencyKey: 'changed-policy' }),
  ).toMatchObject({ error: { code: 'delegation_disabled' } })
  await host.create({ ...root, id: 'sibling-a', parentSessionId: 'root', rootSessionId: 'root' })
  await host.create({ ...root, id: 'sibling-b', parentSessionId: 'root', rootSessionId: 'root' })
  await host.create({ ...root, id: 'foreign', projectId: 'elsewhere' })
  for (const targetSessionId of ['sibling-b', 'foreign']) {
    expect(await service.invoke('sibling-a', 'session.read', { targetSessionId })).toMatchObject({
      error: { code: 'scope_denied' },
    })
  }
})

it('lets a child wake its parent and queues later messages with preserved origin', async () => {
  await service.invoke('root', 'session.spawn', spawn)
  const child = (await store.listSessions()).find((s) => s.parentSessionId === 'root')!
  for (const idempotencyKey of ['a', 'b']) {
    expect(
      await service.invoke(child.id, 'session.message', {
        targetSessionId: 'parent',
        text: 'Question',
        idempotencyKey,
      }),
    ).toMatchObject({ ok: true })
  }
  const parent = await store.load('root')
  expect(parent.messages[0]?.origin).toEqual({ kind: 'session', sessionId: child.id })
  expect(parent.queuedMessages[0]?.origin).toEqual({ kind: 'session', sessionId: child.id })
})

it('waits for a captured child set and cancels on disconnect', async () => {
  await service.invoke('root', 'session.spawn', spawn)
  const child = (await store.listSessions()).find((s) => s.parentSessionId === 'root')!
  const turn = (await store.load(child.id)).activeTurnId!
  const waiting = service.invoke('root', 'session.wait', { targetSessionIds: [child.id] })
  await store.append(child.id, {
    type: 'turn.settled',
    turnId: turn,
    stopReason: 'completed',
    errorMessage: null,
  })
  expect(await waiting).toMatchObject({
    ok: true,
    result: [{ sessionId: child.id, turnId: turn, stopReason: 'completed' }],
  })
  await service.invoke('root', 'session.prompt', {
    targetSessionId: child.id,
    text: 'More',
    idempotencyKey: 'more',
  })
  const controller = new AbortController()
  const cancelled = service.invoke(
    'root',
    'session.wait',
    { targetSessionIds: [child.id] },
    controller.signal,
  )
  controller.abort()
  expect(await cancelled).toMatchObject({ error: { code: 'wait_cancelled' } })
})

it('lets a parent destroy a child and refuses self or unrelated sessions', async () => {
  await service.invoke('root', 'session.spawn', spawn)
  const child = (await store.listSessions()).find((s) => s.parentSessionId === 'root')!
  await host.create({
    ...root,
    id: 'grand',
    parentSessionId: child.id,
    rootSessionId: 'root',
  })
  expect(
    await service.invoke('root', 'session.destroy', {
      targetSessionId: 'self',
      idempotencyKey: 'me',
    }),
  ).toMatchObject({ error: { code: 'scope_denied' } })
  await host.create({ ...root, id: 'other' })
  expect(
    await service.invoke('root', 'session.destroy', {
      targetSessionId: 'other',
      idempotencyKey: 'foreign',
    }),
  ).toMatchObject({ error: { code: 'scope_denied' } })
  expect(
    await service.invoke('root', 'session.destroy', {
      targetSessionId: child.id,
      idempotencyKey: 'done',
    }),
  ).toMatchObject({ ok: true, result: { destroyed: true, count: 2 } })
  expect((await store.listSessions()).map((s) => s.id).sort()).toEqual(['other', 'root'])
  expect(
    await service.invoke('root', 'session.destroy', {
      targetSessionId: child.id,
      idempotencyKey: 'done',
    }),
  ).toMatchObject({ ok: true, result: { destroyed: true, count: 2 } })
})

it('compensates an isolated spawn when session create fails', async () => {
  const released: string[] = []
  host.isolate = async (_parent, id) => ({
    kind: 'managed-worktree',
    path: '/tmp/child',
    branch: `ari/${id}`,
    baseRef: 'refs/ari/child/base',
    baseCommit: 'a'.repeat(40),
  })
  host.release = async (child) => {
    released.push(child.id)
  }
  host.create = async () => {
    throw new Error('create failed')
  }
  expect(
    await service.invoke('root', 'session.spawn', {
      ...spawn,
      workspaceMode: 'isolated',
      idempotencyKey: 'iso-fail',
    }),
  ).toMatchObject({ ok: false, error: { code: 'internal_error' } })
  expect(released).toHaveLength(1)
  expect((await store.listSessions()).map((s) => s.id)).toEqual(['root'])
})

it('retries the same spawn key after a transient provider failure', async () => {
  let once = true
  host.providers = async () => {
    if (once) {
      once = false
      return []
    }
    return [{ driverKind: 'claude', available: true, models: [{ id: 'model', label: 'Model' }] }]
  }
  expect(await service.invoke('root', 'session.spawn', spawn)).toMatchObject({
    error: { code: 'provider_unavailable' },
  })
  expect(await service.invoke('root', 'session.spawn', spawn)).toMatchObject({ ok: true })
})

it('replays a spawn from the parent journal after the service is reconstructed', async () => {
  await service.invoke('root', 'session.spawn', spawn)
  const child = (await store.listSessions()).find((s) => s.parentSessionId === 'root')!
  const replayed = await new AgentControlService(host).invoke('root', 'session.spawn', spawn)
  expect(replayed).toMatchObject({ ok: true, result: { child: { id: child.id } } })
  expect((await store.listSessions()).filter((s) => s.parentSessionId === 'root')).toHaveLength(1)
})

it('returns per-target timeout instead of failing the whole wait', async () => {
  await service.invoke('root', 'session.spawn', spawn)
  const child = (await store.listSessions()).find((s) => s.parentSessionId === 'root')!
  expect(
    await service.invoke('root', 'session.wait', { targetSessionIds: [child.id], timeoutMs: 20 }),
  ).toMatchObject({
    ok: true,
    result: [{ status: 'timeout', sessionId: child.id }],
  })
})

it('records child.session.destroyed rather than stopped', async () => {
  await service.invoke('root', 'session.spawn', spawn)
  const child = (await store.listSessions()).find((s) => s.parentSessionId === 'root')!
  await service.invoke('root', 'session.destroy', {
    targetSessionId: child.id,
    idempotencyKey: 'wipe',
  })
  expect((await store.load('root')).childEvents?.map((e) => e.type)).toContain(
    'child.session.destroyed',
  )
  expect(
    (await store.load('root')).childEvents?.some(
      (e) => e.type === 'child.session.stopped' && e.childSessionId === child.id,
    ),
  ).toBe(false)
})

it('keeps the newest messages when read truncation hits the budget', async () => {
  await service.invoke('root', 'session.spawn', spawn)
  const child = (await store.listSessions()).find((s) => s.parentSessionId === 'root')!
  await store.append(child.id, {
    type: 'assistant.parts.appended',
    messageId: 'old',
    parts: [{ type: 'text', text: 'AAAAAAAAAA' }],
  })
  await store.append(child.id, {
    type: 'assistant.parts.appended',
    messageId: 'new',
    parts: [{ type: 'text', text: 'BBBBBBBBBB' }],
  })
  const read = await service.invoke('root', 'session.read', {
    targetSessionId: child.id,
    maxChars: 10,
    tailMessages: 10,
  })
  expect(read).toMatchObject({
    ok: true,
    result: { latestAssistantText: 'BBBBBBBBBB', truncated: true },
  })
})
