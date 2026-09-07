import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { sessionSchema } from '@ari/contracts/session'
import { SessionStore } from './session-store'

it('replays legacy sessions and persists child metadata, origin and lifecycle independently', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'ari-hierarchy-'))
  const store = new SessionStore({ rootDir })
  try {
    const root = sessionSchema.parse({ id: 'root', projectId: 'p', title: 'Root',
      driverKind: 'claude', modelId: null, permissionMode: 'ask', status: 'idle',
      createdAt: 1, updatedAt: 1 })
    await store.append(root.id, { type: 'session.created', session: root })
    const child = sessionSchema.parse({ ...root, id: 'child', parentSessionId: root.id,
      rootSessionId: root.id, createdBy: { kind: 'session', sessionId: root.id },
      workspace: { kind: 'managed-worktree', path: '/work/child', branch: 'ari/child',
        baseRef: 'refs/ari/child/base', baseCommit: 'a'.repeat(40) } })
    await store.append(child.id, { type: 'session.created', session: child })
    await store.append(child.id, { type: 'user.message.added', message: {
      id: 'm', sessionId: child.id, turnId: null, role: 'user',
      origin: { kind: 'session', sessionId: root.id },
      parts: [{ type: 'text', text: 'Implement persistence' }], createdAt: 2,
    } })
    await store.append(root.id, { type: 'child.session.integrated', childSessionId: child.id,
      snapshotCommit: 'b'.repeat(40), result: 'integrated' })
    await store.closeJournal(root.id)
    await store.closeJournal(child.id)
    const reopened = new SessionStore({ rootDir })
    expect((await reopened.load(root.id)).session?.parentSessionId).toBeUndefined()
    expect((await reopened.load(root.id)).childEvents).toHaveLength(1)
    expect((await reopened.load(child.id)).messages[0]?.origin).toEqual({ kind: 'session', sessionId: 'root' })
    expect((await reopened.listSessions()).find((s) => s.id === 'child')).toMatchObject({
      parentSessionId: 'root', rootSessionId: 'root', branch: 'ari/child', workspaceKind: 'managed-worktree',
    })
    await reopened.closeJournal(root.id)
    await reopened.closeJournal(child.id)
  } finally {
    await store.closeJournal('root')
    await store.closeJournal('child')
    await rm(rootDir, { recursive: true, force: true })
  }
})
