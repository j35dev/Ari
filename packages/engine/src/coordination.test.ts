import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { delegationSettingsSchema } from '@ari/contracts/agent-control'
import type { CoordinationMessage } from '@ari/contracts/coordination'
import type { Session } from '@ari/contracts/session'
import { AgentControlService, type ControlHost } from './agent-control'
import { SessionStore } from './session-store'
import { decideCommand } from './dispatcher'

let dir: string, store: SessionStore, host: ControlHost, service: AgentControlService
const session = (id: string, parentSessionId?: string): Session => ({
  id,
  projectId: 'p',
  title: id,
  driverKind: 'claude',
  modelId: null,
  permissionMode: 'ask',
  status: 'idle',
  createdAt: 1,
  updatedAt: 1,
  ...(parentSessionId ? { parentSessionId, rootSessionId: 'root' } : {}),
})
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ari-inbox-'))
  store = new SessionStore({ rootDir: dir })
  for (const row of [session('root'), session('a', 'root'), session('b', 'root'), session('other')])
    await store.append(row.id, { type: 'session.created', session: row })
  host = {
    store,
    version: 'test',
    policy: () => delegationSettingsSchema.parse({ approvalMode: 'never' }),
    providers: async () => [],
    create: async () => undefined,
    dispatch: async (command, origin) => {
      if (!('sessionId' in command)) return { accepted: false }
      const result = decideCommand(
        await store.load(command.sessionId),
        command,
        { turnId: 'turn', messageId: 'message' },
        origin,
      )
      for (const event of result.events) await store.append(command.sessionId, event)
      return result
    },
    record: (id, event) => store.append(id, event),
    subscribe: (listener) => store.subscribe(listener),
    workspace: async () => dir,
    isolate: async () => ({ kind: 'project' }),
    diff: async () => ({}),
    integrate: async () => ({}),
    approve: async () => false,
    release: async () => undefined,
  }
  service = new AgentControlService(host)
})
afterEach(async () => {
  for (const row of await store.listSessions()) await store.closeJournal(row.id)
  await rm(dir, { recursive: true, force: true })
})
const send = (sender = 'a', recipient = 'b', key = 'one') =>
  service.invoke(sender, 'session.message', {
    targetSessionId: recipient,
    text: 'same text',
    idempotencyKey: key,
  })
const entries = async (id: string) => Object.values((await store.load(id)).inbox ?? {})
const busy = async (id: string) =>
  host.dispatch(
    { type: 'turn.start', sessionId: id, text: 'work', attachments: [] },
    { kind: 'session', sessionId: 'root' },
  )
const reload = async () => {
  for (const row of await store.listSessions()) await store.closeJournal(row.id)
  store = new SessionStore({ rootDir: dir })
  host.store = store
  service = new AgentControlService(host)
}

it('wakes reciprocal sibling waits without queued assignments, replies or lost identities', async () => {
  await busy('a')
  await busy('b')
  const a = service.invoke('a', 'session.wait', { targetSessionIds: ['b'], timeoutMs: 1000 })
  const b = service.invoke('b', 'session.wait', { targetSessionIds: ['a'], timeoutMs: 1000 })
  await Promise.all([send('a', 'b'), send('b', 'a')])
  expect(await a).toMatchObject({
    ok: true,
    result: [{ status: 'coordination', sessionId: 'a', messages: [{ senderSessionId: 'b' }] }],
  })
  expect(await b).toMatchObject({
    ok: true,
    result: [{ status: 'coordination', sessionId: 'b', messages: [{ senderSessionId: 'a' }] }],
  })
  expect((await store.load('a')).queuedMessages).toEqual([])
  expect((await store.load('b')).queuedMessages).toEqual([])
  expect(await send()).toMatchObject({ ok: true })
  expect(await entries('b')).toHaveLength(1)
  await send('a', 'root', 'root-a')
  await send('b', 'root', 'root-b')
  expect((await entries('root')).map((entry) => entry.senderSessionId).sort()).toEqual(['a', 'b'])
  expect(new Set((await entries('root')).map((entry) => entry.messageId)).size).toBe(2)
})

it('keeps siblings coordination-only and acknowledgements scoped to the exact recipient', async () => {
  const sent = await send()
  if (!sent.ok) throw new Error('send failed')
  const message = sent.result as CoordinationMessage
  expect(
    await service.invoke('a', 'session.prompt', {
      targetSessionId: 'b',
      text: 'assignment',
      idempotencyKey: 'denied',
    }),
  ).toMatchObject({ ok: false, error: { code: 'scope_denied' } })
  expect(await send('a', 'other', 'foreign')).toMatchObject({
    ok: false,
    error: { code: 'scope_denied' },
  })
  expect(
    await service.invoke('a', 'session.ack', {
      messageIds: [message.messageId],
      idempotencyKey: 'wrong',
    }),
  ).toMatchObject({ ok: false, error: { code: 'scope_denied' } })
  expect(
    await service.invoke('b', 'session.ack', {
      messageIds: [message.messageId],
      idempotencyKey: 'ack',
    }),
  ).toMatchObject({ ok: true })
  expect(
    await service.invoke('a', 'session.delivery', {
      targetSessionId: 'b',
      messageId: message.messageId,
    }),
  ).toMatchObject({ ok: true, result: { status: 'consumed' } })
  await reload()
  expect(await service.invoke('b', 'session.inbox', {})).toMatchObject({
    ok: true,
    result: { messages: [] },
  })
  expect(await service.invoke('b', 'session.inbox', { includeConsumed: true })).toMatchObject({
    ok: true,
    result: { messages: [{ status: 'consumed', messageId: message.messageId }] },
  })
})

it('keeps a pre-existing inbox message observable when waiting begins after delivery', async () => {
  await send('a', 'b', 'early')
  const result = await service.invoke('b', 'session.wait', {
    targetSessionIds: ['a'],
    timeoutMs: 1000,
  })
  expect(result).toMatchObject({
    ok: true,
    result: [{ status: 'coordination', messages: [{ senderSessionId: 'a', status: 'pending' }] }],
  })
  expect(await entries('b')).toHaveLength(1)
})

it('returns actual lead questions during all-target waits without giving leads approvals', async () => {
  await busy('a')
  await busy('b')
  const waiting = service.invoke('root', 'session.wait', {
    targetSessionIds: ['a', 'b'],
    timeoutMs: 1000,
  })
  await store.append('a', {
    type: 'approval.requested',
    approvalId: 'approval',
    toolName: 'Bash',
    summaryJson: '{}',
    options: [],
  })
  await store.append('b', {
    type: 'input.requested',
    inputId: 'question',
    prompt: 'Which file?',
    choicesJson: null,
  })
  expect(await waiting).toMatchObject({
    ok: true,
    result: [{ status: 'question', sessionId: 'b', questions: [{ inputId: 'question' }] }],
  })
  expect((await store.load('a')).pendingApprovals).toHaveLength(1)
  expect(
    await service.invoke('root', 'session.answer', {
      targetSessionId: 'a',
      inputId: 'approval',
      value: 'allow',
      idempotencyKey: 'approval-denied',
    }),
  ).toMatchObject({ ok: false })
})

it('retains a coordination message when a busy recipient settles before live delivery', async () => {
  await busy('b')
  host.canDeliverCoordination = () => true
  host.deliverCoordination = vi.fn(async () => {
    await store.append('b', {
      type: 'turn.settled',
      turnId: 'turn',
      stopReason: 'completed',
      errorMessage: null,
    })
    return false
  })
  expect(await send()).toMatchObject({ ok: true, result: { status: 'pending' } })
  await reload()
  expect(
    await service.invoke('b', 'session.wait', { targetSessionIds: ['a'], timeoutMs: 1000 }),
  ).toMatchObject({ ok: true, result: [{ status: 'coordination' }] })
  expect(await entries('b')).toHaveLength(1)
  expect((await store.load('b')).queuedMessages).toEqual([])
})

it('does not overwrite consumption with a late live-delivery outcome, including after replay', async () => {
  await busy('b')
  host.canDeliverCoordination = () => true
  host.deliverCoordination = async (message) => {
    await store.append('b', {
      type: 'coordination.updated',
      message: { ...message, status: 'consumed', consumedAt: 123 },
    })
    return true
  }
  expect(await send()).toMatchObject({ ok: true, result: { status: 'consumed', consumedAt: 123 } })
  await reload()
  expect(await service.invoke('b', 'session.inbox', {})).toMatchObject({
    ok: true,
    result: { messages: [] },
  })
  expect((await entries('b'))[0]).toMatchObject({ status: 'consumed', consumedAt: 123 })
})

it('reconciles recipient acceptance after a lost sender receipt without duplicate delivery', async () => {
  const record = host.record.bind(host)
  host.record = async (id, event) => {
    if (
      event.type === 'orchestration.operation.updated' &&
      event.operation.method === 'session.message' &&
      event.operation.status === 'completed'
    )
      throw new Error('lost receipt')
    return record(id, event)
  }
  expect(await send()).toMatchObject({ ok: false })
  host.record = record
  await reload()
  expect(await send()).toMatchObject({ ok: true, result: { status: 'pending' } })
  expect(await entries('b')).toHaveLength(1)
})

it('never repeats uncertain live delivery and recovers a consumed inbox acknowledgement', async () => {
  await busy('b')
  host.canDeliverCoordination = () => true
  const deliver = vi.fn(async () => true)
  host.deliverCoordination = deliver
  const record = host.record.bind(host)
  host.record = async (id, event) => {
    if (event.type === 'coordination.updated' && event.message.status === 'delivered')
      throw new Error('crash after live send')
    return record(id, event)
  }
  expect(await send()).toMatchObject({ ok: false })
  host.record = record
  await reload()
  const recovered = await send()
  expect(recovered).toMatchObject({ ok: true, result: { status: 'uncertain' } })
  expect(deliver).toHaveBeenCalledTimes(1)
  const message = (await entries('b'))[0]!
  host.record = async (id, event) => {
    if (
      event.type === 'orchestration.operation.updated' &&
      event.operation.method === 'session.ack' &&
      event.operation.status === 'completed'
    )
      throw new Error('crash after ack')
    return record(id, event)
  }
  const ack = { messageIds: [message.messageId], idempotencyKey: 'consume' }
  expect(await service.invoke('b', 'session.ack', ack)).toMatchObject({ ok: false })
  host.record = record
  await reload()
  expect(await service.invoke('b', 'session.ack', ack)).toMatchObject({ ok: true })
  expect((await entries('b'))[0]?.status).toBe('consumed')
  expect(deliver).toHaveBeenCalledTimes(1)
})
