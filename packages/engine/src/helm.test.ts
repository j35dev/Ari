import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { delegationSettingsSchema, type HelmProject } from '@ari/contracts/agent-control'
import { HELM_PROJECT_ID } from '@ari/contracts/helm'
import type { Session } from '@ari/contracts/session'
import { AgentControlService, type ControlHost } from './agent-control'
import { SessionStore } from './session-store'
import { decideCommand } from './dispatcher'
import { findSessions, helmSnapshot, turnRequester, type HelmView } from './helm'

let dir: string
let store: SessionStore
let service: AgentControlService
let seq = 0
let projects: HelmProject[]

const base: Omit<Session, 'id' | 'projectId' | 'title'> = {
  driverKind: 'claude',
  modelId: null,
  permissionMode: 'allow-edits',
  status: 'idle',
  createdAt: 1,
  updatedAt: 1,
}
const helm: Session = { ...base, id: 'helm1', projectId: HELM_PROJECT_ID, title: 'Plan the week' }
const web: Session = { ...base, id: 'web1', projectId: 'web', title: 'Login redirect bug' }
const api: Session = { ...base, id: 'api1', projectId: 'api', title: 'Rate limiter' }
const apiChild: Session = {
  ...base,
  id: 'api2',
  projectId: 'api',
  title: 'Limiter tests',
  parentSessionId: 'api1',
  rootSessionId: 'api1',
  createdBy: { kind: 'session', sessionId: 'api1' },
}

async function startTurn(id: string, text: string, origin?: Session['createdBy']): Promise<string> {
  const turnId = `t${++seq}`
  const decision = decideCommand(
    await store.load(id),
    { type: 'turn.start', sessionId: id, text, attachments: [] },
    { turnId, messageId: `m${seq}` },
    origin ?? undefined,
  )
  for (const event of decision.events) await store.append(id, event)
  return turnId
}

async function reply(id: string, turnId: string, text: string): Promise<void> {
  await store.append(id, {
    type: 'assistant.parts.appended',
    messageId: `reply-${turnId}`,
    parts: [{ type: 'text', text }],
  })
  await store.append(id, {
    type: 'turn.settled',
    turnId,
    stopReason: 'completed',
    errorMessage: null,
  })
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ari-helm-'))
  store = new SessionStore({ rootDir: dir })
  for (const session of [helm, web, api, apiChild])
    await store.append(session.id, { type: 'session.created', session })
  projects = [
    { projectId: HELM_PROJECT_ID, name: 'Aria', path: dir, available: true },
    { projectId: 'web', name: 'Web', path: dir, available: true },
    { projectId: 'api', name: 'API', path: dir, available: true },
    { projectId: 'gone', name: 'Gone', path: dir, available: false },
  ]
  const host: ControlHost = {
    store,
    version: 'test',
    policy: () => delegationSettingsSchema.parse({ approvalMode: 'never' }),
    providers: async () => [
      { driverKind: 'claude', available: true, models: [{ id: 'model', label: 'Model' }] },
    ],
    projects: async () => projects,
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

const launch = {
  title: 'Fix login redirect',
  driverKind: 'claude',
  projectId: 'web',
  prompt: 'Fix the redirect after login and add a test.',
  idempotencyKey: 'launch-1',
}

it('starts a top-level session in another project that answers to Aria', async () => {
  const result = await service.invoke('helm1', 'session.spawn', launch)
  expect(result.ok).toBe(true)
  const id = (result as { result: { child: Session } }).result.child.id
  const model = await store.load(id)
  expect(model.session?.parentSessionId).toBeUndefined()
  expect(model.session).toMatchObject({
    projectId: 'web',
    createdBy: { kind: 'session', sessionId: 'helm1' },
    workspace: { kind: 'project' },
    permissionMode: 'allow-edits',
  })
  // The assignment is queued with Aria as its origin, which routes the report back.
  expect(model.queuedMessages[0]?.origin).toEqual({ kind: 'session', sessionId: 'helm1' })
  // A retry with the same key reuses the session instead of starting another.
  const again = await service.invoke('helm1', 'session.spawn', launch)
  expect((again as { result: { child: Session } }).result.child.id).toBe(id)
})

it('refuses Aria spawns it cannot place, and cross-project spawns from anyone else', async () => {
  const code = async (caller: string, params: object) => {
    const result = await service.invoke(caller, 'session.spawn', { ...launch, ...params })
    return result.ok ? 'ok' : result.error.code
  }
  expect(await code('helm1', { projectId: undefined, idempotencyKey: 'a' })).toBe('invalid_request')
  expect(await code('helm1', { projectId: HELM_PROJECT_ID, idempotencyKey: 'b' })).toBe(
    'project_not_found',
  )
  expect(await code('helm1', { projectId: 'gone', idempotencyKey: 'c' })).toBe(
    'project_unavailable',
  )
  expect(await code('helm1', { workspaceMode: 'isolated', idempotencyKey: 'd' })).toBe(
    'invalid_request',
  )
  expect(await code('helm1', { permissionMode: 'full', idempotencyKey: 'e' })).toBe('scope_denied')
  expect(await code('web1', { projectId: 'api', idempotencyKey: 'f' })).toBe('scope_denied')
})

it('caps how many sessions Aria keeps working at once', async () => {
  projects = [...projects]
  for (let i = 0; i < 4; i++)
    expect(
      (await service.invoke('helm1', 'session.spawn', { ...launch, idempotencyKey: `cap-${i}` }))
        .ok,
    ).toBe(true)
  const over = await service.invoke('helm1', 'session.spawn', {
    ...launch,
    idempotencyKey: 'cap-4',
  })
  expect(over.ok ? null : over.error.code).toBe('delegation_limit')
})

it('lets Aria read, prompt and stop sessions anywhere, but not delete or integrate them', async () => {
  const read = await service.invoke('helm1', 'session.read', { targetSessionId: 'api2' })
  expect(read.ok).toBe(true)
  const prompt = await service.invoke('helm1', 'session.prompt', {
    targetSessionId: 'web1',
    text: 'Also cover the logout path.',
    idempotencyKey: 'follow-up',
  })
  expect(prompt.ok).toBe(true)
  expect((await store.load('web1')).queuedMessages[0]?.origin).toEqual({
    kind: 'session',
    sessionId: 'helm1',
  })
  expect(
    (
      await service.invoke('helm1', 'session.stop', {
        targetSessionId: 'web1',
        idempotencyKey: 's',
      })
    ).ok,
  ).toBe(true)
  const destroy = await service.invoke('helm1', 'session.destroy', {
    targetSessionId: 'web1',
    idempotencyKey: 'd',
  })
  expect(destroy.ok ? null : destroy.error.code).toBe('scope_denied')
  const diff = await service.invoke('helm1', 'session.diff', { targetSessionId: 'api2' })
  expect(diff.ok ? null : diff.error.code).toBe('scope_denied')
  // Other sessions keep their project boundary.
  const cross = await service.invoke('web1', 'session.read', { targetSessionId: 'api1' })
  expect(cross.ok ? null : cross.error.code).toBe('scope_denied')
})

it('lists projects and finds sessions for Aria only', async () => {
  const listed = await service.invoke('helm1', 'projects.list', {})
  expect(
    (listed as { result: { projects: HelmProject[] } }).result.projects.map((p) => p.projectId),
  ).toEqual(['web', 'api', 'gone'])
  const denied = await service.invoke('web1', 'projects.list', {})
  expect(denied.ok ? null : denied.error.code).toBe('scope_denied')

  const found = await service.invoke('helm1', 'sessions.find', { query: 'login' })
  const rows = (found as { result: { sessions: { sessionId: string }[] } }).result.sessions
  expect(rows.map((row) => row.sessionId)).toEqual(['web1'])
  const inApi = await service.invoke('helm1', 'sessions.find', { projectId: 'api' })
  expect(
    (inApi as { result: { sessions: { sessionId: string }[] } }).result.sessions
      .map((row) => row.sessionId)
      .sort(),
  ).toEqual(['api1', 'api2'])
})

it('lets a session Aria started message Aria as its parent', async () => {
  const spawned = await service.invoke('helm1', 'session.spawn', launch)
  const id = (spawned as { result: { child: Session } }).result.child.id
  const sent = await service.invoke(id, 'session.message', {
    targetSessionId: 'parent',
    text: 'Should the redirect keep the query string?',
    idempotencyKey: 'q1',
  })
  expect(sent.ok).toBe(true)
  const inbox = Object.values((await store.load('helm1')).inbox ?? {})
  expect(inbox.map((message) => message.senderSessionId)).toEqual([id])
  // A session Aria never started cannot reach it.
  const stranger = await service.invoke('web1', 'session.message', {
    targetSessionId: 'helm1',
    text: 'hello',
    idempotencyKey: 'q2',
  })
  expect(stranger.ok ? null : stranger.error.code).toBe('scope_denied')
})

it('attributes a results wake-up to the session that asked for the work', async () => {
  const asked = await startTurn('api1', 'Add a limiter', { kind: 'session', sessionId: 'helm1' })
  await reply('api1', asked, 'Delegated the tests.')
  const model = await store.load('api1')
  expect(turnRequester(model, asked)).toBe('helm1')
  // The children's results arrive as an Ari-written turn; Aria still asked for it.
  const wake = `t${++seq}`
  const decision = decideCommand(
    model,
    { type: 'turn.start', sessionId: 'api1', text: 'results', attachments: [] },
    { turnId: wake, messageId: `m${seq}` },
    { kind: 'completion', sessionIds: ['api2'] },
  )
  for (const event of decision.events) await store.append('api1', event)
  expect(turnRequester(await store.load('api1'), wake)).toBe('helm1')
  // A person's turn belongs to the person.
  const mine = await startTurn('web1', 'Look at this', { kind: 'human' } as never)
  expect(turnRequester(await store.load('web1'), mine)).toBeNull()
})

it('tells Aria what is running across projects and what finished lately', async () => {
  const running = await startTurn('api2', 'Write the tests', { kind: 'session', sessionId: 'api1' })
  void running
  const done = await startTurn('web1', 'Fix it', { kind: 'session', sessionId: 'helm1' })
  await reply('web1', done, 'Fixed the redirect.')
  // The engine routes the settle to Aria, which asked for the turn.
  await store.append('helm1', {
    type: 'child.session.settled',
    childSessionId: 'web1',
    turnId: done,
    stopReason: 'completed',
  })
  const view: HelmView = {
    rows: await store.listSessions(),
    load: (id) => store.load(id),
    projectName: (id) => projects.find((p) => p.projectId === id)?.name ?? null,
  }
  const text = await helmSnapshot(view, await store.load('helm1'), projects)
  expect(text).toContain('[Ari now:')
  expect(text).toContain('Projects: Web (web), API (api), Gone (gone, folder missing)')
  expect(text).toContain('"Limiter tests" (api2) in API, child of "Rate limiter": working')
  expect(text).toContain('Finished in the last day, from work you asked for:')
  expect(text).toMatch(/"Login redirect bug" \(web1\) in Web: idle, \d+m ago/)
  expect(text).not.toContain('helm1')
  const active = await findSessions(view, { scope: 'active', limit: 10 })
  expect(active.map((row) => row.sessionId)).toEqual(['api2'])
})

it('reports the sessions Aria started in its own status, like children', async () => {
  const spawned = await service.invoke('helm1', 'session.spawn', launch)
  const id = (spawned as { result: { child: Session } }).result.child.id
  const status = await service.invoke('helm1', 'session.status', {})
  const tasks = (
    status as { result: { tasks: { sessionId: string; delivered: boolean | null }[] } }
  ).result.tasks
  expect(tasks.map((task) => task.sessionId)).toEqual([id])
  expect(tasks[0]?.delivered).toBe(false)
})
