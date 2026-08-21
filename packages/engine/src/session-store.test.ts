import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Session } from '@ari/contracts/session'
import { SessionStore } from './session-store'

let rootDir: string
let store: SessionStore

const session: Session = {
  id: 'sess_test1',
  projectId: 'proj_1',
  title: 'Test session',
  driverKind: 'claude',
  modelId: null,
  permissionMode: 'ask',
  status: 'idle',
  createdAt: 1000,
  updatedAt: 1000,
}

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), 'ari-store-'))
  store = new SessionStore({ rootDir })
})

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true })
})

describe('SessionStore', () => {
  it('creates a session and replays it into a read model', async () => {
    await store.append(session.id, { type: 'session.created', session })
    const model = await store.load(session.id)
    expect(model.session?.title).toBe('Test session')
    expect(model.lastSeq).toBe(0)
  })

  it('stamps seq/at automatically and continues the sequence', async () => {
    await store.append(session.id, { type: 'session.created', session })
    const event = await store.append(session.id, {
      type: 'turn.started',
      turnId: 'turn_1',
    })
    expect(event.seq).toBe(1)
    expect(event.at).toBeGreaterThan(0)
  })

  it('lists sessions newest-first for the sidebar', async () => {
    const s2: Session = { ...session, id: 'sess_test2', title: 'Second', updatedAt: 2000 }
    await store.append(session.id, { type: 'session.created', session })
    await store.append(s2.id, { type: 'session.created', session: s2 })
    const list = await store.listSessions()
    expect(list.map((s) => s.id)).toEqual(['sess_test2', 'sess_test1'])
  })

  it('destroy removes the journal directory entirely', async () => {
    await store.append(session.id, { type: 'session.created', session })
    await store.destroy(session.id)
    const fresh = new SessionStore({ rootDir })
    const model = await fresh.load(session.id)
    expect(model.session).toBeNull()
  })

  it('reopens journals across store instances (persistence)', async () => {
    await store.append(session.id, { type: 'session.created', session })
    await store.closeJournal(session.id)
    const second = new SessionStore({ rootDir })
    const model = await second.load(session.id)
    expect(model.session?.id).toBe(session.id)
  })
})
