// @vitest-environment node
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentEvent } from '@ari/contracts/agent-event'
import type { Session } from '@ari/contracts/session'
import { DriverRegistry } from '@ari/providers/registry'
import {
  UNKNOWN_PROVIDER_CAPABILITIES,
  type AdapterApprovalDecision,
  type AdapterSession,
  type ProviderAdapter,
} from '@ari/providers/driver'
import { SessionStore } from '@ari/engine/session-store'
import { ManagedWorkspaces } from '@ari/engine/git'
import { deterministicTitleStrategy } from '@ari/engine/title'
import { Engine } from '../../engine'
import { createExternalTaskHost, ExternalTaskError } from '../../external/task-host'
import { SlackService } from './service'
import type { SlackEnvelope, SlackReply, SlackTransport } from './transport'

let directory: string, repository: string
let store: SessionStore, engine: Engine, service: SlackService
let runs: AdapterSession[], replies: SlackReply[]
let mode: 'complete' | 'approval'
let approvalAnswers: AdapterApprovalDecision[]
let release: (() => void) | null
let authorize: (() => Promise<string | null>) | null

function git(...args: string[]) {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], {
    cwd: repository,
    windowsHide: true,
    encoding: 'utf8',
  }).trim()
}
function mention(id: string, text: string, thread?: string): SlackEnvelope {
  return {
    type: 'events_api',
    envelopeId: `delivery_${id}`,
    body: {
      type: 'event_callback',
      team_id: 'TTEAM123',
      api_app_id: 'AAPP123',
      event_id: id,
      event: {
        type: 'app_mention',
        user: 'UOWNER123',
        channel: 'CROOM123',
        text: `<@UBOT123> ${text}`,
        ts: id === 'Ev1' ? '1.000001' : '2.000001',
        ...(thread ? { thread_ts: thread } : {}),
      },
    },
  }
}
const box = {
  encrypt: (text: string) => Buffer.from(text).toString('base64'),
  decrypt: (text: string) => Buffer.from(text, 'base64').toString(),
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ari-slack-native-'))
  repository = join(directory, 'project')
  await mkdir(repository)
  git('init', '-b', 'main')
  git('config', 'user.name', 'Fixture')
  git('config', 'user.email', 'fixture@localhost')
  await writeFile(join(repository, 'task.txt'), 'original\n')
  git('add', 'task.txt')
  git('commit', '-m', 'Initial fixture')
  store = new SessionStore({ storage: 'jsonl', rootDir: join(directory, 'sessions') })
  const workspaces = new ManagedWorkspaces(join(directory, 'worktrees'))
  const registry = new DriverRegistry()
  runs = []
  replies = []
  approvalAnswers = []
  release = null
  authorize = null
  mode = 'complete'
  registry.register({
    kind: 'claude',
    create: (input) => {
      runs.push(input)
      const selectedMode = mode
      const gate = new Promise<void>((done) => {
        release = done
      })
      const adapter: ProviderAdapter = {
        capabilities: () => ({
          ...UNKNOWN_PROVIDER_CAPABILITIES,
          liveResponses: 'approvals-and-input',
        }),
        async *start(): AsyncGenerator<AgentEvent> {
          if (selectedMode === 'approval') {
            yield {
              type: 'approval-requested',
              approvalId: 'provider-approval',
              toolName: 'write task.txt',
              summaryJson: '{}',
              options: [
                { optionId: 'provider-exact-once', name: 'Allow once', kind: 'allow_once' },
              ],
            }
            await gate
          }
          await writeFile(join(input.workspacePath, 'task.txt'), 'changed in isolated task\n')
          yield { type: 'text-delta', text: 'Updated task.txt in the isolated worktree.' }
          yield { type: 'done' }
        },
        respondApproval: (_id, answer) => {
          approvalAnswers.push(answer)
          release?.()
        },
        respondInput: () => undefined,
        interrupt: () => {
          release?.()
        },
        dispose: () => {
          release?.()
          return Promise.resolve()
        },
      }
      return Promise.resolve(adapter)
    },
  })
  engine = new Engine({
    store,
    registry,
    publish: () => undefined,
    resolveWorkspace: () => Promise.resolve(repository),
    titleStrategy: deterministicTitleStrategy,
    authorizeTurn: () => authorize?.() ?? Promise.resolve(null),
  })
  const project = {
    id: 'project_one',
    name: 'Fixture project',
    path: repository,
    status: 'ok' as const,
    colorIndex: 0,
    createdAt: 1,
    lastOpenedAt: 1,
    open: true,
    defaultAgent: {
      driverKind: 'claude' as const,
      modelId: 'fixture-model',
      effort: 'high',
      permissionMode: 'full' as const,
    },
  }
  const host = createExternalTaskHost({
    engine,
    store,
    projects: () => Promise.resolve([project]),
    providers: () =>
      Promise.resolve([
        {
          driverKind: 'claude',
          available: true,
          models: [{ id: 'fixture-model', efforts: [{ id: 'high' }] }],
        },
      ]),
    efforts: () => Promise.resolve([{ id: 'high' }]),
    sessionDeps: {
      loadProject: () => Promise.resolve(project),
      createSession: (session) => engine.createSession(session),
      prepareRootWorkspace: (session, workspaceMode) => {
        expect(workspaceMode).toBe('isolated')
        return workspaces.isolate(session, repository, session.id, session.title)
      },
    },
  })
  const transport: SlackTransport = {
    identity: () =>
      Promise.resolve({
        workspaceId: 'TTEAM123',
        workspaceName: 'Fixture team',
        botUserId: 'UBOT123',
        appId: 'AAPP123',
      }),
    start: (_receive, state) => {
      state('connected')
      return Promise.resolve()
    },
    post: (_channel, _thread, reply) => {
      replies.push(reply)
      return Promise.resolve(`10.${replies.length}`)
    },
    update: (_channel, timestamp) => Promise.resolve(timestamp),
    openModal: () => Promise.resolve(),
    close: () => Promise.resolve(),
  }
  service = new SlackService({
    path: join(directory, 'slack.json'),
    secrets: () => box,
    host,
    transport: () => transport,
    postIntervalMs: 0,
  })
  expect(
    (
      await service.configure({
        ownerUserId: 'UOWNER123',
        permissionMode: 'ask',
        botToken: 'xoxb-fixture',
        appToken: 'xapp-fixture',
        routes: [{ channelId: 'CROOM123', projectId: project.id }],
      })
    ).ok,
  ).toBe(true)
})

afterEach(async () => {
  release?.()
  await service.close()
  await engine.shutdown()
  for (const session of await store.listSessions()) await store.closeJournal(session.id)
  const relativeDirectory = relative(tmpdir(), directory)
  if (isAbsolute(relativeDirectory) || relativeDirectory.startsWith('..'))
    throw new Error('Unsafe fixture cleanup path')
  await rm(directory, { recursive: true, force: true, maxRetries: 6, retryDelay: 50 })
})

async function taskSession(): Promise<Session> {
  await expect.poll(async () => (await store.listSessions()).length, { timeout: 10_000 }).toBe(1)
  return (await store.load((await store.listSessions())[0]!.id)).session!
}

describe('real Ari engine and Git worktree', () => {
  it('runs one mention once, caps permissions, preserves origin, and continues the same worktree', async () => {
    await service.receive(mention('Ev1', 'Update the task file'))
    await service.flush()
    expect(
      Object.values(service.store.state.requests).map((request) => ({
        phase: request.phase,
        error: request.error,
      })),
    ).toEqual([{ phase: 'completed', error: null }])
    const session = await taskSession()
    await expect
      .poll(async () => (await store.load(session.id)).lastTurn?.stopReason, { timeout: 10_000 })
      .toBe('completed')
    await engine.quiesce(session.id)
    await service.flush()
    expect(session.workspace?.kind).toBe('managed-worktree')
    expect(session.permissionMode).toBe('ask')
    expect(
      session.workspace?.kind === 'managed-worktree'
        ? await readFile(join(session.workspace.path, 'task.txt'), 'utf8')
        : '',
    ).toBe('changed in isolated task\n')
    expect(await readFile(join(repository, 'task.txt'), 'utf8')).toBe('original\n')
    expect(git('branch', '--show-current')).toBe('main')
    expect(git('status', '--porcelain')).toBe('')
    expect(
      (await store.load(session.id)).messages.find((message) => message.role === 'user')
        ?.externalSource,
    ).toMatchObject({ platform: 'slack', senderId: 'UOWNER123', threadId: '1.000001' })
    expect(replies.some((reply) => reply.text.includes('Updated task.txt'))).toBe(true)
    await service.receive({ ...mention('Ev1', 'Update the task file'), envelopeId: 'redelivery' })
    await service.flush()
    expect(runs).toHaveLength(1)
    await service.receive(mention('Ev2', 'Verify the result', '1.000001'))
    await service.flush()
    await expect.poll(() => runs.length, { timeout: 10_000 }).toBe(2)
    await expect
      .poll(
        async () =>
          (await store.load(session.id)).messages.filter((message) => message.role === 'user')
            .length,
        { timeout: 10_000 },
      )
      .toBe(2)
    expect(runs[1]?.workspacePath).toBe(runs[0]?.workspacePath)
    expect(await store.listSessions()).toHaveLength(1)
  }, 30_000)

  it('passes the exact Slack approval through the engine to the live provider', async () => {
    mode = 'approval'
    await service.receive(mention('Ev1', 'Approve a file update'))
    await service.flush()
    expect(
      Object.values(service.store.state.requests).map((request) => ({
        phase: request.phase,
        error: request.error,
      })),
    ).toEqual([{ phase: 'completed', error: null }])
    const session = await taskSession()
    await expect
      .poll(async () => (await store.load(session.id)).pendingApprovals.length, { timeout: 10_000 })
      .toBe(1)
    await service.flush()
    const callback = Object.values(service.store.state.callbacks).find(
      (callback) => callback.kind === 'approval',
    )!
    expect(callback.value).toBe('provider-exact-once')
    await service.receive(mention('Ev2', 'Queued follow-up', '1.000001'))
    await service.flush()
    expect((await store.load(session.id)).queuedMessages).toHaveLength(1)
    mode = 'complete'
    await service.receive({
      type: 'interactive',
      envelopeId: 'approval-click',
      body: {
        type: 'block_actions',
        team: { id: 'TTEAM123' },
        user: { id: 'UOWNER123' },
        channel: { id: 'CROOM123' },
        message: { ts: '10.000001', thread_ts: '1.000001' },
        trigger_id: 'fixture-trigger',
        actions: [{ action_id: 'ari_approval', value: callback.id, action_ts: '30.000001' }],
      },
    })
    await service.flush()
    await expect
      .poll(() => approvalAnswers, { timeout: 10_000 })
      .toEqual([{ optionId: 'provider-exact-once' }])
    await expect.poll(() => runs.length, { timeout: 10_000 }).toBe(2)
    await expect
      .poll(async () => (await store.load(session.id)).activeTurnId, { timeout: 10_000 })
      .toBeNull()
    const messages = (await store.load(session.id)).messages.filter(
      (message) => message.role === 'user',
    )
    expect(messages).toHaveLength(2)
    expect(messages.every((message) => message.externalSource?.platform === 'slack')).toBe(true)
    expect(new Set(messages.map((message) => message.externalSource?.requestId)).size).toBe(2)
  }, 30_000)

  it('checks revocation again after asynchronous turn admission and before journal effects', async () => {
    const session: Session = {
      id: 'guard_session',
      projectId: 'project_one',
      title: 'Guard fixture',
      driverKind: 'claude',
      modelId: 'fixture-model',
      permissionMode: 'ask',
      status: 'idle',
      createdAt: 1,
      updatedAt: 1,
    }
    await engine.createSession(session)
    let began!: () => void, continueAdmission!: () => void
    const started = new Promise<void>((resolve) => {
      began = resolve
    })
    const gate = new Promise<void>((resolve) => {
      continueAdmission = resolve
      release = resolve
    })
    authorize = async () => {
      began()
      await gate
      return null
    }
    let revoked = false
    const result = engine.dispatch(
      { type: 'turn.start', sessionId: session.id, text: 'Should not run', attachments: [] },
      undefined,
      () => {
        if (revoked) throw new ExternalTaskError('revoked', 'The connection was revoked.')
      },
    )
    await started
    revoked = true
    continueAdmission()
    await expect(result).rejects.toThrow('revoked')
    expect((await store.load(session.id)).messages).toHaveLength(0)
    expect((await store.load(session.id)).activeTurnId).toBeNull()
    expect(runs).toHaveLength(0)
  })
})
