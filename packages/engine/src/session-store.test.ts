import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
    // Pristine sessions report zero messages so the shell can reuse them
    // instead of piling up empty chats.
    expect(list.every((s) => s.messageCount === 0)).toBe(true)
  })

  it('serves listSessions from the index and replays only stale journals', async () => {
    const s2: Session = { ...session, id: 'sess_test2', title: 'Second', updatedAt: 2000 }
    await store.append(session.id, { type: 'session.created', session })
    await store.append(s2.id, { type: 'session.created', session: s2 })
    await store.append(s2.id, {
      type: 'user.message.added',
      message: { id: 'm1', sessionId: s2.id, turnId: 'turn_1', role: 'user', parts: [{ type: 'text', text: 'hi' }], createdAt: 2001 },
    })

    // Warm-up listing builds the sidecar indexes (may replay).
    const warm = await store.listSessions()
    expect(warm.find((s) => s.id === s2.id)?.messageCount).toBe(1)

    const spies = []
    for (const id of [session.id, s2.id]) {
      const j = await store.openJournal(id)
      spies.push(vi.spyOn(j, 'readAll'))
    }

    // Simulate a crash between journal append and index write: the journal
    // grows behind the sidecar's back.
    const j2 = await store.openJournal(s2.id)
    await j2.append({ type: 'session.updated', title: 'Renamed', seq: 2, at: 2500, sessionId: s2.id })

    const list = await store.listSessions()
    expect(list.map((s) => s.title)).toEqual(['Renamed', 'Test session'])
    // Exactly one replay: the stale journal. The fresh one was never read.
    expect(spies.map((s) => s.mock.calls.length)).toEqual([0, 1])

    // Once repaired, listing is replay-free for every session.
    spies.forEach((s) => s.mockClear())
    const again = await store.listSessions()
    expect(spies.every((s) => s.mock.calls.length === 0)).toBe(true)
    expect(again.map((s) => s.title)).toEqual(['Renamed', 'Test session'])
  })

  it('repairs a corrupt or missing sidecar index via replay', async () => {
    await store.append(session.id, { type: 'session.created', session })
    expect(await store.listSessions()).toHaveLength(1)
    await writeFile(join(rootDir, session.id, 'index.json'), '{corrupt', 'utf8')

    // Cold store (crash survivor): falls back to replay, serves correct data.
    const fresh = new SessionStore({ rootDir })
    const list = await fresh.listSessions()
    expect(list).toHaveLength(1)
    expect(list[0]?.title).toBe('Test session')

    // The repair persisted: yet another cold reader sees the same data.
    const fresher = new SessionStore({ rootDir })
    expect(await fresher.listSessions()).toHaveLength(1)
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

  it('persists pin/archive flags through index and replay; archived sessions still list', async () => {
    await store.append(session.id, { type: 'session.created', session })
    await store.append(session.id, {
      type: 'session.updated',
      pinned: true,
      archived: true,
    })

    const listed = await store.listSessions()
    expect(listed).toHaveLength(1) // archived sessions stay listed, flagged
    expect(listed[0]?.archived).toBe(true)
    expect(listed[0]?.pinned).toBe(true)

    // Cold reader: flags survive via replay and land in a fresh sidecar.
    const cold = new SessionStore({ rootDir })
    const again = await cold.listSessions()
    expect(again[0]?.archived).toBe(true)
    expect(again[0]?.pinned).toBe(true)

    // Unpin + unarchive round-trip.
    await store.append(session.id, {
      type: 'session.updated',
      pinned: false,
      archived: false,
    })
    const cleared = await store.listSessions()
    expect(cleared[0]?.archived).toBe(false)
    expect(cleared[0]?.pinned).toBe(false)
    const model = await store.load(session.id)
    expect(model.session?.archived).toBe(false)
    expect(model.session?.pinned).toBe(false)
  })

  it('repairs pre-M18.2 v1 sidecar indexes via replay', async () => {
    await store.append(session.id, { type: 'session.created', session })
    await store.append(session.id, { type: 'session.updated', pinned: true })
    expect(await store.listSessions()).toHaveLength(1)

    // Hand-write a legacy v1-shaped sidecar (no flag fields).
    const bytes = await import('node:fs/promises').then((f) =>
      f.readFile(join(rootDir, session.id, 'index.json'), 'utf8'),
    )
    const v2 = JSON.parse(bytes) as Record<string, unknown>
    await writeFile(
      join(rootDir, session.id, 'index.json'),
      JSON.stringify({ ...v2, version: 1, archived: undefined, pinned: undefined }),
      'utf8',
    )

    // The stale version forces one authoritative replay that repairs to v2.
    const fresh = new SessionStore({ rootDir })
    const list = await fresh.listSessions()
    expect(list).toHaveLength(1)
    expect(list[0]?.title).toBe('Test session')
    expect(list[0]?.pinned).toBe(true)
    expect(list[0]?.archived).toBe(false)
  })
})
