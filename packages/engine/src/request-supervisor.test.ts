import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { delegationSettingsSchema } from '@ari/contracts/agent-control'
import type { MessageOrigin } from '@ari/contracts/message'
import type { Session } from '@ari/contracts/session'
import { AgentControlService, type ControlHost } from './agent-control'
import { RequestSupervisor, type RequestHost } from './request-supervisor'
import { SessionStore } from './session-store'
import { decideCommand } from './dispatcher'
import { helmSnapshot, turnRequester } from './helm'

let dir: string
let store: SessionStore
let service: AgentControlService
let host: RequestHost
let supervisor: RequestSupervisor
let seq = 0
const session = (id: string, parentSessionId?: string): Session => ({
  id,
  projectId: id === 'aria' ? 'helm' : 'project',
  title: id,
  driverKind: 'codex',
  modelId: 'model',
  permissionMode: 'full',
  status: 'idle',
  createdAt: 1,
  updatedAt: 1,
  ...(parentSessionId
    ? {
        parentSessionId,
        rootSessionId: 'lead',
        createdBy: { kind: 'session', sessionId: parentSessionId },
      }
    : id === 'lead'
      ? { createdBy: { kind: 'session', sessionId: 'aria' }, lead: true }
      : {}),
})
const notices = async (id: string) =>
  (await store.load(id)).messages.filter((message) => message.origin?.kind === 'coordination')
const inbox = async (id: string) => Object.values((await store.load(id)).inbox ?? {})

async function start(id: string, origin?: MessageOrigin): Promise<string> {
  await host.dispatch({ type: 'turn.start', sessionId: id, text: 'work', attachments: [] }, origin)
  return (await store.load(id)).activeTurnId!
}
async function settle(id: string): Promise<void> {
  await store.append(id, {
    type: 'turn.settled',
    turnId: (await store.load(id)).activeTurnId!,
    stopReason: 'completed',
    errorMessage: null,
  })
}
async function question(id = 'worker', inputId = 'question'): Promise<void> {
  await store.append(id, {
    type: 'input.requested',
    inputId,
    prompt: 'Which storage?',
    choicesJson: '["Settings","JSON"]',
  })
}
async function ready(): Promise<void> {
  await expect.poll(async () => (await inbox('aria')).length).toBe(1)
}
async function restart(): Promise<void> {
  await supervisor.close()
  for (const row of await store.listSessions()) await store.closeJournal(row.id)
  store = new SessionStore({ rootDir: dir })
  host.store = store
  service = new AgentControlService({ ...service.host, store })
  supervisor = new RequestSupervisor(host)
  supervisor.start()
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ari-request-sync-'))
  store = new SessionStore({ rootDir: dir })
  for (const row of [session('aria'), session('lead'), session('worker', 'lead')])
    await store.append(row.id, { type: 'session.created', session: row })
  host = {
    store,
    policy: () => delegationSettingsSchema.parse({ approvalMode: 'never' }),
    record: (id, event) => store.append(id, event),
    subscribe: (listener) => store.subscribe(listener),
    requestDelayMs: 60_000,
    dispatch: async (command, origin) => {
      if (!('sessionId' in command)) return { accepted: false }
      const decision = decideCommand(
        await store.load(command.sessionId),
        command,
        { turnId: `turn-${++seq}`, messageId: `message-${seq}` },
        origin,
      )
      for (const event of decision.events) await store.append(command.sessionId, event)
      return decision
    },
  }
  const controlHost: ControlHost = {
    ...host,
    store,
    version: 'test',
    providers: async () => [],
    create: async (row) => {
      await store.append(row.id, { type: 'session.created', session: row })
    },
    workspace: async () => dir,
    isolate: async () => ({ kind: 'project' }),
    diff: async () => ({}),
    integrate: async () => ({}),
    approve: async () => true,
    release: async () => undefined,
  }
  service = new AgentControlService(controlHost)
  host.notifyRequest = (senderId, recipientId, text, request, key) =>
    service.notifyRequest(senderId, recipientId, text, request, key)
  supervisor = new RequestSupervisor(host)
  await start('aria')
  await settle('aria')
  await start('lead', { kind: 'session', sessionId: 'aria' })
  await settle('lead')
  await start('worker', { kind: 'session', sessionId: 'lead' })
})

afterEach(async () => {
  await supervisor.close()
  for (const row of await store.listSessions()) await store.closeJournal(row.id)
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

it('recovers an idle lead and Aria from a descendant question without granting Aria the lead answer', async () => {
  await question()
  supervisor.start()
  await ready()
  await supervisor.evaluate('aria')
  await supervisor.evaluate('lead')
  expect(await notices('aria')).toHaveLength(1)
  expect(await notices('lead')).toHaveLength(1)
  expect((await inbox('aria'))[0]).toMatchObject({
    status: 'delivering',
    consumedAt: null,
    request: { kind: 'input', ownerSessionId: 'lead', resolvedAt: null },
  })
  expect(
    await service.invoke('aria', 'session.answer', {
      targetSessionId: 'worker',
      inputId: 'question',
      value: 'Settings',
      idempotencyKey: 'wrong-owner',
    }),
  ).toMatchObject({ ok: false, error: { code: 'scope_denied' } })
  expect(
    await service.invoke('lead', 'session.answer', {
      targetSessionId: 'worker',
      inputId: 'question',
      value: 'Settings',
      idempotencyKey: 'right-owner',
    }),
  ).toMatchObject({ ok: true })
  await expect.poll(async () => (await inbox('aria'))[0]?.request?.resolvedAt).not.toBeNull()
  expect((await inbox('aria'))[0]?.status).toBe('delivering')
})

it('holds a request behind a busy coordinator, then wakes once after settlement and ignores repeats', async () => {
  await start('aria')
  supervisor.start()
  await question()
  await ready()
  await supervisor.evaluate('aria')
  expect(await notices('aria')).toHaveLength(0)
  expect((await inbox('aria'))[0]?.status).toBe('pending')
  await settle('aria')
  await supervisor.evaluate('aria')
  await settle('aria')
  await question()
  await supervisor.evaluate('aria')
  expect(await notices('aria')).toHaveLength(1)
  expect(await inbox('aria')).toHaveLength(1)
})

it('routes questions on completion turns to their original requester and lets that requester answer', async () => {
  await start('lead', { kind: 'completion', sessionIds: ['worker'] })
  const current = (await store.load('lead')).activeTurnId!
  expect(turnRequester(await store.load('lead'), current)).toBe('aria')
  supervisor.start()
  await question('lead')
  await ready()
  await supervisor.evaluate('aria')
  expect(
    await service.invoke('aria', 'session.answer', {
      targetSessionId: 'lead',
      inputId: 'question',
      value: 'Settings',
      idempotencyKey: 'completion-answer',
    }),
  ).toMatchObject({ ok: true })
  expect((await store.load('lead')).pendingInputs).toHaveLength(0)
})

it('surfaces descendant approvals with human ownership and never answers them', async () => {
  supervisor.start()
  await store.append('worker', {
    type: 'approval.requested',
    approvalId: 'permission',
    toolName: 'shell',
    summaryJson: 'Run deployment?',
    options: [{ optionId: 'allow', name: 'Allow', kind: 'allow-once' }],
  })
  await ready()
  await supervisor.evaluate('aria')
  expect((await inbox('aria'))[0]).toMatchObject({
    request: { kind: 'approval', ownerSessionId: null },
  })
  expect((await inbox('aria'))[0]?.text).toContain('Do not answer it')
  expect(
    await service.invoke('lead', 'session.answer', {
      targetSessionId: 'worker',
      inputId: 'permission',
      value: 'allow',
      idempotencyKey: 'refuse-approval',
    }),
  ).toMatchObject({ ok: false, error: { code: 'invalid_request' } })
  expect((await store.load('worker')).pendingApprovals).toHaveLength(1)
})

it('cancels a stale wake when the request resolves during delivery preparation', async () => {
  supervisor.start()
  await question()
  await ready()
  const record = host.record.bind(host)
  host.record = async (id, event) => {
    const result = await record(id, event)
    if (
      id === 'aria' &&
      event.type === 'orchestration.operation.updated' &&
      event.operation.status === 'started'
    )
      await store.append('worker', {
        type: 'input.responded',
        inputId: 'question',
        value: 'Settings',
      })
    return result
  }
  await supervisor.evaluate('aria')
  expect(await notices('aria')).toHaveLength(0)
  await expect.poll(async () => (await inbox('aria'))[0]?.request?.resolvedAt).not.toBeNull()
})

it('reconciles an accepted wake after a lost delivery receipt without a duplicate provider submission', async () => {
  supervisor.start()
  await question()
  await ready()
  const record = host.record.bind(host)
  host.record = async (id, event) => {
    if (
      id === 'aria' &&
      event.type === 'coordination.updated' &&
      event.message.status === 'delivering'
    )
      throw new Error('crash before receipt')
    return record(id, event)
  }
  await supervisor.evaluate('aria')
  expect(await notices('aria')).toHaveLength(1)
  expect((await inbox('aria'))[0]?.status).toBe('pending')
  host.record = record
  await restart()
  await supervisor.evaluate('aria')
  expect(await notices('aria')).toHaveLength(1)
  expect((await inbox('aria'))[0]?.status).toBe('delivering')
})

it('retains uncertain submission state across restart and never resends it automatically', async () => {
  supervisor.start()
  await question()
  await ready()
  const dispatch = host.dispatch.bind(host)
  host.dispatch = async (command, origin) => {
    if ('sessionId' in command && command.sessionId === 'aria')
      throw new Error('connection lost during submission')
    return dispatch(command, origin)
  }
  await supervisor.evaluate('aria')
  host.dispatch = dispatch
  await restart()
  await supervisor.evaluate('aria')
  await supervisor.evaluate('aria')
  expect(await notices('aria')).toHaveLength(0)
  expect((await inbox('aria'))[0]?.status).toBe('uncertain')
  expect(
    Object.values((await store.load('aria')).orchestration?.operations ?? {}).some(
      (operation) => operation.status === 'uncertain',
    ),
  ).toBe(true)
})

it('exposes descendants, request ids and journal freshness through Aria status and context', async () => {
  await question()
  const status = await service.invoke('aria', 'session.status', { recursive: true })
  expect(status.ok).toBe(true)
  const tasks = (status as { result: { tasks: { sessionId: string }[] } }).result.tasks
  expect(tasks.find((task) => task.sessionId === 'worker')).toMatchObject({
    sessionId: 'worker',
    workState: 'blocked_on_parent',
    questionOwnerSessionId: 'lead',
    pendingInputs: [
      { inputId: 'question', prompt: 'Which storage?', choicesJson: '["Settings","JSON"]' },
    ],
    lastSeq: (await store.load('worker')).lastSeq,
  })
  const context = await service.invoke('aria', 'session.read', { targetSessionId: 'worker' })
  expect(context).toMatchObject({
    ok: true,
    result: {
      pendingInputs: [{ inputId: 'question' }],
      questionOwnerSessionId: 'lead',
      lastSeq: (await store.load('worker')).lastSeq,
    },
  })
  const rows = await store.listSessions()
  const staleRows = rows.map((row) => ({ ...row, status: 'idle' as const }))
  const snapshot = await helmSnapshot(
    { rows: staleRows, load: (id) => store.load(id), projectName: () => 'Project' },
    await store.load('aria'),
    [],
  )
  expect(snapshot).toContain('question question, owner lead')
  expect(snapshot).toContain('waiting for delegated work')
})

it('keeps human-started questions with the human and refuses a stopped coordinator wake', async () => {
  await settle('worker')
  await start('worker')
  supervisor.start()
  await question()
  await supervisor.evaluate('aria')
  expect(await inbox('aria')).toHaveLength(0)
  expect(
    await service.invoke('aria', 'session.answer', {
      targetSessionId: 'worker',
      inputId: 'question',
      value: 'Settings',
      idempotencyKey: 'human-question',
    }),
  ).toMatchObject({ ok: false, error: { code: 'scope_denied' } })
  await store.append('aria', {
    type: 'turn.settled',
    turnId: 'stop',
    stopReason: 'interrupted',
    errorMessage: null,
  })
  await supervisor.evaluate('aria')
  expect(await notices('aria')).toHaveLength(0)
})

it('keeps approved live delivery separate from consumption and never wakes again for it', async () => {
  await start('aria')
  const deliveries: string[] = []
  service.host.canDeliverCoordination = (id) => id === 'aria'
  service.host.deliverCoordination = async (message) => {
    deliveries.push(message.messageId)
    expect(await service.invoke('aria', 'session.inbox', {})).toMatchObject({
      ok: true,
      result: { messages: [{ status: 'delivering' }] },
    })
    return true
  }
  supervisor.start()
  await question()
  await ready()
  await expect.poll(async () => (await inbox('aria'))[0]?.status).toBe('delivered')
  expect(deliveries).toHaveLength(1)
  await settle('aria')
  await supervisor.evaluate('aria')
  expect(await notices('aria')).toHaveLength(0)
  expect((await inbox('aria'))[0]?.consumedAt).toBeNull()
})

it('wakes an idle coordinator for an explicit parent note but keeps downstream notes for the next assignment', async () => {
  supervisor.start()
  await start('lead', { kind: 'session', sessionId: 'aria' })
  const parentNote = await service.invoke('lead', 'session.message', {
    targetSessionId: 'parent',
    text: 'Need a storage decision from you.',
    idempotencyKey: 'parent-note',
  })
  expect(parentNote).toMatchObject({ ok: true, result: { status: 'pending' } })
  await supervisor.evaluate('aria')
  expect(await notices('aria')).toHaveLength(1)
  expect((await inbox('aria'))[0]).toMatchObject({ status: 'delivering', consumedAt: null })
  await settle('worker')
  await service.invoke('aria', 'session.message', {
    targetSessionId: 'worker',
    text: 'Use Settings when you continue.',
    idempotencyKey: 'downstream-note',
  })
  await supervisor.evaluate('worker')
  expect(await notices('worker')).toHaveLength(0)
  expect((await inbox('worker'))[0]?.status).toBe('pending')
})

it('holds attention at the automatic-turn cap until a human returns', async () => {
  for (let index = 0; index < 8; index++) {
    await start('aria', {
      kind: 'coordination',
      deliveryId: `cap-${index}`,
      messageIds: [`cap-inbox-${index}`],
    })
    await settle('aria')
  }
  supervisor.start()
  await question()
  await ready()
  await supervisor.evaluate('aria')
  expect((await inbox('aria'))[0]?.status).toBe('pending')
  expect(await notices('aria')).toHaveLength(8)
  await start('aria')
  await settle('aria')
  await supervisor.evaluate('aria')
  expect(await notices('aria')).toHaveLength(9)
})

it('refuses a stale answer if a later human turn reuses the provider input id', async () => {
  await start('lead', { kind: 'session', sessionId: 'aria' })
  await question('lead')
  const dispatch = service.host.dispatch.bind(service.host)
  service.host.dispatch = async (command, origin) => {
    if (command.type === 'input.respond') {
      await settle('lead')
      await start('lead')
      await question('lead')
    }
    return dispatch(command, origin)
  }
  expect(
    await service.invoke('aria', 'session.answer', {
      targetSessionId: 'lead',
      inputId: 'question',
      value: 'Settings',
      idempotencyKey: 'stale-answer',
    }),
  ).toMatchObject({ ok: false, error: { code: 'invalid_request' } })
  expect((await store.load('lead')).pendingInputs).toHaveLength(1)
})

it('routes an active project question to the current Aria after the old topic was deleted', async () => {
  await start('lead', { kind: 'session', sessionId: 'aria' })
  await store.append('aria2', {
    type: 'session.created',
    session: { ...session('aria'), id: 'aria2' },
  })
  await start('aria2')
  await settle('aria2')
  await store.destroy('aria')
  supervisor.start()
  await question('lead')
  await expect.poll(async () => (await inbox('aria2')).length).toBe(1)
  expect((await inbox('aria2'))[0]?.request?.ownerSessionId).toBe('aria2')
  expect(
    await service.invoke('aria2', 'session.answer', {
      targetSessionId: 'lead',
      inputId: 'question',
      value: 'Settings',
      idempotencyKey: 'new-topic-answer',
    }),
  ).toMatchObject({ ok: true })
})

it('keeps a root waiting for its queued descendants instead of reporting a final result', async () => {
  await settle('worker')
  await service.invoke('lead', 'session.prompt', {
    targetSessionId: 'worker',
    text: 'Queued continuation',
    idempotencyKey: 'queued-worker',
  })
  const tasks = await service.tasks('aria', true)
  expect(tasks.find((task) => task.sessionId === 'lead')?.workState).toBe('waiting_for_children')
  expect(tasks.find((task) => task.sessionId === 'worker')?.queuedMessages).toBe(1)
})

it('awaits in-flight request persistence on shutdown and starts no late coordinator turn', async () => {
  let entered!: () => void
  let release!: () => void
  const blocked = new Promise<void>((resolve) => {
    entered = resolve
  })
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const record = host.record.bind(host)
  delete host.notifyRequest
  host.record = async (id, event) => {
    if (event.type === 'coordination.updated' && event.message.status === 'pending') {
      entered()
      await gate
    }
    return record(id, event)
  }
  supervisor.start()
  await question()
  await blocked
  let closed = false
  const closing = supervisor.close().then(() => {
    closed = true
  })
  await Promise.resolve()
  expect(closed).toBe(false)
  release()
  await closing
  expect(await notices('aria')).toHaveLength(0)
  expect(await inbox('lead')).toHaveLength(1)
})
