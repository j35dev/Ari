import { expect, it } from 'vitest'
import { tmpdir } from 'node:os'
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { Session } from '@ari/contracts/session'
import { resolveSessionWorkspace, workspacesOverlap } from './workspace'

it('compares physical aliases and nested folders without matching sibling prefixes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ari-folder-occupancy-'))
  try {
    const folder = join(dir, 'repo')
    const child = join(folder, 'child')
    const alias = join(dir, 'alias')
    await mkdir(child, { recursive: true })
    await symlink(folder, alias, process.platform === 'win32' ? 'junction' : 'dir')
    expect(await workspacesOverlap(folder, alias)).toBe(true)
    expect(await workspacesOverlap(child, alias)).toBe(true)
    expect(await workspacesOverlap(folder, join(dir, 'repository'))).toBe(false)
    expect(await workspacesOverlap(folder, join(dir, 'another-worktree'))).toBe(false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

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

it('uses project cwd for roots and inherits the parent cwd only for shared children', async () => {
  const parent: Session = {
    ...root,
    workspace: {
      kind: 'managed-worktree',
      path: tmpdir(),
      branch: 'ari/parent',
      baseRef: 'refs/ari/base',
      baseCommit: 'a'.repeat(40),
    },
  }
  const project = () => Promise.resolve('/project')
  const find = () => Promise.resolve(parent)
  expect(await resolveSessionWorkspace(root, project, find)).toBe('/project')
  expect(await resolveSessionWorkspace(parent, project, find)).toBe(tmpdir())
  expect(
    await resolveSessionWorkspace(
      { ...root, id: 'child', parentSessionId: root.id },
      project,
      find,
    ),
  ).toBe(tmpdir())
})

it('refuses missing workspaces, missing parents, cross-project parents and cycles', async () => {
  const project = () => Promise.resolve('/project')
  const child = { ...root, id: 'child', parentSessionId: root.id }
  expect(await resolveSessionWorkspace(child, project, () => Promise.resolve(null))).toBeNull()
  expect(
    await resolveSessionWorkspace(child, project, () =>
      Promise.resolve({ ...root, projectId: 'other' }),
    ),
  ).toBeNull()
  expect(await resolveSessionWorkspace(child, project, () => Promise.resolve(child))).toBeNull()
  expect(
    await resolveSessionWorkspace(
      {
        ...root,
        workspace: {
          kind: 'managed-worktree',
          path: '/ari-nonexistent-worktree',
          branch: 'ari/x',
          baseRef: 'refs/ari/x',
          baseCommit: 'a'.repeat(40),
        },
      },
      project,
      () => Promise.resolve(null),
    ),
  ).toBeNull()
})
