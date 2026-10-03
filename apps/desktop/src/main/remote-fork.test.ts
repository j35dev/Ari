import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentControlService, type ControlHost } from '@ari/engine/agent-control'
import { ManagedWorkspaces } from '@ari/engine/git'
import { SessionStore } from '@ari/engine/session-store'
import { delegationSettingsSchema } from '@ari/contracts/agent-control'
import type { Session } from '@ari/contracts/session'
import { forkRemoteSession } from './remote-fork'

const roots: { dir: string; store: SessionStore }[] = []
afterEach(async () => {
  for (const { dir, store } of roots.splice(0)) {
    for (const row of await store.listSessions()) await store.closeJournal(row.id)
    await rm(dir, { recursive: true, force: true, maxRetries: 3 })
  }
})
const command = {
  op: 'session.fork' as const,
  sessionId: 'root',
  title: 'Isolated task',
  driverKind: 'claude' as const,
  modelId: 'model-a',
  clientCommandId: 'cmd',
  idempotencyKey: 'unique-command-key',
}

it('forwards only isolated spawning and keeps native receipt keys private to each device', async () => {
  const invoke = vi.fn(async () => ({
    ok: true as const,
    result: { child: { id: 'child' }, workspace: { path: '/private/computer/path' } },
  }))
  expect(await forkRemoteSession({ invoke }, 'phone-a', command)).toEqual({
    ok: true,
    result: { sessionId: 'child' },
  })
  await forkRemoteSession({ invoke }, 'phone-b', command)
  const first = invoke.mock.calls[0] as unknown as [string, string, Record<string, unknown>]
  const second = invoke.mock.calls[1] as unknown as [string, string, Record<string, unknown>]
  expect(first.slice(0, 2)).toEqual(['root', 'session.spawn'])
  expect(first[2]).toEqual({
    title: 'Isolated task',
    driverKind: 'claude',
    modelId: 'model-a',
    workspaceMode: 'isolated',
    idempotencyKey: expect.stringMatching(/^[a-f0-9]{64}$/) as unknown,
  })
  expect(first[2]['idempotencyKey']).not.toBe(second[2]['idempotencyKey'])
})

it('creates a real managed worktree using native policy, approval and durable repeat protection', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ari-remote-fork-'))
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf8', windowsHide: true }).trim()
  git('init', '-q')
  git('config', 'core.autocrlf', 'false')
  git('config', 'user.name', 'Test')
  git('config', 'user.email', 'test@example.com')
  await writeFile(join(dir, 'file.txt'), 'base\n')
  git('add', '.')
  git('commit', '-qm', 'base')
  const store = new SessionStore({ rootDir: join(dir, '.ari-test-sessions') })
  roots.push({ dir, store })
  const parent: Session = {
    id: 'root',
    projectId: 'project',
    title: 'Root',
    driverKind: 'claude',
    modelId: null,
    permissionMode: 'ask',
    status: 'idle',
    createdAt: 1,
    updatedAt: 1,
  }
  await store.append(parent.id, { type: 'session.created', session: parent })
  const manager = new ManagedWorkspaces(join(dir, '.ari-test-worktrees'))
  const approve = vi.fn(async () => true)
  let enabled = true
  const host: ControlHost = {
    store,
    version: 'test',
    policy: () => delegationSettingsSchema.parse({ enabled }),
    providers: async () => [
      { driverKind: 'claude', available: true, models: [{ id: 'model-a', label: 'A' }] },
    ],
    create: async (session) => {
      await store.append(session.id, { type: 'session.created', session })
    },
    dispatch: async () => ({ accepted: true }),
    record: (id, event) => store.append(id, event),
    subscribe: (listener) => store.subscribe(listener),
    workspace: async (session) =>
      session.workspace?.kind === 'managed-worktree' ? session.workspace.path : dir,
    isolate: (session, id) => manager.isolate(session, dir, id),
    diff: (session, patch) => manager.diff(session, patch),
    integrate: async () => {
      throw new Error('Not used by fork')
    },
    approve,
    release: (session) => manager.release(session.id),
  }
  const service = new AgentControlService(host)
  const result = await forkRemoteSession(service, 'phone', command)
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(result.message)
  const child = (await store.load(result.result.sessionId)).session
  expect(child).toMatchObject({
    parentSessionId: 'root',
    rootSessionId: 'root',
    projectId: 'project',
    permissionMode: 'ask',
    workspace: { kind: 'managed-worktree' },
  })
  if (child?.workspace?.kind !== 'managed-worktree') throw new Error('Missing isolated child')
  expect(await readFile(join(child.workspace.path, 'file.txt'), 'utf8')).toBe('base\n')
  expect(approve).toHaveBeenCalledOnce()
  expect(await forkRemoteSession(new AgentControlService(host), 'phone', command)).toEqual(result)
  expect((await store.listSessions()).filter((row) => row.parentSessionId === 'root')).toHaveLength(
    1,
  )
  enabled = false
  expect(
    await forkRemoteSession(service, 'phone', {
      ...command,
      idempotencyKey: 'another-command-key',
    }),
  ).toMatchObject({ ok: false, code: 'conflict' })
}, 30000)
