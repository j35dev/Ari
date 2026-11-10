import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi, type Mock } from 'vitest'
import { delegationSettingsSchema, type HelmProject } from '@ari/contracts/agent-control'
import type { Session } from '@ari/contracts/session'
import { AgentControlService, type ControlHost } from './agent-control'
import { ProjectStore } from './projects'
import { SessionStore } from './session-store'
import { decideCommand } from './dispatcher'
import { helmSnapshot } from './helm'

let dir: string
let store: SessionStore
let projects: ProjectStore
let projectId: string
let host: ControlHost
let service: AgentControlService
type Catalog = {
  driverKind: string
  available: boolean
  defaultModelId?: string
  models: { id: string; label: string; aliases?: string[]; efforts?: { id: string }[] }[]
}[]
let catalog: Catalog
let create: Mock<ControlHost['create']>
let dispatch: Mock<ControlHost['dispatch']>
let registryBefore: string
let seq: number
const caller: Session = {
  id: 'aria',
  projectId: 'helm',
  title: 'Aria',
  driverKind: 'codex',
  modelId: 'caller',
  permissionMode: 'allow-edits',
  status: 'idle',
  createdAt: 1,
  updatedAt: 1,
}
const saved = {
  driverKind: 'codex' as const,
  modelId: 'saved-alias',
  effort: 'xhigh',
  permissionMode: 'full' as const,
}
const available: Catalog = [
  {
    driverKind: 'codex',
    available: true,
    defaultModelId: 'other',
    models: [
      { id: 'saved-model', label: 'Saved', aliases: ['saved-alias'], efforts: [{ id: 'xhigh' }] },
      { id: 'other', label: 'Other', efforts: [{ id: 'low' }] },
    ],
  },
]

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ari-availability-'))
  const folder = join(dir, 'workspace')
  await mkdir(folder)
  projects = new ProjectStore({ dir })
  const project = await projects.open(folder, 'Chosen project')
  projectId = project.id
  await projects.setDefaultAgent(projectId, saved)
  registryBefore = await readFile(join(dir, 'projects.json'), 'utf8')
  store = new SessionStore({ rootDir: join(dir, 'sessions') })
  await store.append(caller.id, { type: 'session.created', session: caller })
  seq = 0
  catalog = available
  create = vi.fn<ControlHost['create']>(async (session) => {
    await store.append(session.id, { type: 'session.created', session })
  })
  dispatch = vi.fn<ControlHost['dispatch']>(async (command, origin) => {
    if (!('sessionId' in command)) return { accepted: false }
    const decision = decideCommand(
      await store.load(command.sessionId),
      command,
      { turnId: `t${++seq}`, messageId: `m${seq}` },
      origin,
    )
    for (const event of decision.events) await store.append(command.sessionId, event)
    return decision
  })
  host = {
    store,
    version: 'test',
    policy: () => delegationSettingsSchema.parse({ approvalMode: 'never' }),
    providers: async () => catalog,
    projects: async (): Promise<HelmProject[]> =>
      projects.list().map((p) => ({
        projectId: p.id,
        name: p.name,
        path: p.path,
        available: p.status === 'ok',
        defaultAgent: p.defaultAgent,
      })),
    projectAgentDefaults: () => ({ permissionMode: 'ask' }),
    create,
    dispatch,
    record: (id, event) => store.append(id, event),
    subscribe: (listener) => store.subscribe(listener),
    workspace: async () => folder,
    isRunning: () => false,
    isolate: async () => {
      throw new Error('No isolated workspace in this fixture')
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
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

async function reload(): Promise<void> {
  for (const row of await store.listSessions()) await store.closeJournal(row.id)
  store = new SessionStore({ rootDir: join(dir, 'sessions') })
  projects = new ProjectStore({ dir })
  await projects.load()
  host.store = store
  service = new AgentControlService(host)
}

async function listProjects(): Promise<HelmProject[]> {
  const listed = await service.invoke(caller.id, 'projects.list', {})
  expect(listed.ok).toBe(true)
  if (!listed.ok) throw new Error(listed.error.message)
  return (listed.result as { projects: HelmProject[] }).projects
}

async function snapshot(rows: HelmProject[]): Promise<string> {
  return helmSnapshot(
    {
      rows: await store.listSessions(),
      load: (id) => store.load(id),
      projectName: () => 'Chosen project',
    },
    await store.load(caller.id),
    rows,
  )
}

const conditions = [
  { label: 'provider absent', code: 'provider_unavailable', providers: [] },
  {
    label: 'provider unavailable with cached models',
    code: 'provider_unavailable',
    providers: available.map((p) => ({ ...p, available: false })),
  },
  {
    label: 'provider unavailable with empty discovery',
    code: 'provider_unavailable',
    providers: available.map((p) => ({ ...p, available: false, models: [] })),
  },
  {
    label: 'saved model absent',
    code: 'model_unavailable',
    providers: available.map((p) => ({ ...p, models: p.models.filter((m) => m.id === 'other') })),
  },
  {
    label: 'available provider with empty catalog',
    code: 'model_unavailable',
    providers: available.map((p) => ({ ...p, models: [] })),
  },
]

it.each(conditions)(
  'reports $label consistently and retries the original saved choice after reload/recovery',
  async ({ code, providers }) => {
    catalog = providers
    const rows = await listProjects()
    expect(rows[0]?.defaultAgent).toEqual(saved)
    expect(rows[0]?.agent).toBeNull()
    expect(rows[0]?.agentError).toContain('Saved project agent codex/saved-alias')
    expect(await snapshot(rows)).toContain(rows[0]!.agentError!)
    expect(await snapshot(rows)).not.toContain('missing a model')
    const params = {
      projectId,
      title: 'Resume saved work',
      prompt: 'Continue',
      idempotencyKey: 'resume',
    }
    const refused = await service.invoke(caller.id, 'session.spawn', params)
    expect(refused).toMatchObject({ ok: false, error: { code, message: rows[0]!.agentError } })
    expect(create).not.toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
    expect(await readFile(join(dir, 'projects.json'), 'utf8')).toBe(registryBefore)
    await reload()
    catalog = available
    const recovered = await service.invoke(caller.id, 'session.spawn', params)
    expect(recovered).toMatchObject({
      ok: true,
      result: {
        child: {
          driverKind: 'codex',
          modelId: 'saved-model',
          effort: 'xhigh',
          permissionMode: 'allow-edits',
        },
      },
    })
    expect(create).toHaveBeenCalledTimes(1)
    expect(dispatch).toHaveBeenCalledTimes(1)
    const id = (recovered as { result: { child: Session } }).result.child.id
    expect((await store.load(id)).queuedMessages).toMatchObject([
      { text: 'Continue', held: true, origin: { kind: 'session', sessionId: caller.id } },
    ])
    expect(await service.invoke(caller.id, 'session.spawn', params)).toEqual(recovered)
    expect(create).toHaveBeenCalledTimes(1)
    expect((await listProjects())[0]?.agentError).toBeUndefined()
    expect(projects.get(projectId)?.defaultAgent).toEqual(saved)
    expect(await readFile(join(dir, 'projects.json'), 'utf8')).toBe(registryBefore)
  },
)

it.each(['provider_unavailable', 'model_unavailable'] as const)(
  'project ask reports the same saved %s reason without starting a lead',
  async (code) => {
    catalog = code === 'provider_unavailable' ? [] : available.map((p) => ({ ...p, models: [] }))
    const rows = await listProjects()
    expect(
      await service.invoke(caller.id, 'projects.ask', {
        projectId,
        text: 'Continue',
        idempotencyKey: 'ask',
      }),
    ).toMatchObject({ ok: false, error: { code, message: rows[0]!.agentError } })
    expect(create).not.toHaveBeenCalled()
    expect(await readFile(join(dir, 'projects.json'), 'utf8')).toBe(registryBefore)
    await reload()
    catalog = available
    expect(
      await service.invoke(caller.id, 'projects.ask', {
        projectId,
        text: 'Continue',
        idempotencyKey: 'ask',
      }),
    ).toMatchObject({
      ok: true,
      result: {
        lead: {
          lead: true,
          modelId: 'saved-model',
          effort: 'xhigh',
          permissionMode: 'allow-edits',
        },
      },
    })
    expect(create).toHaveBeenCalledTimes(1)
    expect(dispatch).toHaveBeenCalledTimes(1)
  },
)

it('accepts explicit provider/model overrides without replacing the unavailable saved choice', async () => {
  catalog = [
    { driverKind: 'claude', available: true, models: [{ id: 'override', label: 'Override' }] },
  ]
  expect(
    await service.invoke(caller.id, 'session.spawn', {
      projectId,
      title: 'Override',
      prompt: 'Continue',
      driverKind: 'claude',
      modelId: 'override',
      permissionMode: 'ask',
      idempotencyKey: 'override',
    }),
  ).toMatchObject({
    ok: true,
    result: {
      child: { driverKind: 'claude', modelId: 'override', effort: null, permissionMode: 'ask' },
    },
  })
  expect(projects.get(projectId)?.defaultAgent).toEqual(saved)
  expect(await readFile(join(dir, 'projects.json'), 'utf8')).toBe(registryBefore)
})

it('allows a partial explicit model override and retains the permission ceiling', async () => {
  catalog = available.map((p) => ({ ...p, models: p.models.filter((m) => m.id === 'other') }))
  const params = {
    projectId,
    title: 'Override',
    prompt: 'Continue',
    modelId: 'other',
    effort: 'low',
    idempotencyKey: 'model-override',
  }
  expect(
    await service.invoke(caller.id, 'session.spawn', { ...params, permissionMode: 'full' }),
  ).toMatchObject({ ok: false, error: { code: 'scope_denied' } })
  expect(create).not.toHaveBeenCalled()
  expect(
    await service.invoke(caller.id, 'session.spawn', { ...params, idempotencyKey: 'within-cap' }),
  ).toMatchObject({
    ok: true,
    result: {
      child: {
        driverKind: 'codex',
        modelId: 'other',
        effort: 'low',
        permissionMode: 'allow-edits',
      },
    },
  })
  expect(projects.get(projectId)?.defaultAgent).toEqual(saved)
  expect(await readFile(join(dir, 'projects.json'), 'utf8')).toBe(registryBefore)
})

it.each([null, { ...saved, modelId: null }])(
  'retains the ordinary missing-choice guidance and never guesses a catalog default',
  async (defaultAgent) => {
    await projects.setDefaultAgent(projectId, defaultAgent)
    const before = await readFile(join(dir, 'projects.json'), 'utf8')
    const rows = await listProjects()
    expect(rows[0]?.agent).toBeNull()
    expect(rows[0]?.agentError).toContain('Ask the user')
    expect(
      await service.invoke(caller.id, 'session.spawn', {
        projectId,
        title: 'Missing choice',
        prompt: 'Continue',
        idempotencyKey: 'missing',
      }),
    ).toMatchObject({
      ok: false,
      error: { code: 'model_unavailable', message: rows[0]!.agentError },
    })
    expect(create).not.toHaveBeenCalled()
    expect(await readFile(join(dir, 'projects.json'), 'utf8')).toBe(before)
  },
)
