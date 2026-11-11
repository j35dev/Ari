// @vitest-environment node
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { delegationSettingsSchema } from '@ari/contracts/agent-control'
import type { Session } from '@ari/contracts/session'
import { SessionStore } from '@ari/engine/session-store'
import { GitService } from '@ari/engine/git'
import { DriverRegistry } from '@ari/providers/registry'
import { err } from '@ari/shared/result'
import { Engine } from './engine'
import { startAgentRuntime } from './agent-runtime'
import { createSession } from './session-create'

let dir: string, repo: string
let store: SessionStore, engine: Engine
let runtime: Awaited<ReturnType<typeof startAgentRuntime>>
const folders = new Map<string, string>()
const base = {
  driverKind: 'codex' as const, modelId: 'fixture', permissionMode: 'full' as const,
  status: 'idle' as const, createdAt: 1, updatedAt: 1,
}
const launch = { projectId: 'p', title: 'Parallel root', driverKind: 'codex', modelId: 'fixture', prompt: 'Work', idempotencyKey: 'parallel' }
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, windowsHide: true, encoding: 'utf8' }).trim()

async function boot(recover = false): Promise<void> {
  const registry = new DriverRegistry()
  registry.register({
    kind: 'codex',
    create: async () => {
      let end!: () => void
      const waiting = new Promise<void>((resolve) => { end = resolve })
      return {
        start: () => ({ async *[Symbol.asyncIterator]() { await waiting; yield { type: 'done' as const } } }),
        interrupt: () => end(), dispose: async () => end(),
      }
    },
  })
  engine = new Engine({
    store, registry, publish: () => undefined,
    resolveWorkspace: async (id) => folders.get(id) ?? null,
    authorizeTurn: async (session) => runtime.authorizeTurn(session),
    authorizeWorkspace: async (session) => runtime.service.authorizeWorkspace(session),
    git: { captureCheckpoint: async () => ({ ok: true, value: null }) },
  })
  runtime = await startAgentRuntime({
    engine, store, userData: join(dir, 'profile'), cliPath: resolve('resources/cli/ari.cjs'),
    executable: process.execPath, version: 'test', recover,
    policy: () => delegationSettingsSchema.parse({ approvalMode: 'never' }),
    providers: async () => [{ driverKind: 'codex', available: true, models: [{ id: 'fixture', label: 'Fixture' }] }],
    projects: async () => [...folders].filter(([id]) => id !== 'helm').map(([projectId, path]) => ({
      projectId, path, name: projectId, available: true,
      defaultAgent: { ...base, effort: null },
    })),
  })
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ari-root-concurrency-'))
  repo = join(dir, 'repository'); await mkdir(repo)
  git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.com')
  git('config', 'core.autocrlf', 'false')
  await writeFile(join(repo, 'base.txt'), 'base\n'); git('add', '.'); git('commit', '-qm', 'base')
  folders.clear(); folders.set('p', repo); folders.set('alias', repo); folders.set('helm', dir)
  store = new SessionStore({ rootDir: join(dir, 'sessions') })
  await boot()
  await engine.createSession({ ...base, id: 'aria', projectId: 'helm', title: 'Aria' })
})
afterEach(async () => {
  vi.restoreAllMocks()
  await engine.shutdown(); await runtime.close()
  for (const row of await store.listSessions()) await store.closeJournal(row.id)
  await rm(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 })
})
async function seed(id: string, projectId = 'p'): Promise<void> {
  await engine.createSession({ ...base, id, projectId, title: id })
}
const start = (sessionId: string) => engine.dispatch({ type: 'turn.start', sessionId, text: 'Work', attachments: [] })
async function stop(id: string): Promise<void> {
  await engine.dispatch({ type: 'turn.interrupt', sessionId: id }); await engine.quiesce(id)
}

it('admits two top-level isolated worktrees together, snapshots dirty files, and cleans roots', async () => {
  await writeFile(join(repo, 'dirty.txt'), 'uncommitted\n')
  const originalHead = git('rev-parse', 'HEAD')
  const ids: string[] = []
  for (const title of ['One', 'Two']) {
    const created = await createSession({ loadProject: async () => undefined, createSession: (s) => engine.createSession(s), prepareRootWorkspace: runtime.prepareRootWorkspace }, { ...base, projectId: 'p', title, workspaceMode: 'isolated' })
    ids.push(created.sessionId)
  }
  const responses = await Promise.all(ids.map(start))
  expect(responses).toEqual([{ accepted: true }, { accepted: true }])
  await vi.waitFor(() => expect(ids.every((id) => engine.hasLiveTurn(id))).toBe(true))
  const paths = await Promise.all(ids.map(async (id) => engine.workspace((await store.load(id)).session!)))
  expect(paths[0]).not.toBe(paths[1]); expect(paths).not.toContain(repo)
  for (const path of paths) expect(await readFile(join(path!, 'dirty.txt'), 'utf8')).toBe('uncommitted\n')
  expect(git('rev-parse', 'HEAD')).toBe(originalHead)
  expect(git('status', '--porcelain')).toContain('?? dirty.txt')
  for (const id of ids) { await stop(id); await runtime.release(id); await runtime.release(id) }
  expect(paths.every((path) => !existsSync(path!))).toBe(true)
  expect(git('for-each-ref', '--format=%(refname)', 'refs/ari/orchestration/')).toBe('')
  expect(git('branch', '--list', 'ari/*')).toBe('')
})

it('atomically refuses simultaneous starts sharing a folder, even under different project IDs', async () => {
  await seed('one'); await seed('two', 'alias')
  const replies = await Promise.all([start('one'), start('two')])
  expect(replies.filter((r) => r.accepted)).toHaveLength(1)
  expect(replies.find((r) => !r.accepted)?.reason).toContain('Working folder is busy')
  expect((await store.load('two')).activeTurnId).toBeNull()
  await stop('one'); expect(await start('two')).toEqual({ accepted: true })
})

it('automatically gives Aria a root worktree alongside a busy human folder and reuses its durable spawn', async () => {
  await seed('human'); expect(await start('human')).toEqual({ accepted: true })
  const reply = await runtime.service.invoke('aria', 'session.spawn', launch)
  expect(reply).toMatchObject({ ok: true, result: { child: { workspace: { kind: 'managed-worktree' } } } })
  if (!reply.ok) throw new Error(reply.error.message)
  const child = (reply.result as { child: Session }).child
  expect(child.parentSessionId).toBeUndefined()
  await vi.waitFor(() => expect(engine.hasLiveTurn(child.id)).toBe(true))
  expect(engine.hasLiveTurn('human')).toBe(true)
  expect(await runtime.service.invoke('aria', 'session.spawn', { ...launch, workspaceMode: 'shared', idempotencyKey: 'refuse-shared' })).toMatchObject({ ok: false, error: { code: 'delegation_limit' } })
  await stop(child.id); await stop('human'); await runtime.close(); await engine.shutdown()
  for (const row of await store.listSessions()) await store.closeJournal(row.id)
  store = new SessionStore({ rootDir: join(dir, 'sessions') }); await boot(true)
  expect(await runtime.service.invoke('aria', 'session.spawn', launch)).toMatchObject({ ok: true, result: { child: { id: child.id, workspace: child.workspace } } })
  await start('human'); expect(await start(child.id)).toEqual({ accepted: true })
  await stop(child.id); await stop('human')
  expect(git('worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(2)
  expect(await runtime.service.invoke('aria', 'session.destroy', { targetSessionId: child.id, idempotencyKey: 'destroy' })).toMatchObject({ ok: true })
  expect(existsSync(child.workspace!.kind === 'managed-worktree' ? child.workspace!.path : '')).toBe(false)
})

it('refuses busy non-Git projects and empty repositories without creating another session', async () => {
  const plain = join(dir, 'plain'); await mkdir(plain); folders.set('plain', plain)
  await seed('plain-human', 'plain'); await start('plain-human')
  for (const initialized of [false, true]) {
    if (initialized) execFileSync('git', ['init', '-q'], { cwd: plain, windowsHide: true })
    const reply = await runtime.service.invoke('aria', 'session.spawn', { ...launch, projectId: 'plain', idempotencyKey: `plain-${initialized}` })
    expect(reply).toMatchObject({ ok: false, error: { code: 'workspace_not_git' } })
    expect(reply.ok ? '' : reply.error.message).toContain('plain-human')
  }
  expect((await store.listSessions()).filter((s) => s.projectId === 'plain')).toHaveLength(1)
})

it('preserves an uncertain root checkout identity on retries and reload and allows explicit cleanup', async () => {
  const original = GitService.prototype.addWorktree
  const add = vi.spyOn(GitService.prototype, 'addWorktree').mockImplementationOnce(async function(this: GitService, ...args) {
    expect((await original.apply(this, args)).ok).toBe(true)
    return err({ code: 'command_failed', message: 'lost checkout acknowledgement' })
  })
  const request = { ...launch, prompt: undefined, workspaceMode: 'isolated', idempotencyKey: 'uncertain-root' }
  const first = await runtime.service.invoke('aria', 'session.spawn', request)
  expect(first).toMatchObject({ ok: false, error: { code: 'uncertain_outcome', details: { workspace: { kind: 'managed-worktree' } } } })
  if (first.ok) throw new Error('Expected uncertainty')
  const recovery = first.error.details as { childSessionId: string; workspace: { path: string } }
  expect(existsSync(recovery.workspace.path)).toBe(true)
  expect(await runtime.service.invoke('aria', 'session.spawn', request)).toMatchObject({ ok: false, error: { code: 'uncertain_outcome', details: { childSessionId: recovery.childSessionId } } })
  await runtime.close(); await engine.shutdown(); await boot(true)
  expect(await runtime.service.invoke('aria', 'session.spawn', request)).toMatchObject({ ok: false, error: { code: 'uncertain_outcome', details: { childSessionId: recovery.childSessionId } } })
  expect(add).toHaveBeenCalledTimes(1)
  await store.append('aria', { type: 'session.updated', permissionMode: 'allow-edits' })
  expect(await runtime.service.invoke('aria', 'session.destroy', { targetSessionId: recovery.childSessionId, idempotencyKey: 'cleanup-cap' })).toMatchObject({ ok: false, error: { code: 'scope_denied' } })
  expect(existsSync(recovery.workspace.path)).toBe(true)
  await store.append('aria', { type: 'session.updated', permissionMode: 'full' })
  const cleanup = { targetSessionId: recovery.childSessionId, idempotencyKey: 'cleanup-unconfirmed' }
  expect(await runtime.service.invoke('aria', 'session.destroy', cleanup)).toMatchObject({ ok: true })
  expect(await runtime.service.invoke('aria', 'session.destroy', cleanup)).toMatchObject({ ok: true })
  expect(existsSync(recovery.workspace.path)).toBe(false)
})

it('automatically isolates human new-session creation alongside a busy project', async () => {
  await seed('human'); await start('human')
  const created = await createSession({ loadProject: async () => undefined, createSession: (s) => engine.createSession(s), prepareRootWorkspace: runtime.prepareRootWorkspace }, { ...base, projectId: 'p', title: 'Another human session' })
  expect((await store.load(created.sessionId)).session?.workspace?.kind).toBe('managed-worktree')
  expect(await start(created.sessionId)).toEqual({ accepted: true })
  expect(engine.hasLiveTurn('human')).toBe(true)
})

it('rechecks folder occupancy before resuming a long human wait', async () => {
  await seed('parked'); await seed('new-work'); await start('parked')
  await store.append('parked', { type: 'input.requested', inputId: 'question', prompt: 'Continue?', choicesJson: null, at: Date.now() - 4 * 60_000 })
  expect(await start('new-work')).toEqual({ accepted: true })
  expect(await engine.dispatch({ type: 'input.respond', sessionId: 'parked', inputId: 'question', value: 'Continue' })).toMatchObject({ accepted: false, reason: expect.stringContaining('new-work') })
  expect((await store.load('parked')).pendingInputs).toHaveLength(1)
})

it('counts shared descendants in their effective folder and resumes a held root queue when it frees', async () => {
  await seed('parent'); await seed('other')
  await engine.createSession({ ...base, id: 'descendant', projectId: 'p', title: 'Descendant', parentSessionId: 'parent', rootSessionId: 'parent', workspace: { kind: 'project' } })
  expect(await start('descendant')).toEqual({ accepted: true })
  expect(await start('other')).toMatchObject({ accepted: false, reason: expect.stringContaining('Descendant') })
  await engine.dispatch({ type: 'message.enqueue', sessionId: 'other', text: 'Held work', attachments: [], hold: true })
  await engine.drainHeld()
  expect((await store.load('other')).activeTurnId).toBeNull()
  await stop('descendant')
  await vi.waitFor(async () => expect((await store.load('other')).activeTurnId).not.toBeNull())
})
