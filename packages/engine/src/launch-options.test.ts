import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { delegationSettingsSchema, type HelmProject } from '@ari/contracts/agent-control'
import { HELM_PROJECT_ID } from '@ari/contracts/helm'
import type { ProjectAgent } from '@ari/contracts/project'
import { AgentControlService, type ControlHost } from './agent-control'
import { SessionStore } from './session-store'
import { decideCommand } from './dispatcher'

let dir: string
let store: SessionStore
let host: ControlHost
let service: AgentControlService
let project: HelmProject
let seq: number
let saveDefault: ReturnType<typeof vi.fn<(id: string, agent: ProjectAgent) => Promise<boolean>>>
let isolateWorkspace: ReturnType<typeof vi.fn<ControlHost['isolate']>>
const base = {
  title: 'Session',
  driverKind: 'codex',
  modelId: 'sol',
  permissionMode: 'full',
  status: 'idle',
  createdAt: 1,
  updatedAt: 1,
} as const
const levels = ['low', 'medium', 'high', 'xhigh'].map((id) => ({ id }))
const launch = {
  projectId: 'project',
  title: 'Implement search',
  driverKind: 'codex',
  modelId: 'sol',
  prompt: 'Implement search with regression coverage',
  idempotencyKey: 'launch',
}
const ask = {
  projectId: 'project',
  text: launch.prompt,
  driverKind: 'codex',
  modelId: 'sol',
  idempotencyKey: 'ask',
}

beforeEach(async () => {
  seq = 0
  dir = await mkdtemp(join(tmpdir(), 'ari-launch-options-'))
  store = new SessionStore({ rootDir: dir })
  await store.append('aria', {
    type: 'session.created',
    session: { ...base, id: 'aria', projectId: HELM_PROJECT_ID },
  })
  project = { projectId: 'project', name: 'Project', path: dir, available: true }
  saveDefault = vi.fn(async (_id: string, agent: ProjectAgent) => {
    project.defaultAgent = agent
    return true
  })
  isolateWorkspace = vi.fn(async () => ({ kind: 'project' as const }))
  host = {
    store,
    version: 'test',
    policy: () =>
      delegationSettingsSchema.parse({ approvalMode: 'never', allowSharedWorkspace: true }),
    providers: async () => [
      {
        driverKind: 'codex',
        available: true,
        models: [
          { id: 'sol', aliases: ['latest'], label: 'Sol', efforts: levels },
          { id: 'small', label: 'Small', efforts: [{ id: 'low' }, { id: 'high' }] },
        ],
      },
      {
        driverKind: 'claude',
        available: true,
        models: [{ id: 'opus', label: 'Opus', efforts: [{ id: 'low' }, { id: 'high' }] }],
      },
      {
        driverKind: 'hermes',
        available: true,
        models: [{ id: 'plain', label: 'Plain', efforts: [] }],
      },
    ],
    projectAgentDefaults: () => ({ permissionMode: 'ask' }),
    projects: async () => [project],
    setProjectDefault: saveDefault,
    create: async (session) => {
      await store.append(session.id, { type: 'session.created', session })
    },
    dispatch: async (command, origin) => {
      if (!('sessionId' in command)) return { accepted: false }
      const decision = decideCommand(
        await store.load(command.sessionId),
        command,
        { turnId: `turn${++seq}`, messageId: `msg${seq}` },
        origin,
      )
      for (const event of decision.events) await store.append(command.sessionId, event)
      return decision
    },
    record: (id, event) => store.append(id, event),
    subscribe: (listener) => store.subscribe(listener),
    workspace: async () => dir,
    isolate: isolateWorkspace,
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

it.each(['session.spawn', 'projects.ask'] as const)(
  'defaults %s to full and task-selected high despite app ask defaults',
  async (method) => {
    const result = await service.invoke('aria', method, method === 'session.spawn' ? launch : ask)
    expect(result).toMatchObject({
      ok: true,
      result: {
        agent: {
          modelId: 'sol',
          effort: 'high',
          permissionMode: 'full',
          effortSelection: {
            resolved: 'high',
            source: 'task',
            supported: ['low', 'medium', 'high', 'xhigh'],
          },
        },
      },
    })
  },
)

it.each(['ask', 'allow-edits'] as const)(
  'caps both launch paths to %s without elevation',
  async (permissionMode) => {
    await store.append('aria', { type: 'session.updated', permissionMode })
    expect(
      await service.invoke('aria', 'session.spawn', { ...launch, prompt: undefined }),
    ).toMatchObject({ ok: true, result: { child: { permissionMode } } })
    expect(await service.invoke('aria', 'projects.ask', ask)).toMatchObject({
      ok: true,
      result: { lead: { permissionMode } },
    })
    expect(
      await service.invoke('aria', 'session.spawn', {
        ...launch,
        permissionMode: 'full',
        idempotencyKey: 'elevate',
      }),
    ).toMatchObject({ ok: false, error: { code: 'scope_denied' } })
  },
)

it('honors explicit lower permission and effort while upgrading a saved low baseline for complex work', async () => {
  project.defaultAgent = {
    driverKind: 'codex',
    modelId: 'sol',
    effort: 'low',
    permissionMode: 'ask',
  }
  expect(
    await service.invoke('aria', 'session.spawn', {
      ...launch,
      driverKind: undefined,
      modelId: undefined,
      prompt: 'Design an architecture migration',
    }),
  ).toMatchObject({ ok: true, result: { agent: { effort: 'xhigh', permissionMode: 'ask' } } })
  expect(
    await service.invoke('aria', 'projects.ask', {
      ...ask,
      effort: 'low',
      permissionMode: 'ask',
      text: 'Architecture migration',
    }),
  ).toMatchObject({
    ok: true,
    result: {
      agent: { effort: 'low', permissionMode: 'ask', effortSelection: { source: 'explicit' } },
    },
  })
})

it('saves full within the cap and validates explicit model effort before writing defaults', async () => {
  const params = {
    projectId: 'project',
    driverKind: 'codex',
    modelId: 'sol',
    idempotencyKey: 'save',
  }
  expect(await service.invoke('aria', 'projects.setDefault', params)).toMatchObject({
    ok: true,
    result: { defaultAgent: { permissionMode: 'full', effort: null } },
  })
  expect(
    await service.invoke('aria', 'projects.setDefault', {
      ...params,
      effort: 'ultra',
      idempotencyKey: 'invalid',
    }),
  ).toMatchObject({ ok: false, error: { code: 'effort_unavailable' } })
  expect(saveDefault).toHaveBeenCalledTimes(1)
})

it('reuses a lead and applies requested effort, provider and permissions without losing messages or workers', async () => {
  const first = await service.invoke('aria', 'projects.ask', {
    ...ask,
    effort: 'low',
    permissionMode: 'ask',
  })
  const id = (first as { result: { sessionId: string } }).result.sessionId
  await store.append('worker', {
    type: 'session.created',
    session: {
      ...base,
      id: 'worker',
      projectId: 'project',
      parentSessionId: id,
      rootSessionId: id,
    },
  })
  const before = (await store.load(id)).messages
  const changed = await service.invoke('aria', 'projects.ask', {
    ...ask,
    driverKind: 'claude',
    modelId: 'opus',
    effort: 'high',
    permissionMode: 'full',
    idempotencyKey: 'followup',
  })
  expect(changed).toMatchObject({
    ok: true,
    result: {
      reused: true,
      sessionId: id,
      lead: { driverKind: 'claude', modelId: 'opus', effort: 'high', permissionMode: 'full' },
      agent: { effortSelection: { source: 'explicit' } },
    },
  })
  expect((await store.load(id)).messages).toEqual(expect.arrayContaining(before))
  expect((await store.load('worker')).session?.parentSessionId).toBe(id)
  expect((await store.listSessions()).filter((row) => row.lead)).toHaveLength(1)
  expect(
    await service.invoke('aria', 'projects.ask', {
      ...ask,
      driverKind: 'claude',
      modelId: 'opus',
      effort: 'xhigh',
      idempotencyKey: 'bad-followup',
    }),
  ).toMatchObject({ ok: false, error: { code: 'effort_unavailable' } })
  expect((await store.load(id)).session?.effort).toBe('high')
})

it('propagates reasoning and permission choices to workers and validates before workspace preparation', async () => {
  await store.append('lead', {
    type: 'session.created',
    session: { ...base, id: 'lead', projectId: 'project', effort: 'xhigh', lead: true },
  })
  const spawn = {
    title: 'Extract names',
    driverKind: 'codex',
    modelId: 'latest',
    workspaceMode: 'shared',
    idempotencyKey: 'worker',
  }
  expect(await service.invoke('lead', 'session.spawn', spawn)).toMatchObject({
    ok: true,
    result: { child: { effort: 'xhigh', permissionMode: 'full', modelId: 'sol' } },
  })
  expect(
    await service.invoke('lead', 'session.spawn', {
      ...spawn,
      effort: 'low',
      permissionMode: 'ask',
      idempotencyKey: 'explicit',
    }),
  ).toMatchObject({ ok: true, result: { child: { effort: 'low', permissionMode: 'ask' } } })
  expect(
    await service.invoke('lead', 'session.spawn', {
      ...spawn,
      effort: 'ultra',
      workspaceMode: 'isolated',
      idempotencyKey: 'invalid',
    }),
  ).toMatchObject({ ok: false, error: { code: 'effort_unavailable' } })
  expect(isolateWorkspace).not.toHaveBeenCalled()
})

it('reports no configurable effort and refuses explicit levels for unsupported providers', async () => {
  expect(
    await service.invoke('aria', 'session.spawn', {
      ...launch,
      driverKind: 'hermes',
      modelId: 'plain',
      prompt: undefined,
    }),
  ).toMatchObject({
    ok: true,
    result: { agent: { effort: null, effortSelection: { source: 'unsupported' } } },
  })
  expect(
    await service.invoke('aria', 'session.spawn', {
      ...launch,
      driverKind: 'hermes',
      modelId: 'plain',
      effort: 'high',
      idempotencyKey: 'unsupported',
    }),
  ).toMatchObject({ ok: false, error: { code: 'effort_unavailable' } })
})

it('rechecks the caller permission cap after worktree preparation before creating a worker', async () => {
  await store.append('lead', {
    type: 'session.created',
    session: { ...base, id: 'lead', projectId: 'project', lead: true },
  })
  host.isolate = async () => {
    await store.append('lead', { type: 'session.updated', permissionMode: 'ask' })
    return { kind: 'project' }
  }
  const released = vi.fn(async () => undefined)
  host.release = released
  const result = await service.invoke('lead', 'session.spawn', {
    title: 'Worker',
    driverKind: 'codex',
    modelId: 'sol',
    workspaceMode: 'isolated',
    idempotencyKey: 'changed-cap',
  })
  expect(result).toMatchObject({ ok: false, error: { code: 'scope_denied' } })
  expect((await store.listSessions()).filter((row) => row.parentSessionId === 'lead')).toHaveLength(
    0,
  )
  expect(released).toHaveBeenCalledOnce()
})

it('keeps explicit provider-default effort usable when model-specific discovery is unavailable', async () => {
  host.effortsForModel = async () => {
    throw new Error('offline')
  }
  expect(await service.invoke('aria', 'session.spawn', { ...launch, effort: null })).toMatchObject({
    ok: true,
    result: { agent: { effort: null, effortSelection: { source: 'provider-default' } } },
  })
})

it('rechecks Aria permissions after reasoning discovery before switching a project session', async () => {
  const first = await service.invoke('aria', 'session.spawn', {
    ...launch,
    prompt: undefined,
    effort: 'low',
  })
  const id = (first as { result: { child: { id: string } } }).result.child.id
  host.effortsForModel = async () => {
    await store.append('aria', { type: 'session.updated', permissionMode: 'ask' })
    return levels
  }
  expect(
    await service.invoke('aria', 'session.switch', {
      targetSessionId: id,
      driverKind: 'codex',
      modelId: 'sol',
      effort: 'xhigh',
      idempotencyKey: 'switch-cap',
    }),
  ).toMatchObject({ ok: false, error: { code: 'scope_denied' } })
  expect((await store.load(id)).session?.effort).toBe('low')
})

it('reassesses direct-session follow-ups and honors overrides while retaining context and permissions', async () => {
  const first = await service.invoke('aria', 'session.spawn', {
    ...launch,
    prompt: 'Extract names',
    effort: 'auto',
    permissionMode: 'ask',
  })
  const id = (first as { result: { child: { id: string } } }).result.child.id
  expect((await store.load(id)).session?.effort).toBe('low')
  const before = (await store.load(id)).messages
  expect(
    await service.invoke('aria', 'session.prompt', {
      targetSessionId: id,
      text: 'Implement a comprehensive architecture migration',
      idempotencyKey: 'large-followup',
    }),
  ).toMatchObject({
    ok: true,
    result: {
      agent: { effort: 'xhigh', permissionMode: 'ask', effortSelection: { source: 'task' } },
    },
  })
  expect((await store.load(id)).messages).toEqual(expect.arrayContaining(before))
  expect(
    await service.invoke('aria', 'session.prompt', {
      targetSessionId: id,
      text: 'Architecture migration',
      effort: 'low',
      idempotencyKey: 'low-followup',
    }),
  ).toMatchObject({
    ok: true,
    result: {
      agent: { effort: 'low', permissionMode: 'ask', effortSelection: { source: 'explicit' } },
    },
  })
  expect(
    await service.invoke('aria', 'session.prompt', {
      targetSessionId: id,
      text: 'Continue',
      effort: 'ultra',
      idempotencyKey: 'invalid-followup',
    }),
  ).toMatchObject({ ok: false, error: { code: 'effort_unavailable' } })
  expect((await store.load(id)).session?.effort).toBe('low')
})
