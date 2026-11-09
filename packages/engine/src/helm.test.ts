import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { delegationSettingsSchema, type HelmProject } from '@ari/contracts/agent-control'
import { HELM_PROJECT_ID } from '@ari/contracts/helm'
import type { Session } from '@ari/contracts/session'
import { AgentControlService, type ControlHost } from './agent-control'
import { SessionStore } from './session-store'
import { decideCommand } from './dispatcher'
import { providerTurnContext } from './provider-context'
import {
  findSessions,
  helmSnapshot,
  helmReportRecipient,
  helmTaskRecipient,
  turnRequester,
  type HelmView,
} from './helm'

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
    {
      projectId: 'web',
      name: 'Web',
      path: dir,
      available: true,
      defaultAgent: {
        driverKind: 'claude',
        modelId: 'model',
        effort: null,
        permissionMode: 'allow-edits',
      },
    },
    {
      projectId: 'api',
      name: 'API',
      path: dir,
      available: true,
      defaultAgent: {
        driverKind: 'claude',
        modelId: 'model',
        effort: null,
        permissionMode: 'allow-edits',
      },
    },
    { projectId: 'gone', name: 'Gone', path: dir, available: false },
  ]
  const host: ControlHost = {
    store,
    version: 'test',
    policy: () => delegationSettingsSchema.parse({ approvalMode: 'never' }),
    providers: async () => [
      {
        driverKind: 'claude',
        available: true,
        models: [{ id: 'model', label: 'Model' }],
        defaultModelId: 'model',
      },
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
  expect(model.session?.lead).toBeUndefined()
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
      (
        await service.invoke('helm1', 'session.spawn', {
          ...launch,
          readOnly: true,
          idempotencyKey: `cap-${i}`,
        })
      ).ok,
    ).toBe(true)
  const over = await service.invoke('helm1', 'session.spawn', {
    ...launch,
    readOnly: true,
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
  expect(text).toContain('Projects:\n- Web (web)\n- API (api)\n- Gone (gone, folder missing)')
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

it('creates one persistent project lead, reuses it across Aria topics and persists idempotent asks', async () => {
  const ask = { projectId: 'web', text: 'Fix login', idempotencyKey: 'ask-1' }
  const first = await service.invoke('helm1', 'projects.ask', ask)
  expect(first.ok).toBe(true)
  const id = (first as { result: { sessionId: string } }).result.sessionId
  const lead = (await store.load(id)).session
  expect(lead).toMatchObject({
    title: 'Web lead',
    lead: true,
    projectId: 'web',
    driverKind: 'claude',
    modelId: 'model',
    createdBy: { kind: 'session', sessionId: 'helm1' },
    workspace: { kind: 'project' },
  })
  expect(lead?.parentSessionId).toBeUndefined()
  expect((await store.load(id)).queuedMessages[0]?.origin).toEqual({
    kind: 'session',
    sessionId: 'helm1',
  })
  service = new AgentControlService(service.host)
  expect(await service.invoke('helm1', 'projects.ask', ask)).toEqual(first)
  expect((await store.load(id)).queuedMessages).toHaveLength(1)
  await store.append('helm2', { type: 'session.created', session: { ...helm, id: 'helm2' } })
  const followup = await service.invoke('helm2', 'projects.ask', {
    ...ask,
    text: 'Also cover logout',
    title: 'Ignored for existing lead',
    idempotencyKey: 'ask-2',
  })
  expect((followup as { result: { sessionId: string } }).result.sessionId).toBe(id)
  expect(followup).toMatchObject({ result: { agent: { source: 'lead', modelId: 'model' } } })
  expect((await store.load(id)).queuedMessages[1]?.origin).toEqual({
    kind: 'session',
    sessionId: 'helm2',
  })
  expect((await store.load(id)).session?.title).toBe('Web lead')
  await startTurn(id, 'Follow-up', { kind: 'session', sessionId: 'helm2' })
  expect(
    (
      await service.invoke(id, 'session.message', {
        targetSessionId: 'parent',
        text: 'Which logout behavior?',
        idempotencyKey: 'lead-question',
      })
    ).ok,
  ).toBe(true)
  expect(
    Object.values((await store.load('helm2')).inbox ?? {}).map(
      (message) => message.senderSessionId,
    ),
  ).toEqual([id])
  expect(Object.values((await store.load('helm1')).inbox ?? {})).toHaveLength(0)
})

it('reuses a project lead after its creating Aria chat is destroyed', async () => {
  const first = await service.invoke('helm1', 'projects.ask', {
    projectId: 'web',
    text: 'Fix login',
    idempotencyKey: 'before-reset',
  })
  const id = (first as { result: { sessionId: string } }).result.sessionId
  const lead = (await store.load(id)).session!
  expect(lead.createdBy).toEqual({ kind: 'session', sessionId: 'helm1' })
  const turn = await startTurn(id, 'Fix login', { kind: 'session', sessionId: 'helm1' })
  await reply(id, turn, 'Login fixed.')
  await store.destroy('helm1')
  await store.append('helm2', { type: 'session.created', session: { ...helm, id: 'helm2' } })
  service = new AgentControlService(service.host)
  const next = await service.invoke('helm2', 'projects.ask', {
    projectId: 'web',
    text: 'Also fix logout',
    idempotencyKey: 'after-reset',
  })
  expect(next).toMatchObject({ ok: true, result: { sessionId: id } })
  expect(
    (await store.load(id)).messages.some((message) =>
      JSON.stringify(message.parts).includes('Login fixed.'),
    ),
  ).toBe(true)
  expect((await store.load(id)).queuedMessages.at(-1)?.origin).toEqual({
    kind: 'session',
    sessionId: 'helm2',
  })
  expect(
    (await store.listSessions()).filter((row) => row.projectId === 'web' && row.id !== web.id),
  ).toHaveLength(1)
})

it('counts working project leads after their creating Aria chat is destroyed', async () => {
  const first = await service.invoke('helm1', 'projects.ask', {
    projectId: 'web',
    text: 'Fix login',
    idempotencyKey: 'reset-cap-a',
  })
  expect(first.ok).toBe(true)
  await store.destroy('helm1')
  await store.append('helm2', { type: 'session.created', session: { ...helm, id: 'helm2' } })
  service.host.policy = () =>
    delegationSettingsSchema.parse({ approvalMode: 'never', maxConcurrentChildren: 1 })
  expect(
    await service.invoke('helm2', 'projects.ask', {
      projectId: 'api',
      text: 'Fix API',
      idempotencyKey: 'reset-cap-b',
    }),
  ).toMatchObject({ ok: false, error: { code: 'delegation_limit' } })
})

it('serializes simultaneous asks from different Aria topics into one project lead', async () => {
  await store.append('helm2', { type: 'session.created', session: { ...helm, id: 'helm2' } })
  const results = await Promise.all([
    service.invoke('helm1', 'projects.ask', {
      projectId: 'web',
      text: 'Fix login',
      idempotencyKey: 'parallel-a',
    }),
    service.invoke('helm2', 'projects.ask', {
      projectId: 'web',
      text: 'Also fix logout',
      idempotencyKey: 'parallel-b',
    }),
  ])
  const ids = results.map(
    (result) => (result as { result: { sessionId: string } }).result.sessionId,
  )
  expect(new Set(ids).size).toBe(1)
  expect((await store.load(ids[0]!)).queuedMessages).toHaveLength(2)
})

it('keeps project asks and legacy spawns idempotent when their keys match', async () => {
  const ask = { projectId: 'web', text: 'Fix login', idempotencyKey: 'same-key' }
  const lead = await service.invoke('helm1', 'projects.ask', ask)
  const spawned = await service.invoke('helm1', 'session.spawn', {
    ...launch,
    readOnly: true,
    idempotencyKey: 'same-key',
  })
  expect((spawned as { result: { child: Session } }).result.child.id).not.toBe(
    (lead as { result: { sessionId: string } }).result.sessionId,
  )
  service = new AgentControlService(service.host)
  expect(await service.invoke('helm1', 'projects.ask', ask)).toEqual(lead)
  expect(
    await service.invoke('helm1', 'session.spawn', {
      ...launch,
      readOnly: true,
      idempotencyKey: 'same-key',
    }),
  ).toEqual(spawned)
})

it('enforces one project concurrency cap across simultaneous Aria topics', async () => {
  await store.append('helm2', { type: 'session.created', session: { ...helm, id: 'helm2' } })
  service.host.policy = () =>
    delegationSettingsSchema.parse({ approvalMode: 'never', maxConcurrentChildren: 1 })
  const results = await Promise.all([
    service.invoke('helm1', 'projects.ask', {
      projectId: 'web',
      text: 'Fix login',
      idempotencyKey: 'global-cap-a',
    }),
    service.invoke('helm2', 'projects.ask', {
      projectId: 'api',
      text: 'Fix API',
      idempotencyKey: 'global-cap-b',
    }),
  ])
  expect(results.filter((result) => result.ok)).toHaveLength(1)
  expect(results.find((result) => !result.ok)).toMatchObject({
    ok: false,
    error: { code: 'delegation_limit' },
  })
})

it('replaces archived leads and does not adopt a user-created lead', async () => {
  await store.append('userlead', {
    type: 'session.created',
    session: { ...web, id: 'userlead', lead: true },
  })
  const ask = { projectId: 'web', text: 'Fix login', idempotencyKey: 'ask-a' }
  const first = await service.invoke('helm1', 'projects.ask', ask)
  const id = (first as { result: { sessionId: string } }).result.sessionId
  expect(id).not.toBe('userlead')
  await store.append(id, { type: 'session.updated', archived: true })
  const next = await service.invoke('helm1', 'projects.ask', {
    ...ask,
    idempotencyKey: 'ask-b',
    title: 'New web lead',
  })
  const nextId = (next as { result: { sessionId: string } }).result.sessionId
  expect(nextId).not.toBe(id)
  expect((await store.load(nextId)).session?.title).toBe('New web lead')
})

it('limits project commands to Aria and asks for a user choice when Aria and the project have no valid model', async () => {
  await store.append('helm1', { type: 'session.updated', modelId: 'unavailable' })
  projects.push({ projectId: 'fresh', name: 'Fresh', path: dir, available: true })
  const ask = { projectId: 'fresh', text: 'Build it', idempotencyKey: 'unknown-agent' }
  const missing = await service.invoke('helm1', 'projects.ask', ask)
  expect(missing).toMatchObject({
    ok: false,
    error: { code: 'model_unavailable' },
  })
  expect(missing.ok ? '' : missing.error.message).toContain('Ask the user')
  expect(missing.ok ? '' : missing.error.message).toContain('ari project default')
  expect((await store.listSessions()).filter((row) => row.projectId === 'fresh')).toHaveLength(0)
  expect(await service.invoke('web1', 'projects.ask', ask)).toMatchObject({
    ok: false,
    error: { code: 'scope_denied' },
  })
  expect(
    await service.invoke('web1', 'projects.setDefault', {
      projectId: 'web',
      driverKind: 'claude',
      modelId: 'model',
      idempotencyKey: 'default',
    }),
  ).toMatchObject({ ok: false, error: { code: 'scope_denied' } })
  service.host.setProjectDefault = async (id, value) => {
    const project = projects.find((p) => p.projectId === id)
    if (!project) return false
    project.defaultAgent = value
    return true
  }
  expect(
    (
      await service.invoke('helm1', 'projects.setDefault', {
        projectId: 'fresh',
        driverKind: 'claude',
        modelId: 'model',
        effort: 'high',
        idempotencyKey: 'set-agent',
      })
    ).ok,
  ).toBe(true)
  const listed = await service.invoke('helm1', 'projects.list', {})
  expect(
    (listed as { result: { projects: HelmProject[] } }).result.projects.find(
      (p) => p.projectId === 'fresh',
    )?.agent,
  ).toEqual({
    driverKind: 'claude',
    modelId: 'model',
    effort: 'high',
    permissionMode: 'ask',
    source: 'project',
  })
  expect((await service.invoke('helm1', 'projects.ask', ask)).ok).toBe(true)
})

it('uses delegation approval and refuses an existing lead above Aria permission', async () => {
  let allowed = false
  service.host.approve = async () => allowed
  service.host.policy = () => delegationSettingsSchema.parse({ approvalMode: 'always' })
  const ask = { projectId: 'web', text: 'Fix login', idempotencyKey: 'approval-a' }
  expect(await service.invoke('helm1', 'projects.ask', ask)).toMatchObject({
    ok: false,
    error: { code: 'delegation_approval_required' },
  })
  allowed = true
  const first = await service.invoke('helm1', 'projects.ask', {
    ...ask,
    idempotencyKey: 'approval-b',
  })
  const id = (first as { result: { sessionId: string } }).result.sessionId
  allowed = false
  expect(
    await service.invoke('helm1', 'projects.ask', { ...ask, idempotencyKey: 'approval-c' }),
  ).toMatchObject({ ok: false, error: { code: 'delegation_approval_required' } })
  allowed = true
  await store.append(id, { type: 'session.updated', permissionMode: 'full' })
  expect(
    await service.invoke('helm1', 'projects.ask', { ...ask, idempotencyKey: 'approval-d' }),
  ).toMatchObject({ ok: false, error: { code: 'scope_denied' } })
  await store.append(id, { type: 'session.updated', permissionMode: 'ask' })
  service.host.providers = async () => []
  expect(
    await service.invoke('helm1', 'projects.ask', { ...ask, idempotencyKey: 'approval-e' }),
  ).toMatchObject({ ok: false, error: { code: 'model_unavailable' } })
})

it('caps inherited lead permissions but refuses an explicit elevation on creation', async () => {
  expect(
    await service.invoke('helm1', 'projects.ask', {
      projectId: 'api',
      text: 'Fix it',
      driverKind: 'codex',
      permissionMode: 'full',
      idempotencyKey: 'explicit-fallback',
    }),
  ).toMatchObject({ ok: false, error: { code: 'scope_denied' } })
  await store.append('web1', { type: 'session.updated', permissionMode: 'full' })
  const ask = { projectId: 'web', text: 'Fix login', idempotencyKey: 'permission-explicit' }
  expect(
    await service.invoke('helm1', 'projects.ask', { ...ask, permissionMode: 'full' }),
  ).toMatchObject({ ok: false, error: { code: 'scope_denied' } })
  expect(
    await service.invoke('helm1', 'projects.ask', { ...ask, idempotencyKey: 'permission-inherit' }),
  ).toMatchObject({ ok: true, result: { reused: false, lead: { permissionMode: 'allow-edits' } } })
  service.host.projectAgentDefaults = () => ({ permissionMode: 'full' })
  projects.push({ projectId: 'fresh', name: 'Fresh', path: dir, available: true })
  expect(
    await service.invoke('helm1', 'projects.ask', {
      projectId: 'fresh',
      text: 'Build it',
      driverKind: 'claude',
      modelId: 'model',
      idempotencyKey: 'app-permission',
    }),
  ).toMatchObject({ ok: true, result: { lead: { permissionMode: 'allow-edits' } } })
})

it('replaces a lead whose provider is unavailable and reports the actual agent when reusing it', async () => {
  const ask = { projectId: 'web', text: 'Fix login', idempotencyKey: 'stale-first' }
  const first = await service.invoke('helm1', 'projects.ask', ask)
  const id = (first as { result: { sessionId: string } }).result.sessionId
  await store.append(id, {
    type: 'message.dequeued',
    text: ask.text,
    attachments: [],
    origin: { kind: 'session', sessionId: 'helm1' },
  })
  service.host.providers = async () => [
    {
      driverKind: 'codex',
      available: true,
      models: [{ id: 'gpt', label: 'GPT' }],
      defaultModelId: 'gpt',
    },
  ]
  service.host.projectAgentDefaults = () => ({ permissionMode: 'ask' })
  await store.append('helm1', {
    type: 'session.updated',
    driverKind: 'codex',
    modelId: 'gpt',
    permissionMode: 'ask',
  })
  const next = await service.invoke('helm1', 'projects.ask', {
    ...ask,
    driverKind: 'codex',
    modelId: 'gpt',
    idempotencyKey: 'stale-next',
  })
  expect(next).toMatchObject({ ok: true, result: { reused: false, lead: { driverKind: 'codex' } } })
  const replacement = (next as { result: { sessionId: string } }).result.sessionId
  expect(replacement).not.toBe(id)
  expect((await store.load(id)).session).toMatchObject({ id, archived: false, status: 'idle' })
  expect(
    await service.invoke('helm1', 'projects.ask', {
      ...ask,
      driverKind: 'claude',
      modelId: 'ignored',
      permissionMode: 'full',
      idempotencyKey: 'stale-reuse',
    }),
  ).toMatchObject({
    ok: true,
    result: {
      sessionId: replacement,
      reused: true,
      lead: { driverKind: 'codex', modelId: 'gpt', permissionMode: 'ask' },
    },
  })
})

it('refuses steering higher-permission sessions outside Aria launches while keeping reads and stop open', async () => {
  await store.append('web1', { type: 'session.updated', permissionMode: 'full' })
  await startTurn('web1', 'Fix it', { kind: 'session', sessionId: 'helm1' })
  await store.append('web1', {
    type: 'input.requested',
    inputId: 'q',
    prompt: 'Which?',
    choicesJson: null,
  })
  const targetSessionId = 'web1'
  for (const [method, params] of [
    ['session.prompt', { text: 'Do it', idempotencyKey: 'ceiling-prompt' }],
    ['session.message', { text: 'Do it', idempotencyKey: 'ceiling-message' }],
    ['session.answer', { inputId: 'q', value: 'Do it', idempotencyKey: 'ceiling-answer' }],
  ] as const) {
    const result = await service.invoke('helm1', method, { targetSessionId, ...params })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('scope_denied')
      expect(result.error.message).toContain('Ask the user')
    }
  }
  for (const method of ['session.get', 'session.read', 'session.status'] as const)
    expect((await service.invoke('helm1', method, { targetSessionId })).ok).toBe(true)
  expect(
    (
      await service.invoke('helm1', 'session.wait', {
        targetSessionIds: [targetSessionId],
        timeoutMs: 1,
      })
    ).ok,
  ).toBe(true)
  expect(
    (
      await service.invoke('helm1', 'session.stop', {
        targetSessionId,
        idempotencyKey: 'ceiling-stop',
      })
    ).ok,
  ).toBe(true)
  const own = await service.invoke('helm1', 'projects.ask', {
    projectId: 'api',
    text: 'Fix it',
    idempotencyKey: 'own-lead',
  })
  const ownId = (own as { result: { sessionId: string } }).result.sessionId
  await store.append(ownId, { type: 'session.updated', permissionMode: 'full' })
  expect(
    (
      await service.invoke('helm1', 'session.prompt', {
        targetSessionId: ownId,
        text: 'Follow up',
        idempotencyKey: 'own-prompt',
      })
    ).ok,
  ).toBe(false)
})

it('lists project leads in a new Aria chat without its old spawn records', async () => {
  const first = await service.invoke('helm1', 'projects.ask', {
    projectId: 'web',
    text: 'Fix it',
    idempotencyKey: 'status-old',
  })
  const id = (first as { result: { sessionId: string } }).result.sessionId
  await store.destroy('helm1')
  await store.append('helm2', { type: 'session.created', session: { ...helm, id: 'helm2' } })
  expect(await service.invoke('helm2', 'session.status', {})).toMatchObject({
    ok: true,
    result: { tasks: [{ sessionId: id }], summary: { total: 1 } },
  })
})

it('refuses reusing, prompting, messaging or answering a lead above Aria permission', async () => {
  const first = await service.invoke('helm1', 'projects.ask', {
    projectId: 'web',
    text: 'Fix it',
    idempotencyKey: 'ceiling-lead',
  })
  const id = (first as { result: { sessionId: string } }).result.sessionId
  await store.append('helm1', { type: 'session.updated', permissionMode: 'ask' })
  await store.append(id, { type: 'session.updated', permissionMode: 'full' })
  for (const [method, params] of [
    ['projects.ask', { projectId: 'web', text: 'Follow up', idempotencyKey: 'higher-ask' }],
    ['session.prompt', { targetSessionId: id, text: 'Follow up', idempotencyKey: 'higher-prompt' }],
    [
      'session.message',
      { targetSessionId: id, text: 'Follow up', idempotencyKey: 'higher-message' },
    ],
    [
      'session.answer',
      { targetSessionId: id, inputId: 'question', value: 'Go', idempotencyKey: 'higher-answer' },
    ],
  ] as const) {
    const result = await service.invoke('helm1', method, params)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('scope_denied')
      expect(result.error.message).toContain('Ask the user')
    }
  }
  await store.append('helm1', { type: 'session.updated', permissionMode: 'full' })
  expect(
    await service.invoke('helm1', 'projects.ask', {
      projectId: 'web',
      text: 'Follow up',
      idempotencyKey: 'raised-aria',
    }),
  ).toMatchObject({ ok: true, result: { reused: true, sessionId: id } })
})

it('refuses saving a project default above Aria permission before writing it', async () => {
  const save = vi.fn<NonNullable<ControlHost['setProjectDefault']>>(async () => true)
  service.host.setProjectDefault = save
  await store.append('helm1', { type: 'session.updated', permissionMode: 'ask' })
  expect(
    await service.invoke('helm1', 'projects.setDefault', {
      projectId: 'web',
      driverKind: 'claude',
      permissionMode: 'full',
      idempotencyKey: 'default-high',
      modelId: 'model',
    }),
  ).toMatchObject({ ok: false, error: { code: 'scope_denied' } })
  expect(save).not.toHaveBeenCalled()
  expect(
    (
      await service.invoke('helm1', 'projects.setDefault', {
        projectId: 'web',
        driverKind: 'claude',
        permissionMode: 'ask',
        idempotencyKey: 'default-safe',
        modelId: 'model',
      })
    ).ok,
  ).toBe(true)
  expect(save).toHaveBeenCalledOnce()
})

it('replaces a lead with a removed catalog model while preserving the old lead', async () => {
  const ask = { projectId: 'web', text: 'Fix it', idempotencyKey: 'model-old' }
  const first = await service.invoke('helm1', 'projects.ask', ask)
  const id = (first as { result: { sessionId: string } }).result.sessionId
  await store.append(id, {
    type: 'message.dequeued',
    text: ask.text,
    attachments: [],
    origin: { kind: 'session', sessionId: 'helm1' },
  })
  service.host.providers = async () => [
    {
      driverKind: 'claude',
      available: true,
      models: [{ id: 'new', label: 'New' }],
      defaultModelId: 'new',
    },
  ]
  const next = await service.invoke('helm1', 'projects.ask', {
    ...ask,
    driverKind: 'claude',
    modelId: 'new',
    idempotencyKey: 'model-new',
  })
  expect(next).toMatchObject({ ok: true, result: { reused: false, lead: { modelId: 'new' } } })
  expect((next as { result: { sessionId: string } }).result.sessionId).not.toBe(id)
  expect((await store.load(id)).session).toMatchObject({
    id,
    modelId: 'model',
    status: 'idle',
    archived: false,
  })
})

it.each(['lead', 'createdBy'])(
  'loads only a candidate lead when its old listing lacks %s',
  async (field) => {
    const first = await service.invoke('helm1', 'projects.ask', {
      projectId: 'web',
      text: 'Fix it',
      idempotencyKey: 'metadata-first',
    })
    const id = (first as { result: { sessionId: string } }).result.sessionId
    const path = join(dir, id, 'index.json')
    for (const row of await store.listSessions()) await store.closeJournal(row.id)
    const index = JSON.parse(await readFile(path, 'utf8')) as { hierarchy: Record<string, unknown> }
    delete index.hierarchy[field]
    await writeFile(path, JSON.stringify(index))
    store = new SessionStore({ rootDir: dir })
    service.host.store = store
    const load = vi.spyOn(store, 'loadExisting')
    expect(
      await service.invoke('helm1', 'projects.ask', {
        projectId: 'web',
        text: 'Follow up',
        idempotencyKey: 'metadata-next',
      }),
    ).toMatchObject({ ok: true, result: { reused: true, sessionId: id } })
    expect(load.mock.calls.some(([target]) => target === id)).toBe(true)
    expect(load.mock.calls.some(([target]) => target === 'web1')).toBe(false)
    load.mockRestore()
  },
)

it('keeps lead tasks with the Aria that asked for the latest queued work', async () => {
  await store.append('helm2', {
    type: 'session.created',
    session: { ...helm, id: 'helm2', updatedAt: 2 },
  })
  const first = await service.invoke('helm1', 'projects.ask', {
    projectId: 'web',
    text: 'First work',
    idempotencyKey: 'topic-first',
  })
  const id = (first as { result: { sessionId: string } }).result.sessionId
  expect((await service.tasks('helm1')).map((task) => task.sessionId)).toEqual([id])
  expect(await service.tasks('helm2')).toEqual([])
  const before = (await store.load('helm1')).childEvents
  await service.invoke('helm2', 'projects.ask', {
    projectId: 'web',
    text: 'Latest work',
    idempotencyKey: 'topic-latest',
  })
  expect((await service.tasks('helm1')).map((task) => task.sessionId)).toEqual([id])
  expect((await service.tasks('helm2')).map((task) => task.sessionId)).toEqual([id])
  await service.invoke('helm1', 'session.status', {})
  expect((await store.load('helm1')).childEvents).toEqual(before)
  for (const queued of (await store.load(id)).queuedMessages)
    await store.append(id, {
      type: 'message.dequeued',
      text: queued.text,
      attachments: queued.attachments,
      origin: queued.origin,
    })
  const latest = await startTurn(id, 'Latest work', { kind: 'session', sessionId: 'helm2' })
  await reply(id, latest, 'Latest report')
  const human = await startTurn(id, 'My work')
  await reply(id, human, 'Human report')
  expect((await service.tasks('helm1')).map((task) => task.sessionId)).toEqual([id])
  expect((await service.tasks('helm2')).map((task) => task.sessionId)).toEqual([id])
})

it('discovers an orphaned lead from an old sidecar without replaying known non-leads', async () => {
  for (let i = 0; i < 8; i++)
    await store.append(`old${i}`, { type: 'session.created', session: { ...web, id: `old${i}` } })
  const first = await service.invoke('helm1', 'projects.ask', {
    projectId: 'web',
    text: 'Old work',
    idempotencyKey: 'old-task-metadata',
  })
  const id = (first as { result: { sessionId: string } }).result.sessionId
  await store.destroy('helm1')
  await store.append('helm2', { type: 'session.created', session: { ...helm, id: 'helm2' } })
  for (const row of await store.listSessions()) {
    await store.closeJournal(row.id)
    const path = join(dir, row.id, 'index.json')
    const index = JSON.parse(await readFile(path, 'utf8')) as { hierarchy: Record<string, unknown> }
    delete index.hierarchy.lead
    delete index.hierarchy.createdBy
    await writeFile(path, JSON.stringify(index))
  }
  store = new SessionStore({ rootDir: dir })
  service.host.store = store
  const load = vi.spyOn(store, 'loadExisting')
  expect((await service.tasks('helm2')).map((task) => task.sessionId)).toEqual([id])
  expect(new Set(load.mock.calls.map(([target]) => target))).toEqual(
    new Set(['helm2', id, 'helm1']),
  )
  expect((await store.listSessions()).find((row) => row.id === 'old0')).toMatchObject({
    lead: false,
    createdBy: { kind: 'human' },
  })
  expect(await store.exists('helm1')).toBe(false)
  load.mockRestore()
})

it('adopts an orphaned lead only in the current Aria without recreating its requester folder', async () => {
  const first = await service.invoke('helm1', 'projects.ask', {
    projectId: 'web',
    text: 'Old work',
    idempotencyKey: 'orphan-work',
  })
  const id = (first as { result: { sessionId: string } }).result.sessionId
  await store.append(id, {
    type: 'message.dequeued',
    text: 'Old work',
    attachments: [],
    origin: { kind: 'session', sessionId: 'helm1' },
  })
  const turn = await startTurn(id, 'Old work', { kind: 'session', sessionId: 'helm1' })
  await reply(id, turn, 'Old report')
  const human = await startTurn(id, 'Human follow-up')
  await reply(id, human, 'Human report')
  await store.destroy('helm1')
  for (const [aria, updatedAt] of [
    ['helm2', 2],
    ['helm3', 3],
  ] as const)
    await store.append(aria, { type: 'session.created', session: { ...helm, id: aria, updatedAt } })
  expect(await helmReportRecipient(store, await store.load(id), turn)).toBe('helm3')
  expect(await service.tasks('helm2')).toEqual([])
  expect((await service.tasks('helm3')).map((task) => task.sessionId)).toEqual([id])
  const before = (await store.load('helm2')).childEvents
  await service.invoke('helm2', 'session.status', {})
  expect((await store.load('helm2')).childEvents).toEqual(before)
  expect(await store.exists('helm1')).toBe(false)
})

it('reuses fetched provider data for project agent selection', async () => {
  const providers = vi.spyOn(service.host, 'providers')
  const result = await service.invoke('helm1', 'projects.ask', {
    projectId: 'web',
    text: 'Fix it',
    idempotencyKey: 'catalog-once',
  })
  expect(result.ok).toBe(true)
  // One selection catalog, plus the two launch checks around approval.
  expect(providers).toHaveBeenCalledTimes(3)
  providers.mockRestore()
})

it('uses listing rows for lead recipients without checking their journals', async () => {
  const first = await service.invoke('helm1', 'projects.ask', {
    projectId: 'web',
    text: 'Work',
    idempotencyKey: 'listing-recipient',
  })
  const id = (first as { result: { sessionId: string } }).result.sessionId
  await startTurn(id, 'Work', { kind: 'session', sessionId: 'helm1' })
  const model = await store.load(id)
  const rows = await store.listSessions()
  const exists = vi.spyOn(store, 'exists').mockRejectedValue(new Error('Unexpected existence read'))
  const load = vi
    .spyOn(store, 'loadExisting')
    .mockRejectedValue(new Error('Unexpected journal read'))
  try {
    expect(await helmTaskRecipient(store, model, rows)).toBe('helm1')
    expect(exists).not.toHaveBeenCalled()
    expect(load).not.toHaveBeenCalled()
  } finally {
    exists.mockRestore()
    load.mockRestore()
  }
})

it('routes live and orphaned lead reports with targeted lookups and no registry scan', async () => {
  const first = await service.invoke('helm1', 'projects.ask', {
    projectId: 'web',
    text: 'Work',
    idempotencyKey: 'targeted-recipient',
  })
  const id = (first as { result: { sessionId: string } }).result.sessionId
  const turn = await startTurn(id, 'Work', { kind: 'session', sessionId: 'helm1' })
  const model = await store.load(id)
  const listing = vi.spyOn(store, 'listSessions').mockRejectedValue(new Error('Unexpected listing'))
  const load = vi.spyOn(store, 'loadExisting')
  const current = vi.spyOn(store, 'currentHelmSession')
  try {
    expect(await helmReportRecipient(store, model, turn)).toBe('helm1')
    expect(load).toHaveBeenCalledWith('helm1')
    expect(current).not.toHaveBeenCalled()
    await store.destroy('helm1')
    await store.append('helm2', { type: 'session.created', session: { ...helm, id: 'helm2' } })
    expect(await helmReportRecipient(store, model, turn)).toBe('helm2')
    expect(current).toHaveBeenCalledTimes(1)
    expect(load.mock.calls.map(([id]) => id)).toEqual(['helm1', 'helm1'])
    expect(listing).not.toHaveBeenCalled()
    expect(await store.exists('helm1')).toBe(false)
  } finally {
    listing.mockRestore()
    load.mockRestore()
    current.mockRestore()
  }
})

it.each(['empty', 'archived'])(
  'discovers the current Aria once for orphaned reports with an %s startup cache',
  async (cache) => {
    const first = await service.invoke('helm1', 'projects.ask', {
      projectId: 'web',
      text: 'Work',
      idempotencyKey: 'cold-recipient',
    })
    const id = (first as { result: { sessionId: string } }).result.sessionId
    const turn = await startTurn(id, 'Work', { kind: 'session', sessionId: 'helm1' })
    const model = await store.load(id)
    await store.destroy('helm1')
    for (const [aria, updatedAt, archived] of [
      ['helm2', 2, true],
      ['helm3', 3, false],
    ] as const)
      await store.append(aria, {
        type: 'session.created',
        session: { ...helm, id: aria, updatedAt, archived },
      })
    for (const row of await store.listSessions()) await store.closeJournal(row.id)
    const cold = new SessionStore({ rootDir: dir })
    if (cache === 'archived') {
      await cold.loadExisting('helm2')
      await cold.closeJournal('helm2')
    }
    const listing = vi.spyOn(cold, 'listSessions')
    expect(await helmReportRecipient(cold, model, turn)).toBe('helm3')
    expect(await helmReportRecipient(cold, model, turn)).toBe('helm3')
    expect(listing).toHaveBeenCalledTimes(1)
    listing.mockRestore()
  },
)

it('accepts model aliases consistently when creating and reusing a lead', async () => {
  const first = await service.invoke('helm1', 'projects.ask', {
    projectId: 'web',
    text: 'Work',
    idempotencyKey: 'alias-old',
  })
  const id = (first as { result: { sessionId: string } }).result.sessionId
  service.host.providers = async () => [
    {
      driverKind: 'claude',
      available: true,
      models: [{ id: 'renamed', label: 'Renamed', aliases: ['model'] }],
      defaultModelId: 'renamed',
    },
  ]
  expect(
    await service.invoke('helm1', 'projects.ask', {
      projectId: 'web',
      text: 'Follow up',
      idempotencyKey: 'alias-reuse',
    }),
  ).toMatchObject({ ok: true, result: { reused: true, sessionId: id } })
  expect(
    await service.invoke('helm1', 'session.spawn', {
      ...launch,
      projectId: 'api',
      modelId: 'model',
      idempotencyKey: 'alias-launch',
    }),
  ).toMatchObject({ ok: true, result: { child: { modelId: 'renamed' } } })
})

it('resolves all snapshot project agents from one listing and provider catalog without journal reads', async () => {
  const listing = vi.spyOn(store, 'listSessions')
  const providers = vi.spyOn(service.host, 'providers')
  const load = vi.spyOn(store, 'load')
  const projectList = vi.fn<NonNullable<ControlHost['projects']>>(async (rows) => {
    expect(rows).toBeDefined()
    return projects
  })
  service.host.projects = projectList
  const resolved = await service.projects(helm)
  expect(resolved.find((project) => project.projectId === 'web')?.agent).toMatchObject({
    driverKind: 'claude',
    modelId: 'model',
    source: 'project',
  })
  expect(listing).toHaveBeenCalledOnce()
  expect(providers).toHaveBeenCalledOnce()
  expect(load).not.toHaveBeenCalled()
  const rows = await store.listSessions()
  listing.mockClear()
  await service.projects(helm, rows)
  expect(projectList).toHaveBeenLastCalledWith(rows)
  expect(listing).not.toHaveBeenCalled()
  vi.restoreAllMocks()
})

it('counts leads waiting on workers against the project concurrency cap', async () => {
  service.host.policy = () =>
    delegationSettingsSchema.parse({ approvalMode: 'never', maxConcurrentChildren: 1 })
  const first = await service.invoke('helm1', 'projects.ask', {
    projectId: 'web',
    text: 'Fix login',
    idempotencyKey: 'lead-cap-a',
  })
  const id = (first as { result: { sessionId: string } }).result.sessionId
  await store.append(id, { type: 'message.dequeued', text: 'Fix login', attachments: [] })
  const turn = await startTurn(id, 'Fix login', { kind: 'session', sessionId: 'helm1' })
  await reply(id, turn, 'Workers are still running.')
  await store.append('worker', {
    type: 'session.created',
    session: {
      ...base,
      id: 'worker',
      title: 'Worker',
      projectId: 'web',
      parentSessionId: id,
      rootSessionId: id,
    },
  })
  await startTurn('worker', 'Implement it', { kind: 'session', sessionId: id })
  const denied = await service.invoke('helm1', 'projects.ask', {
    projectId: 'api',
    text: 'Fix API',
    idempotencyKey: 'lead-cap-b',
  })
  expect(denied).toMatchObject({ ok: false, error: { code: 'delegation_limit' } })
  expect(
    (
      await service.invoke('helm1', 'projects.ask', {
        projectId: 'web',
        text: 'Include logout',
        idempotencyKey: 'lead-cap-c',
      })
    ).ok,
  ).toBe(true)
})

it('shows the resolved project agent and its source compactly in the snapshot', async () => {
  const resolved = (
    (await service.invoke('helm1', 'projects.list', {})) as { result: { projects: HelmProject[] } }
  ).result.projects
  const view: HelmView = {
    rows: await store.listSessions(),
    load: (id) => store.load(id),
    projectName: () => null,
  }
  const text = await helmSnapshot(view, await store.load('helm1'), resolved)
  expect(text).toContain('Web (web, claude/model, project setting)')
})

it('formats routing clues on one project line and marks the last viewed project', async () => {
  const view: HelmView = {
    rows: [],
    load: (id) => store.load(id),
    projectName: () => null,
  }
  const text = await helmSnapshot(view, await store.load('helm1'), [
    {
      ...projects[1]!,
      description: 'A shop\nfor gardeners.',
      repository: 'team/garden',
      recentSessionTitles: ['Fix checkout\nredirect', 'Stock alerts'],
      lastViewed: true,
    },
    projects[3]!,
  ])
  expect(text).toContain(
    '- Web (web) — A shop for gardeners.; repo: team/garden; recent: "Fix checkout redirect" / "Stock alerts"',
  )
  expect(text).toContain('\n- Gone (gone, folder missing)\n')
  expect(text).toContain('You were last in Web (web).')
  expect(text).not.toContain('repo: null')
})

it('caps projects, descriptions and recent titles, with open projects first', async () => {
  const view: HelmView = { rows: [], load: (id) => store.load(id), projectName: () => null }
  const many = Array.from({ length: 20 }, (_, index) => ({
    projectId: `p${index}`,
    name: `Project ${index}`,
    available: true,
    open: index >= 10,
    lastOpenedAt: index,
    description: 'd'.repeat(200),
    recentSessionTitles: ['a'.repeat(200), 'Second', 'Third', 'Fourth'],
  }))
  const text = await helmSnapshot(view, await store.load('helm1'), [
    { projectId: 'helm', name: 'Aria', available: true, open: true, lastViewed: true },
    ...many,
  ])
  const lines = text.split('\n').filter((line) => line.startsWith('- Project'))
  expect(lines).toHaveLength(15)
  expect(lines[0]).toContain('Project 19')
  expect(lines[9]).toContain('Project 10')
  expect(lines[10]).toContain('Project 9')
  expect(text).toContain('5 more; use ari projects to list all.')
  expect(text).toContain(`${'d'.repeat(99)}…`)
  expect(text).not.toContain('d'.repeat(100))
  expect(text).toContain(`${'a'.repeat(79)}…`)
  expect(text).not.toContain('Fourth')
  expect(text).not.toContain('You were last in Aria')
  expect(text).not.toContain('- Aria')
})

it('keeps the empty-project snapshot actionable', async () => {
  const text = await helmSnapshot(
    { rows: [], load: (id) => store.load(id), projectName: () => null },
    await store.load('helm1'),
    [projects[0]!],
  )
  expect(text).toContain(
    'Projects: none yet. Use `ari project create` when the user asks to build something new.',
  )
  expect(text).not.toContain('Ask the user to add a project folder')
  expect(text).not.toContain('You were last in')
})

it('lists who started a session, so the sidebar can mark what Aria began', async () => {
  const spawned = await service.invoke('helm1', 'session.spawn', launch)
  const id = (spawned as { result: { child: Session } }).result.child.id
  const row = (await store.listSessions()).find((entry) => entry.id === id)
  expect(row?.createdBy).toEqual({ kind: 'session', sessionId: 'helm1' })
  expect((await store.listSessions()).find((entry) => entry.id === 'web1')?.createdBy).toEqual({
    kind: 'human',
  })
})

it('uses the saved project model rather than Aria current model or recent project sessions', async () => {
  await store.append('helm1', {
    type: 'session.updated',
    driverKind: 'codex',
    modelId: 'gpt',
    effort: 'high',
  })
  const result = await service.invoke('helm1', 'session.spawn', {
    ...launch,
    driverKind: undefined,
    idempotencyKey: 'saved-agent',
  })
  expect(result).toMatchObject({
    ok: true,
    result: {
      child: {
        driverKind: 'claude',
        modelId: 'model',
        effort: null,
        permissionMode: 'allow-edits',
      },
      agent: { source: 'project', driverKind: 'claude', modelId: 'model' },
    },
  })
})

it('switches a running project lead without approval or interruption and carries its history', async () => {
  const first = await service.invoke('helm1', 'projects.ask', {
    projectId: 'web',
    text: 'Fix login',
    idempotencyKey: 'lead-first',
  })
  const id = (first as { result: { sessionId: string } }).result.sessionId
  const turnId = await startTurn(id, 'Fix login', { kind: 'session', sessionId: 'helm1' })
  await store.append(id, {
    type: 'assistant.parts.appended',
    messageId: 'lead-reply',
    parts: [{ type: 'text', text: 'Working on login.' }],
  })
  service.host.providers = async () => [
    {
      driverKind: 'codex',
      available: true,
      models: [{ id: 'gpt', label: 'GPT', aliases: ['latest'] }],
      defaultModelId: 'gpt',
    },
  ]
  service.host.policy = () => delegationSettingsSchema.parse({ approvalMode: 'always' })
  const approve = vi.spyOn(service.host, 'approve')
  const switched = await service.invoke('helm1', 'projects.lead', {
    projectId: 'web',
    driverKind: 'codex',
    modelId: 'latest',
    effort: 'high',
    idempotencyKey: 'lead-switch',
  })
  expect(switched).toMatchObject({
    ok: true,
    result: {
      switched: true,
      sessionId: id,
      lead: { driverKind: 'codex', modelId: 'gpt', effort: 'high', permissionMode: 'allow-edits' },
      agent: { source: 'arguments', modelId: 'gpt' },
    },
  })
  const model = await store.load(id)
  expect(model.activeTurnId).toBe(turnId)
  expect(model.providerHandoffPending).toBe(true)
  expect(providerTurnContext(model).handoff).toContain('Lead: Working on login.')
  expect(approve).not.toHaveBeenCalled()
  expect(
    await service.invoke('helm1', 'projects.lead', {
      projectId: 'web',
      driverKind: 'codex',
      modelId: 'latest',
      effort: 'high',
      idempotencyKey: 'lead-switch',
    }),
  ).toEqual(switched)
  approve.mockRestore()
})

it('can switch a broken lead and rejects unavailable choices without changing it', async () => {
  const first = await service.invoke('helm1', 'projects.ask', {
    projectId: 'web',
    text: 'Fix login',
    idempotencyKey: 'broken-first',
  })
  const id = (first as { result: { sessionId: string } }).result.sessionId
  await store.append(id, { type: 'session.updated', modelId: 'broken' })
  for (const choice of [
    { driverKind: 'codex', modelId: 'gpt', code: 'provider_unavailable' },
    { driverKind: 'claude', modelId: 'missing', code: 'model_unavailable' },
  ]) {
    expect(
      await service.invoke('helm1', 'projects.lead', {
        projectId: 'web',
        driverKind: choice.driverKind,
        modelId: choice.modelId,
        idempotencyKey: choice.code,
      }),
    ).toMatchObject({ ok: false, error: { code: choice.code } })
    expect((await store.load(id)).session?.modelId).toBe('broken')
  }
  expect(
    await service.invoke('helm1', 'projects.lead', {
      projectId: 'web',
      driverKind: 'claude',
      modelId: 'model',
      idempotencyKey: 'recover-model',
    }),
  ).toMatchObject({ ok: true, result: { sessionId: id, lead: { modelId: 'model' } } })
})

it('resets the current lead and its workers through the destroy path, then creates a fresh lead', async () => {
  const first = await service.invoke('helm1', 'projects.ask', {
    projectId: 'web',
    text: 'Fix login',
    idempotencyKey: 'reset-first',
  })
  const id = (first as { result: { sessionId: string } }).result.sessionId
  await store.append('lead-worker', {
    type: 'session.created',
    session: {
      ...web,
      id: 'lead-worker',
      parentSessionId: id,
      rootSessionId: id,
      createdBy: { kind: 'session', sessionId: id },
      workspace: {
        kind: 'managed-worktree',
        path: dir,
        branch: 'ari/worker',
        baseRef: 'main',
        baseCommit: 'a'.repeat(40),
      },
    },
  })
  await startTurn('lead-worker', 'Work on login')
  const revoke = vi.fn<NonNullable<ControlHost['revoke']>>(async () => undefined)
  service.host.revoke = revoke
  const release = vi.spyOn(service.host, 'release')
  service.host.policy = () => delegationSettingsSchema.parse({ approvalMode: 'always' })
  const approve = vi.spyOn(service.host, 'approve')
  const reset = { projectId: 'web', reset: true, idempotencyKey: 'lead-reset' }
  expect(await service.invoke('helm1', 'projects.lead', reset)).toMatchObject({
    ok: true,
    result: { projectId: 'web', sessionId: id, destroyed: true, count: 2 },
  })
  expect(await store.exists(id)).toBe(false)
  expect(await store.exists('lead-worker')).toBe(false)
  expect(release.mock.calls.map(([session]) => session.id)).toEqual(['lead-worker', id])
  expect(revoke.mock.calls.map(([sessionId]) => sessionId)).toEqual(['lead-worker', id])
  expect(approve).not.toHaveBeenCalled()
  expect((await service.invoke('helm1', 'projects.lead', reset)).ok).toBe(true)
  service.host.policy = () => delegationSettingsSchema.parse({ approvalMode: 'never' })
  const next = await service.invoke('helm1', 'projects.ask', {
    projectId: 'web',
    text: 'Try again',
    idempotencyKey: 'reset-next',
  })
  expect(next).toMatchObject({ ok: true, result: { reused: false } })
  expect((next as { result: { sessionId: string } }).result.sessionId).not.toBe(id)
  release.mockRestore()
  approve.mockRestore()
})

it('lets a new Aria topic destroy its project lead, while refusing unrelated sessions', async () => {
  const first = await service.invoke('helm1', 'projects.ask', {
    projectId: 'web',
    text: 'Fix login',
    idempotencyKey: 'destroy-first',
  })
  const id = (first as { result: { sessionId: string } }).result.sessionId
  await store.append('helm2', { type: 'session.created', session: { ...helm, id: 'helm2' } })
  expect(
    await service.invoke('helm2', 'session.destroy', {
      targetSessionId: id,
      idempotencyKey: 'destroy-lead',
    }),
  ).toMatchObject({ ok: true, result: { sessionId: id, destroyed: true } })
  expect(
    await service.invoke('helm2', 'session.destroy', {
      targetSessionId: 'web1',
      idempotencyKey: 'destroy-unrelated',
    }),
  ).toMatchObject({ ok: false, error: { code: 'scope_denied' } })
})

it('limits lead mutations to Aria and preserves the permission cap when switching', async () => {
  const first = await service.invoke('helm1', 'projects.ask', {
    projectId: 'web',
    text: 'Fix login',
    idempotencyKey: 'switch-permissions',
  })
  const id = (first as { result: { sessionId: string } }).result.sessionId
  for (const choice of [{ reset: true }, { driverKind: 'claude', modelId: 'model' }]) {
    expect(
      await service.invoke('web1', 'projects.lead', {
        projectId: 'web',
        ...choice,
        idempotencyKey: JSON.stringify(choice),
      }),
    ).toMatchObject({ ok: false, error: { code: 'scope_denied' } })
  }
  await store.append(id, { type: 'session.updated', permissionMode: 'full' })
  expect(
    await service.invoke('helm1', 'projects.lead', {
      projectId: 'web',
      driverKind: 'claude',
      modelId: 'model',
      idempotencyKey: 'switch-higher',
    }),
  ).toMatchObject({ ok: false, error: { code: 'scope_denied' } })
  expect((await store.load(id)).session?.permissionMode).toBe('full')
  expect(
    await service.invoke('helm1', 'projects.lead', {
      projectId: 'api',
      reset: true,
      idempotencyKey: 'reset-user',
    }),
  ).toMatchObject({ ok: false, error: { code: 'session_not_found' } })
  expect(await store.exists('api1')).toBe(true)
  expect(
    await service.invoke('helm1', 'projects.lead', {
      projectId: 'web',
      reset: true,
      driverKind: 'claude',
      idempotencyKey: 'mixed',
    }),
  ).toMatchObject({ ok: false, error: { code: 'invalid_request' } })
})

it('requires a model choice for direct sessions and leads, then reuses the saved project default', async () => {
  projects.push({ projectId: 'fresh', name: 'Fresh', path: dir, available: true })
  for (const request of [
    {
      method: 'session.spawn' as const,
      params: {
        projectId: 'fresh',
        title: 'Work',
        prompt: 'Build it',
        idempotencyKey: 'model-direct',
      },
    },
    {
      method: 'projects.ask' as const,
      params: { projectId: 'fresh', text: 'Build it', idempotencyKey: 'model-lead' },
    },
  ]) {
    const result = await service.invoke('helm1', request.method, request.params)
    expect(result).toMatchObject({ ok: false, error: { code: 'model_unavailable' } })
    expect(result.ok ? '' : result.error.message).toContain('Ask the user once')
    expect(result.ok ? '' : result.error.message).toContain(
      'suggesting your current model as an option',
    )
    expect(result.ok ? '' : result.error.message).toContain('ari project default')
  }
  expect((await store.listSessions()).filter((row) => row.projectId === 'fresh')).toHaveLength(0)
  service.host.setProjectDefault = async (id, agent) => {
    const project = projects.find((project) => project.projectId === id)
    if (!project) return false
    project.defaultAgent = agent
    return true
  }
  expect(
    await service.invoke('helm1', 'projects.setDefault', {
      projectId: 'fresh',
      driverKind: 'claude',
      modelId: 'model',
      effort: 'high',
      idempotencyKey: 'chosen',
    }),
  ).toMatchObject({ ok: true })
  const first = await service.invoke('helm1', 'session.spawn', {
    projectId: 'fresh',
    title: 'First task',
    idempotencyKey: 'configured-first',
  })
  expect(first).toMatchObject({
    ok: true,
    result: { child: { modelId: 'model', effort: 'high' }, agent: { source: 'project' } },
  })
  expect(
    await service.invoke('helm1', 'session.spawn', {
      projectId: 'fresh',
      title: 'Second task',
      idempotencyKey: 'configured-next',
    }),
  ).toMatchObject({
    ok: true,
    result: { child: { modelId: 'model', effort: 'high' }, agent: { source: 'project' } },
  })
})

it('serializes Aria topics into one working code session per project and allows follow-ups', async () => {
  await store.append('helm2', { type: 'session.created', session: { ...helm, id: 'helm2' } })
  const results = await Promise.all([
    service.invoke('helm1', 'session.spawn', { ...launch, idempotencyKey: 'code-one' }),
    service.invoke('helm2', 'session.spawn', { ...launch, idempotencyKey: 'code-two' }),
  ])
  expect(results.filter((result) => result.ok)).toHaveLength(1)
  const accepted = results.find((result) => result.ok) as { result: { child: Session } }
  const id = accepted.result.child.id
  const refused = results.find((result) => !result.ok)!
  expect(refused).toMatchObject({ ok: false, error: { code: 'delegation_limit' } })
  expect(refused.ok ? '' : refused.error.message).toContain(`ari session prompt ${id}`)
  expect(refused.ok ? '' : refused.error.message).toContain('wait for it to finish')
  expect(
    await service.invoke('helm2', 'session.prompt', {
      targetSessionId: id,
      text: 'Also cover logout',
      idempotencyKey: 'code-followup',
    }),
  ).toMatchObject({ ok: true, result: { sessionId: id } })
  expect((await store.load(id)).queuedMessages).toHaveLength(2)
  expect(
    await service.invoke('helm2', 'projects.ask', {
      projectId: 'web',
      text: 'Set up a lead',
      idempotencyKey: 'concurrent-lead',
    }),
  ).toMatchObject({ ok: false, error: { code: 'delegation_limit' } })
  await startTurn(id, 'Continue working', { kind: 'session', sessionId: 'helm1' })
  await store.append(id, { type: 'session.updated', archived: true })
  expect(
    await service.invoke('helm2', 'session.spawn', { ...launch, idempotencyKey: 'archived-code' }),
  ).toMatchObject({ ok: false, error: { code: 'delegation_limit' } })
})

it.each(['code-first', 'research-first'] as const)(
  'allows explicit read-only research beside code (%s), including after reload',
  async (order) => {
    const code = { ...launch, idempotencyKey: 'parallel-code' }
    const research = {
      ...launch,
      readOnly: true as const,
      role: 'research',
      title: 'Review login',
      idempotencyKey: 'parallel-research',
    }
    const first = await service.invoke(
      'helm1',
      'session.spawn',
      order === 'code-first' ? code : research,
    )
    const second = await service.invoke(
      'helm1',
      'session.spawn',
      order === 'code-first' ? research : code,
    )
    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    const researchId = ((order === 'code-first' ? second : first) as { result: { child: Session } })
      .result.child.id
    expect((await store.load(researchId)).session?.readOnly).toBe(true)
    for (const row of await store.listSessions()) await store.closeJournal(row.id)
    store = new SessionStore({ rootDir: dir })
    service.host.store = store
    expect((await store.load(researchId)).session?.readOnly).toBe(true)
    expect(
      await service.invoke('helm1', 'session.spawn', {
        ...launch,
        role: 'research',
        idempotencyKey: 'no-readonly-flag',
      }),
    ).toMatchObject({ ok: false, error: { code: 'delegation_limit' } })
  },
)

it('holds the code slot while a direct session waits for workers and refuses restarting another session', async () => {
  const idle = await service.invoke('helm1', 'session.spawn', {
    ...launch,
    prompt: undefined,
    idempotencyKey: 'old-idle',
  })
  const idleId = (idle as { result: { child: Session } }).result.child.id
  const active = await service.invoke('helm1', 'session.spawn', {
    ...launch,
    prompt: undefined,
    idempotencyKey: 'waiting-root',
  })
  const id = (active as { result: { child: Session } }).result.child.id
  await store.append('worker', {
    type: 'session.created',
    session: {
      ...web,
      id: 'worker',
      parentSessionId: id,
      rootSessionId: id,
      createdBy: { kind: 'session', sessionId: id },
    },
  })
  await startTurn('worker', 'Fix login')
  expect(
    await service.invoke('helm1', 'session.spawn', {
      ...launch,
      idempotencyKey: 'waiting-blocked',
    }),
  ).toMatchObject({ ok: false, error: { code: 'delegation_limit' } })
  expect(
    await service.invoke('helm1', 'session.prompt', {
      targetSessionId: idleId,
      text: 'Start old work',
      idempotencyKey: 'restart-blocked',
    }),
  ).toMatchObject({ ok: false, error: { code: 'delegation_limit' } })
  expect(
    await service.invoke('helm1', 'session.prompt', {
      targetSessionId: id,
      text: 'Follow up',
      idempotencyKey: 'waiting-followup',
    }),
  ).toMatchObject({ ok: true })
})

it('lets Aria switch and destroy its direct sessions, while refusing user sessions and workers', async () => {
  const launched = await service.invoke('helm1', 'session.spawn', launch)
  const id = (launched as { result: { child: Session } }).result.child.id
  const turn = await startTurn(id, 'Fix login', { kind: 'session', sessionId: 'helm1' })
  await store.append(id, {
    type: 'assistant.parts.appended',
    messageId: 'direct-reply',
    parts: [{ type: 'text', text: 'Working.' }],
  })
  service.host.providers = async () => [
    {
      driverKind: 'codex',
      available: true,
      models: [{ id: 'gpt', label: 'GPT' }],
      defaultModelId: 'gpt',
    },
  ]
  service.host.policy = () => delegationSettingsSchema.parse({ approvalMode: 'always' })
  const approve = vi.spyOn(service.host, 'approve')
  expect(
    await service.invoke('helm1', 'session.switch', {
      targetSessionId: id,
      driverKind: 'codex',
      modelId: 'gpt',
      effort: 'high',
      idempotencyKey: 'switch-direct',
    }),
  ).toMatchObject({
    ok: true,
    result: {
      sessionId: id,
      switched: true,
      session: { modelId: 'gpt', effort: 'high', permissionMode: 'allow-edits' },
    },
  })
  const model = await store.load(id)
  expect(model.activeTurnId).toBe(turn)
  expect(providerTurnContext(model).handoff).toContain('Agent: Working.')
  for (const targetSessionId of ['web1', 'api2'])
    expect(
      await service.invoke('helm1', 'session.switch', {
        targetSessionId,
        driverKind: 'codex',
        modelId: 'gpt',
        idempotencyKey: `deny-${targetSessionId}`,
      }),
    ).toMatchObject({ ok: false, error: { code: 'scope_denied' } })
  expect(
    await service.invoke('web1', 'session.switch', {
      targetSessionId: id,
      driverKind: 'codex',
      modelId: 'gpt',
      idempotencyKey: 'deny-caller',
    }),
  ).toMatchObject({ ok: false, error: { code: 'scope_denied' } })
  await store.append(id, { type: 'session.updated', permissionMode: 'full' })
  expect(
    await service.invoke('helm1', 'session.switch', {
      targetSessionId: id,
      driverKind: 'codex',
      modelId: 'gpt',
      idempotencyKey: 'deny-permission',
    }),
  ).toMatchObject({ ok: false, error: { code: 'scope_denied' } })
  expect(
    await service.invoke('helm1', 'session.destroy', {
      targetSessionId: id,
      idempotencyKey: 'destroy-direct-higher',
    }),
  ).toMatchObject({ ok: false, error: { code: 'scope_denied' } })
  expect(await store.exists(id)).toBe(true)
  await store.append(id, { type: 'session.updated', permissionMode: 'allow-edits' })
  expect(
    await service.invoke('helm1', 'session.destroy', {
      targetSessionId: id,
      idempotencyKey: 'destroy-direct',
    }),
  ).toMatchObject({ ok: true, result: { destroyed: true, sessionId: id } })
  expect(await store.exists(id)).toBe(false)
  expect(approve).not.toHaveBeenCalled()
  approve.mockRestore()
})

it('keeps direct sessions reachable and counted when the Aria topic that launched them is deleted', async () => {
  const first = await service.invoke('helm1', 'session.spawn', launch)
  const id = (first as { result: { child: Session } }).result.child.id
  const turn = await startTurn(id, 'Fix login', { kind: 'session', sessionId: 'helm1' })
  const model = await store.load(id)
  await store.destroy('helm1')
  await store.append('helm2', { type: 'session.created', session: { ...helm, id: 'helm2' } })
  expect(await helmReportRecipient(store, model, turn)).toBe('helm2')
  expect((await service.tasks('helm2')).map((task) => task.sessionId)).toContain(id)
  expect(
    await service.invoke('helm2', 'session.spawn', { ...launch, idempotencyKey: 'orphan-code' }),
  ).toMatchObject({ ok: false, error: { code: 'delegation_limit' } })
  expect(
    await service.invoke('helm2', 'session.switch', {
      targetSessionId: id,
      driverKind: 'claude',
      modelId: 'model',
      idempotencyKey: 'orphan-switch',
    }),
  ).toMatchObject({ ok: true })
  expect(
    await service.invoke('helm2', 'session.destroy', {
      targetSessionId: id,
      idempotencyKey: 'orphan-destroy',
    }),
  ).toMatchObject({ ok: true })
})

it('forbids read-only sessions from spawning or integrating while leaving inspection open', async () => {
  const root = await service.invoke('helm1', 'session.spawn', {
    ...launch,
    readOnly: true,
    idempotencyKey: 'research-root',
  })
  const id = (root as { result: { child: Session } }).result.child.id
  const isolate = vi.spyOn(service.host, 'isolate')
  expect(
    await service.invoke(id, 'session.spawn', {
      title: 'Inspect tests',
      driverKind: 'claude',
      modelId: 'model',
      idempotencyKey: 'research-worker',
    }),
  ).toMatchObject({
    ok: false,
    error: { code: 'scope_denied', message: 'Read-only sessions cannot spawn children.' },
  })
  expect(isolate).not.toHaveBeenCalled()
  await store.append('old-research-worker', {
    type: 'session.created',
    session: { ...web, id: 'old-research-worker', parentSessionId: id, rootSessionId: id },
  })
  const integrate = vi.spyOn(service.host, 'integrate')
  expect(
    await service.invoke(id, 'session.integrate', {
      targetSessionId: 'old-research-worker',
      snapshotCommit: 'a'.repeat(40),
      idempotencyKey: 'read-only-integrate',
    }),
  ).toMatchObject({
    ok: false,
    error: { code: 'scope_denied', message: 'Read-only sessions cannot integrate changes.' },
  })
  expect(integrate).not.toHaveBeenCalled()
  expect(
    await service.invoke(id, 'session.diff', { targetSessionId: 'old-research-worker' }),
  ).toMatchObject({ ok: true })
  isolate.mockRestore()
  integrate.mockRestore()
})

it('runs read-only project sessions with ask permissions and accepts follow-ups beside code work', async () => {
  await store.append('helm1', { type: 'session.updated', permissionMode: 'full' })
  projects[1]!.defaultAgent!.permissionMode = 'full'
  const code = await service.invoke('helm1', 'session.spawn', launch)
  expect(code.ok).toBe(true)
  const research = await service.invoke('helm1', 'session.spawn', {
    ...launch,
    readOnly: true,
    permissionMode: 'full',
    idempotencyKey: 'readonly-permissions',
  })
  expect(research).toMatchObject({
    ok: true,
    result: {
      child: { readOnly: true, permissionMode: 'ask' },
      agent: { permissionMode: 'ask' },
    },
  })
  const id = (research as { result: { child: Session } }).result.child.id
  expect(
    await service.invoke('helm1', 'session.prompt', {
      targetSessionId: id,
      text: 'Inspect more tests',
      idempotencyKey: 'readonly-followup',
    }),
  ).toMatchObject({ ok: true })
  expect(
    await service.invoke('helm1', 'session.switch', {
      targetSessionId: id,
      driverKind: 'claude',
      modelId: 'model',
      idempotencyKey: 'readonly-switch',
    }),
  ).toMatchObject({ ok: true, result: { session: { permissionMode: 'ask' } } })
  service.host.policy = () =>
    delegationSettingsSchema.parse({ approvalMode: 'never', allowSharedWorkspace: true })
  expect(
    await service.invoke('web1', 'session.spawn', {
      title: 'Read-only child',
      driverKind: 'claude',
      modelId: 'model',
      readOnly: true,
      permissionMode: 'allow-edits',
      workspaceMode: 'shared',
      idempotencyKey: 'readonly-child',
    }),
  ).toMatchObject({ ok: true, result: { child: { readOnly: true, permissionMode: 'ask' } } })
})

it('reports a model-less saved default in launches, project listings and Aria snapshots', async () => {
  projects[1]!.defaultAgent!.modelId = null
  for (const request of [
    {
      method: 'session.spawn' as const,
      params: { ...launch, idempotencyKey: 'missing-default-direct' },
    },
    {
      method: 'projects.ask' as const,
      params: { projectId: 'web', text: 'Fix login', idempotencyKey: 'missing-default-lead' },
    },
  ]) {
    const result = await service.invoke('helm1', request.method, request.params)
    expect(result).toMatchObject({ ok: false, error: { code: 'model_unavailable' } })
    expect(result.ok ? '' : result.error.message).toContain('saved default is missing a model')
    expect(result.ok ? '' : result.error.message).toContain('Ask the user')
  }
  const listed = await service.projects(helm)
  const missingProject = listed.find((project) => project.projectId === 'web')
  expect(missingProject?.agent).toBeNull()
  expect(missingProject?.agentError).toContain('missing a model')
  const snapshot = await helmSnapshot(
    { rows: await store.listSessions(), load: (id) => store.load(id), projectName: () => null },
    await store.load('helm1'),
    listed,
  )
  expect(snapshot).toContain('saved default is missing a model; ask the user')
  expect(
    await service.invoke('helm1', 'session.spawn', {
      ...launch,
      modelId: 'model',
      idempotencyKey: 'chosen-explicit-model',
    }),
  ).toMatchObject({ ok: true })
})

it('requires models when saving defaults or switching sessions and leads without catalog guesses', async () => {
  const first = await service.invoke('helm1', 'projects.ask', {
    projectId: 'web',
    text: 'Fix login',
    idempotencyKey: 'switch-model-required',
  })
  const id = (first as { result: { sessionId: string } }).result.sessionId
  const save = vi.fn<NonNullable<ControlHost['setProjectDefault']>>(async () => true)
  service.host.setProjectDefault = save
  for (const modelId of [undefined, null])
    for (const request of [
      { method: 'projects.setDefault' as const, params: { projectId: 'web' } },
      { method: 'projects.lead' as const, params: { projectId: 'web' } },
      { method: 'session.switch' as const, params: { targetSessionId: id } },
    ]) {
      const result = await service.invoke('helm1', request.method, {
        ...request.params,
        driverKind: 'claude',
        modelId,
        idempotencyKey: `${request.method}-${modelId}`,
      })
      expect(result).toMatchObject({
        ok: false,
        error: { code: 'invalid_request' },
      })
      expect(result.ok ? '' : result.error.message).toContain('requires --model')
      expect(result.ok ? '' : result.error.message).toContain('Ask the user')
    }
  expect(save).not.toHaveBeenCalled()
  expect((await store.load(id)).providerContextSeq).toBeUndefined()
  expect((await store.load(id)).session?.modelId).toBe('model')
})

it.each(['destroy', 'reset'] as const)(
  'refuses %s above Aria permissions or from archived Aria before any cleanup',
  async (method) => {
    const first = await service.invoke('helm1', 'projects.ask', {
      projectId: 'web',
      text: 'Fix login',
      idempotencyKey: 'ceiling-first',
    })
    const id = (first as { result: { sessionId: string } }).result.sessionId
    const release = vi.spyOn(service.host, 'release')
    await store.append(id, { type: 'session.updated', permissionMode: 'full' })
    const request = (key: string) =>
      method === 'destroy'
        ? service.invoke('helm1', 'session.destroy', { targetSessionId: id, idempotencyKey: key })
        : service.invoke('helm1', 'projects.lead', {
            projectId: 'web',
            reset: true,
            idempotencyKey: key,
          })
    const ceiling = await request('ceiling-refused')
    expect(ceiling).toMatchObject({
      ok: false,
      error: { code: 'scope_denied' },
    })
    expect(ceiling.ok ? '' : ceiling.error.message).toContain('higher permissions than Aria')
    await store.append(id, { type: 'session.updated', permissionMode: 'ask' })
    await store.append('helm1', { type: 'session.updated', archived: true })
    const archived = await request('archived-refused')
    expect(archived).toMatchObject({
      ok: false,
      error: { code: 'scope_denied' },
    })
    expect(archived.ok ? '' : archived.error.message).toContain('Restore Aria')
    expect(await store.exists(id)).toBe(true)
    expect(release).not.toHaveBeenCalled()
    release.mockRestore()
  },
)

it.each(['project', 'managed-worktree'] as const)(
  'counts human code work only when it shares the project folder (%s)',
  async (kind) => {
    await store.append('human-code', {
      type: 'session.created',
      session: {
        ...web,
        id: 'human-code',
        title: 'Human login task',
        workspace:
          kind === 'project'
            ? { kind }
            : { kind, path: dir, branch: 'ari/human', baseRef: 'main', baseCommit: 'a'.repeat(40) },
      },
    })
    await startTurn('human-code', 'Fix login')
    const result = await service.invoke('helm1', 'session.spawn', launch)
    if (kind === 'project') {
      expect(result).toMatchObject({
        ok: false,
        error: { code: 'delegation_limit' },
      })
      expect(result.ok ? '' : result.error.message).toContain('Human login task')
      expect(result.ok ? '' : result.error.message).toContain('human-code')
      expect(
        await service.invoke('helm1', 'session.spawn', {
          ...launch,
          readOnly: true,
          idempotencyKey: 'parallel-human-research',
        }),
      ).toMatchObject({ ok: true })
      expect(
        await service.invoke('helm1', 'session.prompt', {
          targetSessionId: 'human-code',
          text: 'Also inspect logout',
          idempotencyKey: 'human-code-followup',
        }),
      ).toMatchObject({ ok: true })
    } else expect(result.ok).toBe(true)
  },
)

it('switches the lead most recently assigned work by Aria and resets all project leads and workers', async () => {
  for (const [id, createdAt, askedAt, archived] of [
    ['older-lead', 100, 400, false],
    ['current-lead', 200, 600, false],
    ['archived-lead', 300, 800, true],
  ] as const) {
    await store.append(id, {
      type: 'session.created',
      session: {
        ...web,
        id,
        createdAt,
        lead: true,
        archived,
        modelId: 'model',
        createdBy: { kind: 'session', sessionId: 'helm1' },
      },
    })
    await store.append(id, {
      type: 'message.enqueued',
      text: 'Lead assignment',
      held: true,
      attachments: [],
      origin: { kind: 'session', sessionId: 'helm1' },
      at: askedAt,
    })
    await store.append(`${id}-worker`, {
      type: 'session.created',
      session: { ...web, id: `${id}-worker`, parentSessionId: id, rootSessionId: id },
    })
  }
  // More recent provider output, user work and title changes are not Aria assignments.
  const humanTurn = await startTurn('older-lead', 'Explain this code')
  await reply('older-lead', humanTurn, 'Explanation')
  await store.append('older-lead', { type: 'session.updated', title: 'Recently renamed', at: 1000 })
  await store.append('user-lead', {
    type: 'session.created',
    session: { ...web, id: 'user-lead', lead: true },
  })
  expect(
    await service.invoke('helm1', 'projects.lead', {
      projectId: 'web',
      driverKind: 'claude',
      modelId: 'model',
      effort: 'high',
      idempotencyKey: 'switch-current',
    }),
  ).toMatchObject({ ok: true, result: { sessionId: 'current-lead', lead: { effort: 'high' } } })
  expect((await store.load('older-lead')).session?.effort).toBeUndefined()
  await store.append('older-lead', { type: 'session.updated', permissionMode: 'full' })
  expect(
    await service.invoke('helm1', 'projects.lead', {
      projectId: 'web',
      reset: true,
      idempotencyKey: 'reset-all-ceiling',
    }),
  ).toMatchObject({ ok: false, error: { code: 'scope_denied' } })
  expect(await store.exists('current-lead')).toBe(true)
  await store.append('older-lead', { type: 'session.updated', permissionMode: 'ask' })
  const release = vi.spyOn(service.host, 'release')
  expect(
    await service.invoke('helm1', 'projects.lead', {
      projectId: 'web',
      reset: true,
      idempotencyKey: 'reset-all',
    }),
  ).toMatchObject({
    ok: true,
    result: {
      count: 6,
      destroyed: true,
      sessionIds: ['archived-lead', 'current-lead', 'older-lead'],
    },
  })
  expect(release.mock.calls.map(([session]) => session.id)).toHaveLength(6)
  expect(await store.exists('user-lead')).toBe(true)
  expect(await store.exists('api1')).toBe(true)
  const next = await service.invoke('helm1', 'projects.ask', {
    projectId: 'web',
    text: 'Start fresh',
    idempotencyKey: 'reset-all-next',
  })
  expect(next).toMatchObject({ ok: true, result: { reused: false } })
  release.mockRestore()
})
