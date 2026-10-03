import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { Session } from '@ari/contracts/session'
import { ManagedWorkspaces } from '@ari/engine/git'
import { SessionStore } from '@ari/engine/session-store'
import { RemoteIntegration } from './remote-integration'

let dir: string
let repo: string
let childPath: string
let store: SessionStore
let integration: RemoteIntegration
let live: boolean
const caller = { deviceId: 'phone', projectIds: ['project'] }
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
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim()

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ari-remote-integration-'))
  repo = join(dir, 'parent repo')
  await mkdir(repo)
  git(repo, 'init', '-q')
  git(repo, 'config', 'core.autocrlf', 'false')
  git(repo, 'config', 'user.name', 'Test')
  git(repo, 'config', 'user.email', 'test@example.com')
  await writeFile(join(repo, 'file.txt'), 'base\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-qm', 'base')
  const manager = new ManagedWorkspaces(join(dir, 'worktrees'))
  const workspace = await manager.isolate(parent, repo, 'child')
  if (workspace.kind !== 'managed-worktree') throw new Error('Expected isolated workspace')
  childPath = workspace.path
  store = new SessionStore({ rootDir: join(dir, 'sessions') })
  await store.append(parent.id, { type: 'session.created', session: parent })
  await store.append('child', {
    type: 'session.created',
    session: { ...parent, id: 'child', parentSessionId: parent.id, workspace },
  })
  live = false
  integration = new RemoteIntegration(
    manager,
    {
      workspace: async () => repo,
      quiesce: async () => undefined,
      hasLiveTurn: () => live,
      record: (id, event) => store.append(id, event),
    },
    store,
  )
})
afterEach(async () => {
  await store.closeJournal('root')
  await store.closeJournal('child')
  await rm(dir, { recursive: true, force: true, maxRetries: 3 })
})

it('integrates reviewed files with the real Git backend while preserving parent HEAD, index and unrelated edits', async () => {
  await writeFile(join(childPath, 'file.txt'), 'child\n')
  await writeFile(join(repo, 'unrelated.txt'), 'parent dirty\n')
  const head = git(repo, 'rev-parse', 'HEAD')
  const index = await readFile(join(repo, '.git', 'index'))
  const preview = await integration.preview(caller, 'child')
  expect(preview.files).toMatchObject([{ path: 'file.txt', status: 'M' }])
  expect(
    await integration.integrate(
      caller,
      'child',
      preview.snapshotCommit,
      preview.expectedParentSnapshot,
    ),
  ).toMatchObject({ status: 'integrated' })
  expect(await readFile(join(repo, 'file.txt'), 'utf8')).toBe('child\n')
  expect(await readFile(join(repo, 'unrelated.txt'), 'utf8')).toBe('parent dirty\n')
  expect(git(repo, 'rev-parse', 'HEAD')).toBe(head)
  expect(await readFile(join(repo, '.git', 'index'))).toEqual(index)
  expect((await store.load(parent.id)).childEvents).toMatchObject([
    { type: 'child.session.integrated', result: 'integrated' },
  ])
  expect(
    await integration.integrate(
      caller,
      'child',
      preview.snapshotCommit,
      preview.expectedParentSnapshot,
    ),
  ).toMatchObject({ status: 'already_integrated' })
}, 30000)

it('refuses changed parent and child snapshots without applying files', async () => {
  await writeFile(join(childPath, 'file.txt'), 'child\n')
  const preview = await integration.preview(caller, 'child')
  await writeFile(join(repo, 'later.txt'), 'late edit\n')
  await expect(
    integration.integrate(caller, 'child', preview.snapshotCommit, preview.expectedParentSnapshot),
  ).rejects.toMatchObject({ code: 'stale_snapshot' })
  expect(await readFile(join(repo, 'file.txt'), 'utf8')).toBe('base\n')
  const refreshed = await integration.preview(caller, 'child')
  await writeFile(join(childPath, 'file.txt'), 'child changed again\n')
  await expect(
    integration.integrate(
      caller,
      'child',
      refreshed.snapshotCommit,
      refreshed.expectedParentSnapshot,
    ),
  ).rejects.toMatchObject({ code: 'stale_snapshot' })
  expect(await readFile(join(repo, 'file.txt'), 'utf8')).toBe('base\n')
}, 30000)

it('returns real conflicts without changing the working files and refuses active or ungranted sessions', async () => {
  await writeFile(join(childPath, 'file.txt'), 'child conflict\n')
  await writeFile(join(repo, 'file.txt'), 'parent conflict\n')
  const preview = await integration.preview(caller, 'child')
  expect(
    await integration.integrate(
      caller,
      'child',
      preview.snapshotCommit,
      preview.expectedParentSnapshot,
    ),
  ).toMatchObject({ status: 'conflict', files: ['file.txt'] })
  expect(await readFile(join(repo, 'file.txt'), 'utf8')).toBe('parent conflict\n')
  await expect(integration.preview({ ...caller, projectIds: [] }, 'child')).rejects.toMatchObject({
    code: 'scope_denied',
  })
  await expect(integration.preview(caller, 'root')).rejects.toMatchObject({ code: 'scope_denied' })
  live = true
  await expect(
    integration.integrate(caller, 'child', preview.snapshotCommit, preview.expectedParentSnapshot),
  ).rejects.toMatchObject({ code: 'invalid_request' })
}, 30000)
