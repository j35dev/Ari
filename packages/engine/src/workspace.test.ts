import { expect, it } from 'vitest'
import { tmpdir } from 'node:os'
import type { Session } from '@ari/contracts/session'
import { resolveSessionWorkspace } from './workspace'

const root: Session = { id: 'root', projectId: 'p', title: 'Root', driverKind: 'claude',
  modelId: null, permissionMode: 'ask', status: 'idle', createdAt: 1, updatedAt: 1 }

it('uses project cwd for roots and inherits the parent cwd only for shared children', async () => {
  const parent: Session = { ...root, workspace: { kind: 'managed-worktree', path: tmpdir(),
    branch: 'ari/parent', baseRef: 'refs/ari/base', baseCommit: 'a'.repeat(40) } }
  const project = () => Promise.resolve('/project')
  const find = () => Promise.resolve(parent)
  expect(await resolveSessionWorkspace(root, project, find)).toBe('/project')
  expect(await resolveSessionWorkspace(parent, project, find)).toBe(tmpdir())
  expect(await resolveSessionWorkspace({ ...root, id: 'child', parentSessionId: root.id }, project, find)).toBe(tmpdir())
})

it('refuses missing workspaces, missing parents, cross-project parents and cycles', async () => {
  const project = () => Promise.resolve('/project')
  const child = { ...root, id: 'child', parentSessionId: root.id }
  expect(await resolveSessionWorkspace(child, project, () => Promise.resolve(null))).toBeNull()
  expect(await resolveSessionWorkspace(child, project, () => Promise.resolve({ ...root, projectId: 'other' }))).toBeNull()
  expect(await resolveSessionWorkspace(child, project, () => Promise.resolve(child))).toBeNull()
  expect(await resolveSessionWorkspace({ ...root, workspace: { kind: 'managed-worktree',
    path: '/ari-nonexistent-worktree', branch: 'ari/x', baseRef: 'refs/ari/x', baseCommit: 'a'.repeat(40) } }, project, () => Promise.resolve(null))).toBeNull()
})
