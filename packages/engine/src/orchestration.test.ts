import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { controlParams, delegationSettingsSchema } from '@ari/contracts/agent-control'
import type { Session } from '@ari/contracts/session'
import type {
  OrchestrationChangedFrame,
  OrchestrationTaskRecord,
} from '@ari/contracts/orchestration'
import { AgentControlService, type ControlHost } from './agent-control'
import { OrchestrationService } from './orchestration'
import { SessionStore } from './session-store'
import { decideCommand } from './dispatcher'
import { ManagedWorkspaces } from './git/managed-workspaces'
import { isSafeControlCommand } from './control-cli'

let dir: string,
  repo: string,
  store: SessionStore,
  host: ControlHost,
  control: AgentControlService,
  orchestration: OrchestrationService,
  workspaces: ManagedWorkspaces
let seq: number, submissions: number, integrationCalls: number
let live: boolean
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
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim()
const launch = (key: string, dependsOn: string[] = []) =>
  orchestration.invoke('root', 'orchestration.launch', {
    sessionId: 'root',
    title: key,
    assignment: {
      goal: `Implement ${key}`,
      role: 'implementation',
      ownedPaths: ['file.txt'],
      acceptanceCriteria: ['Check the change'],
      dependsOn,
    },
    driverKind: 'claude',
    idempotencyKey: key,
  })
const attempt = (task: OrchestrationTaskRecord) =>
  task.attempts.find((entry) => entry.attemptId === task.currentAttemptId)!
const reload = () => {
  control = new AgentControlService(host)
  orchestration = new OrchestrationService({
    host,
    control,
    liveCapabilities: () => ({ approval: live, question: live, steer: false }),
    readFile: async (_session, path, maxChars) => {
      const content = await readFile(join(repo, path), 'utf8')
      return { content: content.slice(0, maxChars), truncated: content.length > maxChars }
    },
    freezeBase: (session, key) => workspaces.snapshot(repo, `refs/ari/orchestration/${key}/base`),
  })
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ari-orchestration-'))
  repo = join(dir, 'repo')
  const { mkdir } = await import('node:fs/promises')
  await mkdir(repo)
  git(repo, 'init', '-q')
  git(repo, 'config', 'core.autocrlf', 'false')
  git(repo, 'config', 'user.name', 'Test')
  git(repo, 'config', 'user.email', 'test@example.com')
  await writeFile(join(repo, 'file.txt'), 'base\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-qm', 'base')
  store = new SessionStore({ rootDir: join(dir, 'sessions') })
  await store.append('root', { type: 'session.created', session: root })
  workspaces = new ManagedWorkspaces(join(dir, 'workers'))
  seq = 0
  submissions = 0
  integrationCalls = 0
  live = true
  host = {
    store,
    version: 'test',
    policy: () =>
      delegationSettingsSchema.parse({ approvalMode: 'never', allowSharedWorkspace: true }),
    providers: async () => [
      {
        driverKind: 'claude',
        available: true,
        models: [
          { id: 'a', label: 'A' },
          { id: 'b', label: 'B' },
        ],
      },
    ],
    create: async (session) => {
      await store.append(session.id, { type: 'session.created', session })
    },
    dispatch: async (command, origin) => {
      if (!('sessionId' in command)) return { accepted: false }
      if (command.type === 'message.enqueue') submissions++
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
    workspace: async (session) =>
      session.workspace?.kind === 'managed-worktree' ? session.workspace.path : repo,
    isolate: (parent, id, title, base) => workspaces.isolate(parent, repo, id, title, base),
    diff: (child, patch) => workspaces.diff(child, patch),
    integrate: async (parent, child, snapshot) => {
      integrationCalls++
      return workspaces.integrate(parent, repo, child, snapshot)
    },
    approve: async () => true,
    release: (child) => workspaces.release(child.id),
    isRunning: () => false,
  }
  reload()
})
afterEach(async () => {
  for (const row of await store.listSessions()) {
    await store.closeJournal(row.id)
    if (row.parentSessionId) await workspaces.release(row.id)
  }
  await rm(dir, { recursive: true, force: true })
})

async function settle(
  task: OrchestrationTaskRecord,
  text = 'Finished',
  status: 'completed' | 'error' | 'interrupted' = 'completed',
) {
  const id = attempt(task).sessionId!
  const state = await store.load(id)
  for (const message of state.queuedMessages)
    await store.append(id, {
      type: 'message.dequeued',
      text: message.text,
      attachments: [],
      ...(message.origin ? { origin: message.origin } : {}),
    })
  const turnId = `turn${++seq}`
  await store.append(id, { type: 'turn.started', turnId })
  await store.append(id, {
    type: 'user.message.added',
    message: {
      id: `u${seq}`,
      sessionId: id,
      turnId,
      role: 'user',
      parts: [{ type: 'text', text: task.assignment?.goal ?? task.title }],
      createdAt: Date.now(),
      origin: { kind: 'session', sessionId: 'root' },
    },
  })
  await store.append(id, {
    type: 'assistant.parts.appended',
    messageId: `a${seq}`,
    parts: [{ type: 'text', text }],
  })
  await store.append(id, {
    type: 'turn.settled',
    turnId,
    stopReason: status,
    errorMessage: status === 'error' ? 'Check failed' : null,
  })
  return turnId
}

it('keeps dependency waits distinct and dispatches only accepted prerequisites, rejecting cycles', async () => {
  const a = await launch('A')
  const b = await launch('B', [a.taskId])
  expect(attempt(b).sessionId).toBeNull()
  expect(submissions).toBe(1)
  const before = await orchestration.invoke('root', 'orchestration.view', { sessionId: 'root' })
  expect(before.tasks.find((task) => task.taskId === b.taskId)?.currentActivity.waitReason).toBe(
    'dependencies',
  )
  expect(before.tasks.find((task) => task.taskId === a.taskId)?.currentActivity.phase).toBe(
    'queued',
  )
  await expect(
    orchestration.invoke('root', 'orchestration.update', {
      sessionId: 'root',
      taskId: a.taskId,
      assignment: { ...a.assignment, dependsOn: [b.taskId] },
      idempotencyKey: 'cycle',
    }),
  ).rejects.toMatchObject({ code: 'dependency_cycle' })
  await settle(a)
  const view = await orchestration.invoke('root', 'orchestration.view', { sessionId: 'root' })
  const result = view.tasks.find((task) => task.taskId === a.taskId)!.results.at(-1)!
  await orchestration.invoke('root', 'orchestration.review', {
    sessionId: 'root',
    taskId: a.taskId,
    resultId: result.resultId,
    snapshotCommit: result.snapshotCommit,
    state: 'reviewing',
    idempotencyKey: 'review',
  })
  expect(submissions).toBe(1)
  await orchestration.invoke('root', 'orchestration.review', {
    sessionId: 'root',
    taskId: a.taskId,
    resultId: result.resultId,
    snapshotCommit: result.snapshotCommit,
    state: 'accepted',
    idempotencyKey: 'accept',
  })
  expect(submissions).toBe(2)
  reload()
  await orchestration.schedule('root')
  expect(submissions).toBe(2)
})

it('versions failed and corrected results, preserves claims, and integrates only exact accepted snapshots', async () => {
  const first = await launch('change')
  const id = attempt(first).sessionId!
  const child = (await store.load(id)).session!
  await writeFile(
    join(child.workspace!.kind === 'managed-worktree' ? child.workspace!.path : repo, 'file.txt'),
    'changed\n',
  )
  await orchestration.invoke(id, 'orchestration.result', {
    sessionId: 'parent',
    taskId: first.taskId,
    attemptId: first.currentAttemptId,
    summary: 'Tests fail',
    workerReportedChecks: [
      { command: 'pnpm test', cwd: 'worker', exitCode: 1, snapshotCommit: null, detail: 'Failure' },
    ],
    idempotencyKey: 'report',
  })
  await settle(first, 'Tests failed', 'error')
  let view = await orchestration.invoke('root', 'orchestration.view', { sessionId: 'root' })
  let result = view.tasks[0]!.results.at(-1)!
  expect(result.terminalStatus).toBe('failed')
  expect(result.workerReportedChecks[0]?.exitCode).toBe(1)
  expect(result.verifiedChecks).toEqual([])
  await expect(
    orchestration.invoke('root', 'orchestration.integrate', {
      sessionId: 'root',
      taskId: first.taskId,
      resultId: result.resultId,
      snapshotCommit: result.snapshotCommit,
      idempotencyKey: 'too-early',
    }),
  ).rejects.toMatchObject({ code: 'result_not_accepted' })
  const second = await orchestration.invoke('root', 'orchestration.retry', {
    sessionId: 'root',
    taskId: first.taskId,
    feedback: 'Fix tests',
    idempotencyKey: 'retry',
  })
  expect(second.attempts).toHaveLength(2)
  expect(second.currentResultId).toBeNull()
  await settle(second, 'Fixed')
  view = await orchestration.invoke('root', 'orchestration.view', { sessionId: 'root' })
  result = view.tasks[0]!.results.at(-1)!
  expect(view.tasks[0]!.results.some((entry) => entry.terminalStatus === 'failed')).toBe(true)
  await orchestration.invoke('root', 'orchestration.review', {
    sessionId: 'root',
    taskId: first.taskId,
    resultId: result.resultId,
    snapshotCommit: result.snapshotCommit,
    state: 'accepted',
    idempotencyKey: 'accept',
  })
  const params = {
    sessionId: 'root',
    taskId: first.taskId,
    resultId: result.resultId,
    snapshotCommit: result.snapshotCommit,
    idempotencyKey: 'integrate',
  }
  await orchestration.invoke('root', 'orchestration.integrate', params)
  expect(await readFile(join(repo, 'file.txt'), 'utf8')).toBe('changed\n')
  for (const row of await store.listSessions()) await store.closeJournal(row.id)
  reload()
  await orchestration.invoke('root', 'orchestration.integrate', params)
  expect(integrationCalls).toBe(1)
  expect(
    (
      await orchestration.invoke('root', 'orchestration.view', { sessionId: 'root' })
    ).tasks[0]!.results.at(-1)?.reviewState,
  ).toBe('integrated')
})

it('rejects stale snapshots without changing the parent tree', async () => {
  const task = await launch('stale')
  await settle(task)
  const view = await orchestration.invoke('root', 'orchestration.view', { sessionId: 'root' })
  const result = view.tasks[0]!.results.at(-1)!
  const child = (await store.load(attempt(task).sessionId!)).session!
  if (child.workspace?.kind !== 'managed-worktree') throw new Error('expected isolated workspace')
  await writeFile(join(child.workspace.path, 'file.txt'), 'later\n')
  await expect(
    orchestration.invoke('root', 'orchestration.review', {
      sessionId: 'root',
      taskId: task.taskId,
      resultId: result.resultId,
      snapshotCommit: result.snapshotCommit,
      state: 'accepted',
      idempotencyKey: 'accept',
    }),
  ).rejects.toMatchObject({ code: 'stale_snapshot' })
  expect(await readFile(join(repo, 'file.txt'), 'utf8')).toBe('base\n')
})

it('routes actual human approvals and direct-parent questions with exact options and rejects dead callbacks', async () => {
  const task = await launch('decision')
  const id = attempt(task).sessionId!
  await store.append(id, { type: 'turn.started', turnId: 'live' })
  await store.append(id, {
    type: 'user.message.added',
    message: {
      id: 'request',
      sessionId: id,
      turnId: 'live',
      role: 'user',
      parts: [],
      createdAt: 1,
      origin: { kind: 'session', sessionId: 'root' },
    },
  })
  await store.append(id, {
    type: 'approval.requested',
    approvalId: 'grant',
    toolName: 'Bash',
    summaryJson: '{"command":"check"}',
    options: [
      { optionId: 'prefix:exact', name: 'Allow prefix', kind: 'allow_always' },
      { optionId: 'session:exact', name: 'Allow session', kind: 'allow_always' },
    ],
  })
  await store.append(id, {
    type: 'input.requested',
    inputId: 'question',
    prompt: 'Which case?',
    choicesJson: '["A","B"]',
  })
  let view = await orchestration.invoke('root', 'orchestration.view', { sessionId: 'root' })
  expect(view.tasks[0]!.requests.map((request) => request.owner)).toEqual(['human', 'lead'])
  const answer = {
    sessionId: 'root',
    childSessionId: id,
    requestId: 'grant',
    kind: 'approval',
    value: 'prefix:exact',
    idempotencyKey: 'lead-approve',
  }
  await expect(orchestration.invoke('root', 'orchestration.answer', answer)).rejects.toMatchObject({
    code: 'scope_denied',
  })
  await expect(
    orchestration.invoke(
      'root',
      'orchestration.answer',
      { ...answer, value: 'allow_always', idempotencyKey: 'wrong-option' },
      true,
    ),
  ).rejects.toMatchObject({ code: 'invalid_request' })
  await orchestration.invoke(
    'root',
    'orchestration.answer',
    { ...answer, idempotencyKey: 'human' },
    true,
  )
  expect((await store.load(id)).pendingApprovals).toHaveLength(0)
  live = false
  view = await orchestration.invoke('root', 'orchestration.view', { sessionId: 'root' })
  expect(view.tasks[0]!.requests[0]?.actionable).toBe(false)
  await expect(
    orchestration.invoke('root', 'orchestration.answer', {
      ...answer,
      requestId: 'question',
      kind: 'question',
      value: 'A',
      idempotencyKey: 'dead',
    }),
  ).rejects.toMatchObject({ code: 'request_unavailable' })
  live = true
  await orchestration.invoke('root', 'orchestration.answer', {
    ...answer,
    requestId: 'question',
    kind: 'question',
    value: 'A',
    idempotencyKey: 'answer',
  })
  expect((await store.load(id)).pendingInputs).toHaveLength(0)
  const sibling = await launch('sibling')
  await expect(
    orchestration.invoke(attempt(sibling).sessionId!, 'orchestration.result', {
      sessionId: 'parent',
      taskId: task.taskId,
      attemptId: task.currentAttemptId,
      summary: 'Wrong worker',
      idempotencyKey: 'wrong-worker',
    }),
  ).rejects.toMatchObject({ code: 'scope_denied' })
})

it('freezes bounded explicit context, rejects provider changes on reusable sessions, and compares the same base', async () => {
  const context = await orchestration.invoke('root', 'orchestration.context', {
    sessionId: 'root',
    files: ['file.txt'],
    maxChars: 3,
    purpose: 'handoff',
    idempotencyKey: 'context',
  })
  expect(context.items).toEqual([
    { kind: 'file', sourceId: 'file.txt', content: 'bas', truncated: true },
  ])
  await writeFile(join(repo, 'file.txt'), 'new source\n')
  const task = await orchestration.invoke('root', 'orchestration.launch', {
    sessionId: 'root',
    title: 'context',
    driverKind: 'claude',
    assignment: { goal: 'Use the source' },
    contextId: context.contextId,
    idempotencyKey: 'context-worker',
  })
  expect(attempt(task).consumedContextAt).not.toBeNull()
  expect((await store.load(attempt(task).sessionId!)).queuedMessages[0]?.text).toContain('\nbas')
  await settle(task)
  await expect(
    orchestration.invoke('root', 'orchestration.retry', {
      sessionId: 'root',
      taskId: task.taskId,
      modelId: 'a',
      idempotencyKey: 'model',
    }),
  ).rejects.toMatchObject({ code: 'new_session_required' })
  const comparisons = await orchestration.invoke('root', 'orchestration.compare', {
    sessionId: 'root',
    title: 'Compare',
    assignment: { goal: 'Same brief' },
    driverKind: 'claude',
    models: [
      { driverKind: 'claude', modelId: 'a' },
      { driverKind: 'claude', modelId: 'b' },
    ],
    idempotencyKey: 'compare',
  })
  const sessions = await Promise.all(
    comparisons.map((entry) => store.load(attempt(entry).sessionId!)),
  )
  expect(sessions[0]!.session?.workspace).toMatchObject({
    kind: 'managed-worktree',
    baseCommit: comparisons[0]?.baseSnapshotCommit,
  })
  expect(sessions[1]!.session?.workspace).toMatchObject({
    kind: 'managed-worktree',
    baseCommit: comparisons[0]?.baseSnapshotCommit,
  })
})

it('durably detects a lost provider-submission outcome and never duplicates it on replay', async () => {
  const task = await launch('recover')
  const params = {
    targetSessionId: attempt(task).sessionId!,
    text: 'follow up',
    idempotencyKey: 'crash',
  }
  const originalRecord = host.record.bind(host)
  host.record = async (id, event) => {
    if (
      event.type === 'orchestration.operation.updated' &&
      event.operation.status === 'completed' &&
      event.operation.method === 'session.prompt'
    )
      throw new Error('crash after enqueue')
    return originalRecord(id, event)
  }
  const first = await control.invoke('root', 'session.prompt', params)
  expect(first.ok).toBe(false)
  const count = submissions
  host.record = originalRecord
  await store.closeJournal('root')
  reload()
  const recovered = await control.invoke('root', 'session.prompt', params)
  expect(recovered).toMatchObject({ ok: false, error: { code: 'uncertain_outcome' } })
  expect(submissions).toBe(count)
  const view = await orchestration.invoke('root', 'orchestration.view', { sessionId: 'root' })
  expect(
    view.operations.some(
      (operation) => operation.method === 'session.prompt' && operation.status === 'uncertain',
    ),
  ).toBe(true)
})

it('records uncertain integration after files changed without repeating integration', async () => {
  const task = await launch('integration-crash')
  const child = (await store.load(attempt(task).sessionId!)).session!
  if (child.workspace?.kind !== 'managed-worktree') throw new Error('expected isolated')
  await writeFile(join(child.workspace.path, 'file.txt'), 'integrated\n')
  await settle(task)
  const result = (
    await orchestration.invoke('root', 'orchestration.view', { sessionId: 'root' })
  ).tasks[0]!.results.at(-1)!
  await orchestration.invoke('root', 'orchestration.review', {
    sessionId: 'root',
    taskId: task.taskId,
    resultId: result.resultId,
    snapshotCommit: result.snapshotCommit,
    state: 'accepted',
    idempotencyKey: 'accept',
  })
  const realIntegrate = host.integrate.bind(host)
  host.integrate = async (...args) => {
    await realIntegrate(...args)
    throw new Error('crash after file effect')
  }
  const params = {
    sessionId: 'root',
    taskId: task.taskId,
    resultId: result.resultId,
    snapshotCommit: result.snapshotCommit,
    idempotencyKey: 'integrate-crash',
  }
  await expect(
    orchestration.invoke('root', 'orchestration.integrate', params),
  ).rejects.toMatchObject({ code: 'internal_error' })
  expect(await readFile(join(repo, 'file.txt'), 'utf8')).toBe('integrated\n')
  reload()
  await expect(
    orchestration.invoke('root', 'orchestration.integrate', params),
  ).rejects.toMatchObject({ code: 'uncertain_outcome' })
  expect(integrationCalls).toBe(1)
})

it('enforces subtree authority, reports native work as read only, and cancels pending dependencies on stop', async () => {
  const a = await launch('prerequisite')
  const b = await launch('waiter', [a.taskId])
  await store.append('other', {
    type: 'session.created',
    session: { ...root, id: 'other', projectId: 'other' },
  })
  await expect(
    orchestration.invoke('other', 'orchestration.view', { sessionId: 'root' }),
  ).rejects.toMatchObject({ code: 'scope_denied' })
  await store.append('root', {
    type: 'background.task.updated',
    taskId: 'native-worker',
    kind: 'subagent',
    label: 'Native',
    status: 'running',
    detail: 'Reading',
  })
  const native = (
    await orchestration.invoke('root', 'orchestration.view', { sessionId: 'root' })
  ).tasks.find((task) => task.native)
  expect(native?.capabilities).toMatchObject({ inspect: true, message: false, stop: false })
  await orchestration.invoke('root', 'orchestration.stop', {
    sessionId: 'root',
    taskId: b.taskId,
    idempotencyKey: 'stop',
  })
  expect(
    (await orchestration.invoke('root', 'orchestration.view', { sessionId: 'root' })).tasks.find(
      (task) => task.taskId === b.taskId,
    )?.currentActivity.terminalStatus,
  ).toBe('interrupted')
  expect(submissions).toBe(1)
})

it('replays completed scoped control mutations and rejects key reuse with changed input', async () => {
  const task = await launch('receipt')
  const params = {
    targetSessionId: attempt(task).sessionId!,
    text: 'one',
    idempotencyKey: 'durable',
  }
  const first = await control.invoke('root', 'session.prompt', params)
  const count = submissions
  reload()
  expect(await control.invoke('root', 'session.prompt', params)).toEqual(first)
  expect(submissions).toBe(count)
  expect(
    await control.invoke('root', 'session.prompt', { ...params, text: 'different' }),
  ).toMatchObject({ ok: false, error: { code: 'invalid_request' } })
  // The CLI entry point shares this same service, not a second scheduler.
  host.orchestration = (caller, method, value) =>
    orchestration.invoke(caller, method as Parameters<OrchestrationService['invoke']>[1], value)
  expect(await control.invoke('root', 'orchestration.view', { sessionId: 'self' })).toMatchObject({
    ok: true,
  })
})

it('does not duplicate an isolated child after a crash between session creation and spawn acknowledgement', async () => {
  const params = { title: 'Orphan', driverKind: 'claude', idempotencyKey: 'crash-spawn' }
  const operationId = `control_${createHash('sha256').update('root:session.spawn:crash-spawn').digest('hex').slice(0, 32)}`
  await store.append('root', {
    type: 'orchestration.operation.updated',
    operation: {
      operationId,
      method: 'session.spawn',
      fingerprint: JSON.stringify(controlParams['session.spawn'].parse(params)),
      status: 'started',
      startedAt: Date.now(),
      completedAt: null,
      detail: null,
    },
  })
  const workspace = await workspaces.isolate(root, repo, 'orphan', 'Orphan')
  await host.create({
    ...root,
    id: 'orphan',
    parentSessionId: 'root',
    rootSessionId: 'root',
    workspace,
  })
  await store.closeJournal('root')
  await store.closeJournal('orphan')
  reload()
  expect(await control.invoke('root', 'session.spawn', params)).toMatchObject({
    ok: false,
    error: { code: 'uncertain_outcome' },
  })
  expect((await store.listSessions()).map((entry) => entry.id).sort()).toEqual(['orphan', 'root'])
  expect(submissions).toBe(0)
  expect(
    (await orchestration.invoke('root', 'orchestration.view', { sessionId: 'root' })).tasks[0]
      ?.child?.sessionId,
  ).toBe('orphan')
})

it('uses review feedback on retry and stops a submitted task still waiting in the queue', async () => {
  const first = await launch('feedback')
  await settle(first)
  const result = (
    await orchestration.invoke('root', 'orchestration.view', { sessionId: 'root' })
  ).tasks[0]!.results.at(-1)!
  await orchestration.invoke('root', 'orchestration.review', {
    sessionId: 'root',
    taskId: first.taskId,
    resultId: result.resultId,
    snapshotCommit: result.snapshotCommit,
    state: 'changes_requested',
    feedback: 'Cover the empty case',
    idempotencyKey: 'feedback',
  })
  const retry = await orchestration.invoke('root', 'orchestration.retry', {
    sessionId: 'root',
    taskId: first.taskId,
    idempotencyKey: 'retry-feedback',
  })
  expect((await store.load(attempt(retry).sessionId!)).queuedMessages[0]?.text).toContain(
    'Cover the empty case',
  )
  await orchestration.invoke('root', 'orchestration.stop', {
    sessionId: 'root',
    taskId: first.taskId,
    idempotencyKey: 'stop-queued',
  })
  expect((await store.load(attempt(retry).sessionId!)).queuedMessages).toHaveLength(0)
  expect(
    (await orchestration.invoke('root', 'orchestration.view', { sessionId: 'root' })).tasks[0]
      ?.currentActivity.terminalStatus,
  ).toBe('interrupted')
})

it('refuses a concrete owned-path overlap between simultaneous shared writers', async () => {
  const params = {
    sessionId: 'root',
    title: 'Shared',
    driverKind: 'claude',
    workspaceMode: 'shared',
    assignment: { goal: 'Write parser', ownedPaths: ['src/parser'] },
    idempotencyKey: 'shared-a',
  }
  const first = await orchestration.invoke('root', 'orchestration.launch', params)
  await expect(
    orchestration.invoke('root', 'orchestration.launch', {
      ...params,
      idempotencyKey: 'shared-b',
      assignment: { goal: 'Change parser', ownedPaths: ['src/parser/index.ts'] },
    }),
  ).rejects.toMatchObject({ code: 'owned_path_overlap' })
  expect(submissions).toBe(1)
  const sequenced = await orchestration.invoke('root', 'orchestration.launch', {
    ...params,
    idempotencyKey: 'shared-sequenced',
    assignment: { ...params.assignment, dependsOn: [first.taskId] },
  })
  expect(attempt(sequenced).sessionId).toBeNull()
})

it('coalesces child journal bursts for ancestor families and cleans up its observer', async () => {
  await host.create({ ...root, id: 'child', parentSessionId: 'root', rootSessionId: 'root' })
  await host.create({ ...root, id: 'grandchild', parentSessionId: 'child', rootSessionId: 'root' })
  await host.create({ ...root, id: 'other', projectId: 'other' })
  const frames: OrchestrationChangedFrame[] = []
  vi.useFakeTimers()
  const unsubscribe = orchestration.subscribeChanged((frame) => frames.push(frame))
  try {
    for (let index = 0; index < 8; index++)
      await store.append('grandchild', {
        type: 'assistant.parts.appended',
        messageId: 'stream',
        parts: [{ type: 'text', text: String(index) }],
      })
    await store.append('grandchild', {
      type: 'input.requested',
      inputId: 'decision',
      prompt: 'Which?',
      choicesJson: null,
    })
    await vi.advanceTimersByTimeAsync(75)
    expect(frames.filter((frame) => frame.sessionId === 'root')).toMatchObject([
      { changedSessionIds: ['grandchild'] },
    ])
    expect(frames.map((frame) => frame.sessionId).sort()).toEqual(['child', 'grandchild', 'root'])
    unsubscribe()
    await store.append('grandchild', { type: 'input.responded', inputId: 'decision', value: 'A' })
    await vi.advanceTimersByTimeAsync(100)
    expect(frames).toHaveLength(3)
  } finally {
    unsubscribe()
    vi.useRealTimers()
  }
})

it('preserves delegation approvals for user launch and each comparison spawn, and keeps integration out of CLI auto-approval', async () => {
  host.policy = () => delegationSettingsSchema.parse({ approvalMode: 'always' })
  const approve = vi.fn(async () => false)
  host.approve = approve
  const params = {
    sessionId: 'root',
    title: 'User launch',
    assignment: { goal: 'Implement' },
    driverKind: 'claude',
    idempotencyKey: 'user-denied',
  }
  await expect(
    orchestration.invoke('root', 'orchestration.launch', params, true),
  ).rejects.toMatchObject({ code: 'delegation_approval_required' })
  expect(approve).toHaveBeenCalledTimes(1)
  expect(submissions).toBe(0)
  expect(await store.listSessions()).toHaveLength(1)
  approve.mockResolvedValue(true)
  await orchestration.invoke(
    'root',
    'orchestration.compare',
    {
      ...params,
      idempotencyKey: 'user-compare',
      models: [
        { driverKind: 'claude', modelId: 'a' },
        { driverKind: 'claude', modelId: 'b' },
      ],
    },
    true,
  )
  expect(approve).toHaveBeenCalledTimes(3)
  expect(submissions).toBe(2)
  expect(
    isSafeControlCommand(
      'ari task integrate --params \'{"taskId":"task","resultId":"result","snapshotCommit":"a"}\'',
    ),
  ).toBe(false)
})

it('allows the human to dismiss a question with empty input while preserving request ownership', async () => {
  await host.create({
    ...root,
    id: 'question-child',
    parentSessionId: 'root',
    rootSessionId: 'root',
  })
  await store.append('question-child', { type: 'turn.started', turnId: 'human-turn' })
  await store.append('question-child', {
    type: 'user.message.added',
    message: {
      id: 'human-question',
      sessionId: 'question-child',
      turnId: 'human-turn',
      role: 'user',
      parts: [{ type: 'text', text: 'User work' }],
      createdAt: 1,
      origin: { kind: 'human' },
    },
  })
  await store.append('question-child', {
    type: 'input.requested',
    inputId: 'skip',
    prompt: 'Choose?',
    choicesJson: '["A","B"]',
  })
  const params = {
    sessionId: 'root',
    childSessionId: 'question-child',
    requestId: 'skip',
    kind: 'question',
    value: '',
    idempotencyKey: 'lead-skip',
  }
  await expect(orchestration.invoke('root', 'orchestration.answer', params)).rejects.toMatchObject({
    code: 'scope_denied',
  })
  await orchestration.invoke(
    'root',
    'orchestration.answer',
    { ...params, idempotencyKey: 'human-skip' },
    true,
  )
  expect((await store.load('question-child')).pendingInputs).toHaveLength(0)
  const events = await (await store.openJournal('question-child')).readAll()
  expect(
    events.some(
      (line) =>
        line.kind === 'value' &&
        (line.value as { type: string; value?: string }).type === 'input.responded' &&
        (line.value as { value?: string }).value === '',
    ),
  ).toBe(true)
})

it('materializes dependent isolated work only after current code is integrated and records versioned summaries', async () => {
  const prerequisite = await launch('API')
  const child = (await store.load(attempt(prerequisite).sessionId!)).session!
  if (child.workspace?.kind !== 'managed-worktree') throw new Error('expected isolated')
  await writeFile(join(child.workspace.path, 'file.txt'), 'API is available\n')
  await settle(prerequisite, 'The API is ready')
  const dependent = await launch('UI', [prerequisite.taskId])
  const result = (
    await orchestration.invoke('root', 'orchestration.view', { sessionId: 'root' })
  ).tasks
    .find((entry) => entry.taskId === prerequisite.taskId)!
    .results.at(-1)!
  await orchestration.invoke('root', 'orchestration.review', {
    sessionId: 'root',
    taskId: prerequisite.taskId,
    resultId: result.resultId,
    snapshotCommit: result.snapshotCommit,
    state: 'accepted',
    idempotencyKey: 'accept-code',
  })
  await orchestration.schedule('root')
  expect(submissions).toBe(1)
  expect(await readFile(join(repo, 'file.txt'), 'utf8')).toBe('base\n')
  const before = await orchestration.invoke('root', 'orchestration.view', { sessionId: 'root' })
  expect(
    before.tasks.find((entry) => entry.taskId === dependent.taskId)?.currentActivity.detail,
  ).toContain('API')
  await orchestration.invoke('root', 'orchestration.integrate', {
    sessionId: 'root',
    taskId: prerequisite.taskId,
    resultId: result.resultId,
    snapshotCommit: result.snapshotCommit,
    idempotencyKey: 'integrate-api',
  })
  const after = await orchestration.invoke('root', 'orchestration.view', { sessionId: 'root' })
  const dispatched = after.tasks.find((entry) => entry.taskId === dependent.taskId)!
  const state = await store.load(attempt(dispatched).sessionId!)
  if (state.session?.workspace?.kind !== 'managed-worktree') throw new Error('expected isolated')
  expect(await readFile(join(state.session.workspace.path, 'file.txt'), 'utf8')).toBe(
    'API is available\n',
  )
  expect(state.queuedMessages[0]?.text).toContain(
    `result ${result.resultId}, version ${result.version}`,
  )
  expect(state.queuedMessages[0]?.text).toContain('The API is ready')
  expect(attempt(dispatched).prerequisites).toMatchObject([
    {
      taskId: prerequisite.taskId,
      resultId: result.resultId,
      snapshotCommit: result.snapshotCommit,
    },
  ])
})

it('invalidates accepted prerequisites when a newer attempt supersedes them', async () => {
  const a = await launch('previous')
  await settle(a)
  const result = (
    await orchestration.invoke('root', 'orchestration.view', { sessionId: 'root' })
  ).tasks[0]!.results.at(-1)!
  await orchestration.invoke('root', 'orchestration.review', {
    sessionId: 'root',
    taskId: a.taskId,
    resultId: result.resultId,
    snapshotCommit: result.snapshotCommit,
    state: 'accepted',
    idempotencyKey: 'accept-old',
  })
  await orchestration.invoke('root', 'orchestration.retry', {
    sessionId: 'root',
    taskId: a.taskId,
    idempotencyKey: 'new-attempt',
  })
  const b = await launch('blocked', [a.taskId])
  expect(attempt(b).sessionId).toBeNull()
  expect(submissions).toBe(2)
})

it('rejects an oversized full brief before workspace and session effects and exposes explicit retry recovery', async () => {
  const context = await orchestration.invoke('root', 'orchestration.context', {
    sessionId: 'root',
    files: ['file.txt'],
    idempotencyKey: 'source',
  })
  const isolate = vi.spyOn(host, 'isolate')
  await expect(
    orchestration.invoke('root', 'orchestration.launch', {
      sessionId: 'root',
      title: 'Oversized',
      driverKind: 'claude',
      contextId: context.contextId,
      assignment: {
        goal: 'x'.repeat(63_990),
        acceptanceCriteria: ['additional required acceptance criteria'],
      },
      idempotencyKey: 'oversized',
    }),
  ).rejects.toMatchObject({ code: 'context_too_large' })
  expect(isolate).not.toHaveBeenCalled()
  expect(await store.listSessions()).toHaveLength(1)
  expect(submissions).toBe(0)
  const task = (await orchestration.invoke('root', 'orchestration.view', { sessionId: 'root' }))
    .tasks[0]!
  expect(task.currentActivity).toMatchObject({ waitReason: 'lead_decision', decisionOwner: 'lead' })
  expect(task.currentActivity.detail).toContain('64,000')
  await orchestration
    .invoke('root', 'orchestration.update', {
      sessionId: 'root',
      taskId: task.taskId,
      assignment: { goal: 'Small replacement brief' },
      idempotencyKey: 'shorten',
    })
    .catch(() => undefined)
  const retried = await orchestration.invoke('root', 'orchestration.retry', {
    sessionId: 'root',
    taskId: task.taskId,
    idempotencyKey: 'recover-brief',
  })
  expect(attempt(retried).sessionId).not.toBeNull()
  expect(submissions).toBe(1)
})

it('retains a result and an actionable workspace failure when snapshot capture is unavailable', async () => {
  const task = await launch('missing-workspace')
  await settle(task)
  host.diff = async () => {
    throw new Error('worktree missing')
  }
  const view = await orchestration.invoke('root', 'orchestration.view', { sessionId: 'root' })
  expect(view.tasks[0]?.results.at(-1)).toMatchObject({
    snapshotUnavailable: true,
    summary: 'Finished',
  })
  expect(view.tasks[0]?.results.at(-1)?.unresolvedIssues[0]).toContain('Restore')
})

it('rejects a maximum-size context plus its brief before creating a workspace or session', async () => {
  await writeFile(join(repo, 'file.txt'), 'c'.repeat(64_000))
  const context = await orchestration.invoke('root', 'orchestration.context', {
    sessionId: 'root',
    files: ['file.txt'],
    maxChars: 64_000,
    idempotencyKey: 'large-context',
  })
  expect(context.chars).toBe(64_000)
  const isolate = vi.spyOn(host, 'isolate')
  await expect(
    orchestration.invoke('root', 'orchestration.launch', {
      sessionId: 'root',
      title: 'Bounded context',
      driverKind: 'claude',
      contextId: context.contextId,
      assignment: { goal: 'Small assignment' },
      idempotencyKey: 'full-context-brief',
    }),
  ).rejects.toMatchObject({ code: 'context_too_large' })
  expect(isolate).not.toHaveBeenCalled()
  expect(await store.listSessions()).toHaveLength(1)
  expect(submissions).toBe(0)
})

it('preserves a created worker after a lost spawn acknowledgement and does not repeat its effects', async () => {
  const record = host.record.bind(host)
  host.record = async (id, event) => {
    if (event.type === 'child.session.spawned') throw new Error('crash after session creation')
    return record(id, event)
  }
  const params = {
    title: 'Preserved orphan',
    driverKind: 'claude',
    idempotencyKey: 'lost-spawn-record',
  }
  expect(await control.invoke('root', 'session.spawn', params)).toMatchObject({
    ok: false,
    error: { code: 'internal_error' },
  })
  const rows = await store.listSessions()
  expect(rows).toHaveLength(2)
  const child = rows.find((row) => row.id !== 'root')!
  const workspace = (await store.load(child.id)).session!.workspace!
  if (workspace.kind !== 'managed-worktree') throw new Error('expected worktree')
  expect(await readFile(join(workspace.path, 'file.txt'), 'utf8')).toBe('base\n')
  host.record = record
  reload()
  expect(await control.invoke('root', 'session.spawn', params)).toMatchObject({
    ok: false,
    error: { code: 'uncertain_outcome' },
  })
  expect(await store.listSessions()).toHaveLength(2)
  expect(submissions).toBe(0)
})

it('records a crash after workspace preparation without repeating or deleting the uncertain workspace', async () => {
  const isolate = host.isolate.bind(host)
  let orphanId = ''
  host.isolate = async (...args) => {
    orphanId = args[1]
    await isolate(...args)
    throw new Error('crash after worktree creation')
  }
  const params = {
    title: 'Workspace orphan',
    driverKind: 'claude',
    idempotencyKey: 'lost-workspace',
  }
  expect(await control.invoke('root', 'session.spawn', params)).toMatchObject({ ok: false })
  host.isolate = isolate
  reload()
  expect(await control.invoke('root', 'session.spawn', params)).toMatchObject({
    ok: false,
    error: { code: 'uncertain_outcome' },
  })
  expect(await store.listSessions()).toHaveLength(1)
  // Explicit cleanup belongs to this temporary-repository test, not production recovery.
  await workspaces.release(orphanId)
})

it('preserves a prepared worktree when its progress journal fails before session creation', async () => {
  const record = host.record.bind(host)
  let orphanId = ''
  const isolate = host.isolate.bind(host)
  let orphanPath = ''
  host.isolate = async (...args) => {
    orphanId = args[1]
    const workspace = await isolate(...args)
    if (workspace.kind !== 'managed-worktree') throw new Error('Expected isolated workspace')
    orphanPath = workspace.path
    return workspace
  }
  const release = vi.spyOn(host, 'release')
  host.record = async (id, event) => {
    if (
      event.type === 'orchestration.operation.updated' &&
      event.operation.method === 'session.spawn' &&
      (event.operation.result as { recovery?: { stage: string } })?.recovery?.stage ===
        'workspace_prepared'
    )
      throw new Error('Lost prepared-workspace receipt')
    return record(id, event)
  }
  const params = {
    title: 'Prepared workspace',
    driverKind: 'claude',
    idempotencyKey: 'lost-prepared-receipt',
  }
  expect(await control.invoke('root', 'session.spawn', params)).toMatchObject({ ok: false })
  expect(release).not.toHaveBeenCalled()
  expect(await readFile(join(orphanPath, 'file.txt'), 'utf8')).toBe('base\n')
  host.record = record
  reload()
  expect(await control.invoke('root', 'session.spawn', params)).toMatchObject({
    ok: false,
    error: { code: 'uncertain_outcome' },
  })
  expect(await store.listSessions()).toHaveLength(1)
  await workspaces.release(orphanId)
})

it('exposes bounded family inbox previews without consuming messages or leaking another task', async () => {
  const first = await launch('inbox-first')
  const second = await launch('inbox-second')
  for (const task of [first, second]) {
    expect(
      await control.invoke('root', 'session.message', {
        targetSessionId: attempt(task).sessionId!,
        text: 'x'.repeat(3000),
        idempotencyKey: task.taskId,
      }),
    ).toMatchObject({ ok: true })
  }
  const inbox = await orchestration.invoke('root', 'orchestration.inbox', {
    sessionId: 'root',
    taskId: first.taskId,
    limit: 1,
  })
  expect(inbox.total).toBe(1)
  expect(inbox.messages[0]).toMatchObject({
    recipientSessionId: attempt(first).sessionId,
    status: 'pending',
    textTruncated: true,
    senderTitle: 'Root',
  })
  expect(inbox.messages[0]?.text).toHaveLength(2000)
  await store.append('foreign-project', {
    type: 'session.created',
    session: {
      ...root,
      id: 'foreign-project',
      parentSessionId: 'root',
      projectId: 'another-project',
    },
  })
  await store.append('foreign-project', {
    type: 'coordination.updated',
    message: {
      messageId: 'foreign-note',
      senderSessionId: 'foreign-project',
      recipientSessionId: 'foreign-project',
      text: 'Private project message',
      createdAt: 100,
      status: 'pending',
      turnId: null,
      consumedAt: null,
    },
  })
  expect(
    await orchestration.invoke('root', 'orchestration.inbox', { sessionId: 'root', limit: 1 }),
  ).toMatchObject({ total: 2, messages: [expect.anything()] })
  expect(Object.values((await store.load(attempt(first).sessionId!)).inbox ?? {})[0]?.status).toBe(
    'pending',
  )
  await expect(
    orchestration.invoke('root', 'orchestration.inbox', {
      sessionId: 'root',
      taskId: 'foreign-task',
    }),
  ).rejects.toMatchObject({ code: 'task_not_found' })
})

it.each(['stop', 'answer', 'destroy'] as const)(
  'never repeats a legacy %s effect whose final acknowledgement was lost',
  async (action) => {
    const task = await launch(`crash-${action}`)
    const id = attempt(task).sessionId!
    await store.append(id, { type: 'turn.started', turnId: 'live-effect' })
    await store.append(id, {
      type: 'user.message.added',
      message: {
        id: 'asked',
        sessionId: id,
        turnId: 'live-effect',
        role: 'user',
        parts: [],
        createdAt: 1,
        origin: { kind: 'session', sessionId: 'root' },
      },
    })
    if (action === 'answer')
      await store.append(id, {
        type: 'input.requested',
        inputId: 'input-effect',
        prompt: 'Which?',
        choicesJson: null,
      })
    const dispatch = host.dispatch.bind(host)
    const destroy = store.destroy.bind(store)
    let effects = 0
    if (action === 'destroy') {
      store.destroy = async (target) => {
        effects++
        await destroy(target)
        throw new Error('crash after destroy')
      }
    } else {
      host.dispatch = async (command, origin) => {
        const outcome = await dispatch(command, origin)
        if (command.type === (action === 'stop' ? 'turn.interrupt' : 'input.respond')) {
          effects++
          throw new Error('crash after provider effect')
        }
        return outcome
      }
    }
    const params = {
      targetSessionId: id,
      idempotencyKey: `lost-${action}`,
      ...(action === 'answer' ? { inputId: 'input-effect', value: 'A' } : {}),
    }
    const method =
      action === 'stop'
        ? 'session.stop'
        : action === 'answer'
          ? 'session.answer'
          : 'session.destroy'
    expect(await control.invoke('root', method, params)).toMatchObject({ ok: false })
    host.dispatch = dispatch
    store.destroy = destroy
    reload()
    expect(await control.invoke('root', method, params)).toMatchObject({
      ok: false,
      error: { code: 'uncertain_outcome' },
    })
    expect(effects).toBe(1)
    if (action === 'destroy') await workspaces.release(id)
  },
)
