import { mkdtemp, readFile, readdir, rm, appendFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Worker } from 'node:worker_threads'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Session } from '@ari/contracts/session'
import type { JournalEvent } from '@ari/contracts/events'
import { SessionStore } from './session-store'
import { Journal } from './journal'
import { projectEvents } from './projection'
import { ConversationDatabase } from './conversation-database'

let rootDir: string
let stores: SessionStore[]
const session: Session = {
  id: 'conversation_test',
  projectId: 'project',
  title: 'Saved conversation',
  driverKind: 'codex',
  modelId: 'model',
  permissionMode: 'ask',
  status: 'idle',
  createdAt: 1,
  updatedAt: 1,
}
function createStore(storage?: 'jsonl'): SessionStore {
  const store = new SessionStore({ rootDir, ...(storage ? { storage } : {}) })
  stores.push(store)
  return store
}
async function createTurn(store: SessionStore): Promise<void> {
  await store.append(session.id, { type: 'session.created', session })
  await store.append(session.id, { type: 'turn.started', turnId: 'turn1' })
  await store.append(session.id, {
    type: 'user.message.added',
    message: {
      id: 'user1',
      sessionId: session.id,
      turnId: 'turn1',
      role: 'user',
      parts: [{ type: 'text', text: 'Hello' }],
      createdAt: 2,
    },
  })
}
beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), 'ari-conversations-'))
  stores = []
})
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(stores.map((store) => store.close()))
  await rm(rootDir, { recursive: true, force: true })
})

describe('SQLite conversations', () => {
  it('does not create files while checking or listing a new installation', async () => {
    const store = createStore()
    expect(await store.loadExisting('missing')).toBeNull()
    expect(await store.listSessions()).toEqual([])
    expect(await readdir(rootDir)).toEqual([])
  })

  it('reopens complete messages and resumes the exact provider context without replaying history', async () => {
    const store = createStore()
    await createTurn(store)
    await store.append(session.id, { type: 'session.ref.observed', ref: 'provider-thread' })
    await store.append(session.id, {
      type: 'assistant.parts.appended',
      messageId: 'assistant1',
      parts: [{ type: 'thinking', text: 'Reasoning' }],
    })
    await store.append(session.id, {
      type: 'assistant.parts.appended',
      messageId: 'assistant1',
      parts: [{ type: 'text', text: 'Hello ' }],
    })
    await store.append(session.id, {
      type: 'assistant.parts.appended',
      messageId: 'assistant1',
      parts: [{ type: 'text', text: 'again' }],
    })
    await store.append(session.id, {
      type: 'turn.settled',
      turnId: 'turn1',
      stopReason: 'completed',
      errorMessage: null,
    })
    const expected = await store.load(session.id)
    await store.close()
    const reader = createStore()
    const replay = vi.spyOn(Journal.prototype, 'readAll')
    expect(await reader.load(session.id)).toEqual(expected)
    expect(replay).not.toHaveBeenCalled()
    expect((await reader.load(session.id)).providerSessionId).toBe('provider-thread')
    expect((await reader.listSessions())[0]?.messageCount).toBe(2)
    expect(await readdir(rootDir)).not.toContain(session.id)
  })

  it('saves a partial stream on close and preserves sequence-perfect remote replay', async () => {
    const store = createStore()
    const observed: JournalEvent[] = []
    store.subscribe((event) => observed.push(event))
    await createTurn(store)
    for (let n = 0; n < 50; n++)
      await store.append(session.id, {
        type: 'assistant.parts.appended',
        messageId: 'assistant1',
        parts: [{ type: 'text', text: `${n},` }],
      })
    await store.close()
    const reader = createStore()
    const entries = await (await reader.openJournal(session.id)).readAll()
    const replayed = entries.flatMap((entry) => (entry.kind === 'value' ? [entry.value] : []))
    expect(replayed).toEqual(observed)
    expect(replayed.map((event) => event.seq)).toEqual(replayed.map((_, index) => index))
    expect(await reader.load(session.id)).toEqual(projectEvents(replayed))
  })

  it('reopens queued work, approval choices, usage and provider switches', async () => {
    const store = createStore()
    await createTurn(store)
    await store.append(session.id, {
      type: 'message.enqueued',
      text: 'Follow up',
      attachments: [],
      held: true,
      origin: { kind: 'human' },
    })
    await store.append(session.id, {
      type: 'approval.requested',
      approvalId: 'approval1',
      toolName: 'shell',
      summaryJson: '{}',
      options: [{ optionId: 'allow', kind: 'allow_once', name: 'Allow' }],
    })
    await store.append(session.id, { type: 'session.ref.observed', ref: 'old-thread' })
    await store.append(session.id, {
      type: 'session.provider.switched',
      driverKind: 'claude',
      modelId: 'new-model',
      effort: 'high',
      afterTurnId: 'turn1',
      afterMessageId: null,
    })
    await store.append(session.id, {
      type: 'usage.recorded',
      inputTokens: 123,
      outputTokens: 12,
      cachedInputTokens: 0,
      costUsd: 0.01,
    })
    const expected = await store.load(session.id)
    await store.close()
    const reader = createStore()
    expect(await reader.load(session.id)).toEqual(expected)
    expect((await reader.load(session.id)).providerSessionId).toBeNull()
    expect((await reader.usageSummary()).totals.inputTokens).toBe(123)
  })

  it('imports a legacy conversation once without rewriting its original journal', async () => {
    const legacy = createStore('jsonl')
    await createTurn(legacy)
    await legacy.append(session.id, { type: 'session.ref.observed', ref: 'legacy-thread' })
    await legacy.append(session.id, {
      type: 'assistant.parts.appended',
      messageId: 'assistant1',
      parts: [{ type: 'text', text: 'Saved before upgrade' }],
    })
    await legacy.append(session.id, {
      type: 'turn.settled',
      turnId: 'turn1',
      stopReason: 'completed',
      errorMessage: null,
    })
    const expected = await legacy.load(session.id)
    await legacy.closeJournal(session.id)
    const path = join(rootDir, session.id, 'journal.0000.jsonl')
    const original = await readFile(path, 'utf8')
    const store = createStore()
    expect((await store.listSessions()).map((row) => row.id)).toEqual([session.id])
    expect(await store.load(session.id)).toEqual(expected)
    await store.append(session.id, { type: 'session.updated', title: 'After upgrade' })
    expect(await readFile(path, 'utf8')).toBe(original)
    await store.close()
    expect((await createStore().load(session.id)).session?.title).toBe('After upgrade')
  })

  it('batches and compresses stream history while storing one current row per message', async () => {
    const store = createStore()
    await createTurn(store)
    for (let n = 0; n < 100; n++)
      await store.append(session.id, {
        type: 'assistant.parts.appended',
        messageId: 'assistant1',
        parts: [{ type: 'text', text: 'A streamed word. ' }],
      })
    await store.append(session.id, {
      type: 'turn.settled',
      turnId: 'turn1',
      stopReason: 'completed',
      errorMessage: null,
    })
    await store.close()
    const db = new DatabaseSync(join(rootDir, 'conversations.sqlite'), { readOnly: true })
    try {
      expect(db.prepare('SELECT count(*) AS n FROM conversation_messages').get()?.n).toBe(2)
      expect(
        Number(db.prepare('SELECT count(*) AS n FROM conversation_history').get()?.n),
      ).toBeLessThan(15)
      expect(
        Number(
          db.prepare('SELECT sum(length(payload)) AS bytes FROM conversation_history').get()?.bytes,
        ),
      ).toBeLessThan(100 * 100)
    } finally {
      db.close()
    }
  })

  it('preserves a legacy torn tail and excludes records from another conversation during import', async () => {
    const legacy = createStore('jsonl')
    await createTurn(legacy)
    await legacy.closeJournal(session.id)
    const path = join(rootDir, session.id, 'journal.0000.jsonl')
    await appendFile(
      path,
      JSON.stringify({
        type: 'session.updated',
        sessionId: 'other',
        seq: 3,
        at: 3,
        permissionMode: 'full',
      }) + '\n{torn',
    )
    const original = await readFile(path, 'utf8')
    const store = createStore()
    expect((await store.load(session.id)).session?.permissionMode).toBe('ask')
    expect(store.replayDiagnostics(session.id).rejectedCount).toBe(2)
    expect(await readFile(path, 'utf8')).toBe(original)
  })

  it('refuses to migrate missing legacy segments rather than saving incomplete history', async () => {
    const legacy = createStore('jsonl')
    await createTurn(legacy)
    await legacy.closeJournal(session.id)
    await writeFile(join(rootDir, session.id, 'journal.0002.jsonl'), '')
    await expect(createStore().load(session.id)).rejects.toThrow('segment gap')
    expect(await readdir(rootDir)).not.toContain('conversations.sqlite')
  })

  it('retries a control transition whose database commit fails once before publishing it', async () => {
    const store = createStore()
    const saves = vi
      .spyOn(ConversationDatabase.prototype, 'save')
      .mockRejectedValueOnce(new Error('Disk unavailable'))
    // Published only once it is saved: the failed attempt and the retry.
    const savesWhenPublished: number[] = []
    store.subscribe(() => savesWhenPublished.push(saves.mock.calls.length))
    await store.append(session.id, { type: 'session.created', session })
    expect(savesWhenPublished).toEqual([2])
    await store.close()
    expect((await createStore().loadExisting(session.id))?.session?.title).toBe(session.title)
  })

  it('keeps a session working through failed saves and writes every lost batch later', async () => {
    const store = createStore()
    await createTurn(store)
    // Called below with the database instance as its receiver.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const save = ConversationDatabase.prototype.save
    let failing = true
    const saves = vi.spyOn(ConversationDatabase.prototype, 'save').mockImplementation(function (
      this: ConversationDatabase,
      commit,
    ) {
      return failing ? Promise.reject(new Error('Disk full')) : save.call(this, commit)
    })
    await store.append(session.id, {
      type: 'assistant.parts.appended',
      messageId: 'assistant1',
      parts: [{ type: 'text', text: 'Kept ' }],
    })
    // A turn still settles while every save fails.
    await store.append(session.id, {
      type: 'turn.settled',
      turnId: 'turn1',
      stopReason: 'completed',
      errorMessage: null,
    })
    expect((await store.load(session.id)).activeTurnId).toBeNull()
    failing = false
    // The background retry writes the batch that failed, without another append.
    const calls = saves.mock.calls.length
    await expect.poll(() => saves.mock.calls.length, { timeout: 5000 }).toBeGreaterThan(calls)
    await store.flush(session.id)
    // And later events save normally: the failure is not sticky.
    await store.append(session.id, { type: 'session.updated', title: 'After the outage' })
    const expected = await store.load(session.id)
    await store.close()
    const reader = createStore()
    expect(await reader.load(session.id)).toEqual(expected)
    expect((await reader.load(session.id)).messages.at(-1)?.parts).toEqual([
      { type: 'text', text: 'Kept ' },
    ])
  })

  it('restarts the database worker after it crashes', async () => {
    const store = createStore()
    await createTurn(store)
    await store.close()
    const database = new ConversationDatabase(join(rootDir, 'conversations.sqlite'))
    try {
      // The first request reaches a worker that dies before answering.
      vi.spyOn(Worker.prototype, 'postMessage').mockImplementationOnce(function (this: Worker) {
        void this.terminate()
      })
      await expect(database.list()).rejects.toThrow('worker exited')
      expect((await database.list()).map((row) => row.id)).toEqual([session.id])
    } finally {
      await database.close()
    }
  })

  it('lists every other conversation when one index row is unreadable', async () => {
    const store = createStore()
    await createTurn(store)
    await store.append('other', { type: 'session.created', session: { ...session, id: 'other' } })
    await store.close()
    const raw = new DatabaseSync(join(rootDir, 'conversations.sqlite'))
    raw.prepare('UPDATE conversations SET index_json=? WHERE id=?').run('null', 'other')
    raw.close()
    const reader = createStore()
    expect((await reader.listSessions()).map((row) => row.id)).toEqual([session.id])
    expect((await reader.usageSummary()).rows).toEqual([])
  })

  it('continues publishing live text while a background database save is stalled', async () => {
    const store = createStore()
    await createTurn(store)
    // Called below with the database instance as its receiver.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const save = ConversationDatabase.prototype.save
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let started!: () => void
    const began = new Promise<void>((resolve) => {
      started = resolve
    })
    vi.spyOn(ConversationDatabase.prototype, 'save').mockImplementation(async function (
      this: ConversationDatabase,
      commit,
    ) {
      started()
      await gate
      return save.call(this, commit)
    })
    await store.append(session.id, {
      type: 'assistant.parts.appended',
      messageId: 'assistant1',
      parts: [{ type: 'text', text: 'First ' }],
    })
    await began
    const received: JournalEvent[] = []
    store.subscribe((event) => received.push(event))
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        store.append(session.id, {
          type: 'assistant.parts.appended',
          messageId: 'assistant1',
          parts: [{ type: 'text', text: 'second' }],
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Live text waited for disk')), 1000)
        }),
      ])
      expect(received).toHaveLength(1)
    } finally {
      clearTimeout(timer)
      release()
    }
    await store.flush(session.id)
    await store.closeJournal(session.id)
    expect(
      (await store.load(session.id)).messages
        .at(-1)
        ?.parts.map((part) => ('text' in part ? part.text : ''))
        .join(''),
    ).toBe('First second')
  })

  it('retains a committed operation receipt and independent sequences across concurrent sessions', async () => {
    const store = createStore()
    await Promise.all(
      ['left', 'right'].map((id) =>
        store.append(id, { type: 'session.created', session: { ...session, id } }),
      ),
    )
    await store.append('left', {
      type: 'orchestration.operation.updated',
      operation: {
        operationId: 'spawn-once',
        method: 'session.spawn',
        fingerprint: 'same-request',
        status: 'completed',
        startedAt: 1,
        completedAt: 2,
        result: { childSessionId: 'right' },
        detail: null,
      },
    })
    await store.close()
    const reader = createStore()
    expect((await reader.load('left')).orchestration?.operations['spawn-once']?.result).toEqual({
      childSessionId: 'right',
    })
    expect((await reader.load('left')).lastSeq).toBe(1)
    expect((await reader.load('right')).lastSeq).toBe(0)
  })

  it('hydrates local prose in compact chunks without changing raw remote replay', async () => {
    const store = createStore()
    await createTurn(store)
    for (let n = 0; n < 100; n++)
      await store.append(session.id, {
        type: 'assistant.parts.appended',
        messageId: 'assistant1',
        parts: [{ type: 'text', text: 'word ' }],
      })
    await store.append(session.id, {
      type: 'assistant.parts.appended',
      messageId: 'assistant1',
      parts: [{ type: 'tool-call', callId: 'tool', name: 'read', argsJson: '{}' }],
    })
    for (let n = 0; n < 100; n++)
      await store.append(session.id, {
        type: 'assistant.parts.appended',
        messageId: 'assistant1',
        parts: [{ type: 'text', text: 'after ' }],
      })
    await store.append(session.id, {
      type: 'turn.settled',
      turnId: 'turn1',
      stopReason: 'completed',
      errorMessage: null,
    })
    const compact: JournalEvent[] = []
    for await (const chunk of store.readConversationChunks(session.id)) compact.push(...chunk)
    const raw = (await (await store.openJournal(session.id)).readAll()).flatMap((entry) =>
      entry.kind === 'value' ? [entry.value] : [],
    )
    expect(compact.length).toBeLessThan(10)
    expect(raw.length).toBeGreaterThan(200)
    expect(compact.at(-1)?.seq).toBe(raw.at(-1)?.seq)
    const message = projectEvents(compact).messages.at(-1)
    expect(message?.parts[0]).toEqual({ type: 'text', text: 'word '.repeat(100) })
    expect(message?.parts[1]).toEqual({
      type: 'tool-call',
      callId: 'tool',
      name: 'read',
      argsJson: '{}',
    })
    expect(
      message?.parts
        .slice(2)
        .map((part) => ('text' in part ? part.text : ''))
        .join(''),
    ).toBe('after '.repeat(100))
  })

  it('hydrates a long run of control events in a few frames instead of one per saved row', async () => {
    const store = createStore()
    await createTurn(store)
    for (let n = 0; n < 500; n++)
      await store.append(session.id, {
        type: 'child.session.acknowledged',
        childSessionId: `child${n}`,
        turnId: `turn${n}`,
        via: 'delivered',
      })
    const chunks: JournalEvent[][] = []
    for await (const chunk of store.readConversationChunks(session.id)) chunks.push(chunk)
    expect(chunks.flat()).toHaveLength(503)
    expect(chunks.length).toBeLessThanOrEqual(2)
  })

  it('skips acknowledgments repeated by the old delivery loop when hydrating, but not in raw replay', async () => {
    const first = createStore()
    await createTurn(first)
    const ack = (turnId: string) =>
      first.append(session.id, {
        type: 'child.session.acknowledged',
        childSessionId: 'child',
        turnId,
        via: 'delivered',
      })
    for (const turnId of ['a', 'b', 'a', 'b', 'a', 'b']) await ack(turnId)
    await first.close()
    // A database written before the repair existed.
    const raw = new DatabaseSync(join(rootDir, 'conversations.sqlite'))
    raw.exec('DROP INDEX conversation_history_order')
    raw.exec('ALTER TABLE conversation_history DROP COLUMN redundant')
    raw.close()

    const store = createStore()
    const hydrated: JournalEvent[] = []
    for await (const chunk of store.readConversationChunks(session.id)) hydrated.push(...chunk)
    expect(hydrated.map((event) => event.seq)).toEqual([0, 1, 2, 3, 4])
    const replay = (await (await store.openJournal(session.id)).readAll()).flatMap((entry) =>
      entry.kind === 'value' ? [entry.value.seq] : [],
    )
    expect(replay).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8])
    // New events keep flowing after the repair.
    await store.append(session.id, {
      type: 'turn.settled',
      turnId: 'turn1',
      stopReason: 'completed',
      errorMessage: null,
    })
    const after: JournalEvent[] = []
    for await (const chunk of store.readConversationChunks(session.id)) after.push(...chunk)
    expect(after.at(-1)?.seq).toBe(9)
  })

  /** A turn that streams, spawns a child mid-reply, and acknowledges its report twice. */
  async function delegatingTurn(store: SessionStore): Promise<void> {
    await createTurn(store)
    for (const text of ['Let me ', 'delegate.'])
      await store.append(session.id, {
        type: 'assistant.parts.appended',
        messageId: 'assistant1',
        parts: [{ type: 'text', text }],
      })
    await store.append(session.id, {
      type: 'assistant.parts.appended',
      messageId: 'assistant1',
      parts: [{ type: 'tool-call', callId: 'spawn', name: 'ari', argsJson: '{}' }],
    })
    await store.append(session.id, {
      type: 'child.session.spawned',
      childSessionId: 'child',
      title: 'Child',
      driverKind: 'codex',
      modelId: null,
      workspaceKind: 'project',
      branch: null,
    })
    await store.append(session.id, {
      type: 'assistant.parts.appended',
      messageId: 'assistant1',
      parts: [{ type: 'text', text: 'Waiting on it.' }],
    })
    for (let n = 0; n < 2; n++)
      await store.append(session.id, {
        type: 'child.session.acknowledged',
        childSessionId: 'child',
        turnId: 'childTurn',
        via: 'delivered',
      })
    await store.append(session.id, {
      type: 'turn.settled',
      turnId: 'turn1',
      stopReason: 'completed',
      errorMessage: null,
    })
  }
  const expectedControls = [
    { seq: 0, type: 'session.created', anchor: null },
    { seq: 1, type: 'turn.started', anchor: null },
    { seq: 6, type: 'child.session.spawned', anchor: { messageId: 'assistant1', parts: 3 } },
    { seq: 8, type: 'child.session.acknowledged', anchor: null },
    { seq: 10, type: 'turn.settled', anchor: null },
  ]
  const controlsOf = (snapshot: Awaited<ReturnType<SessionStore['readConversationSnapshot']>>) =>
    snapshot!.controls.map((row) => {
      const event = JSON.parse(row.json) as JournalEvent
      return {
        seq: event.seq,
        type: event.type,
        anchor: row.anchor === null ? null : (JSON.parse(row.anchor) as unknown),
      }
    })

  it('opens a transcript from saved messages and control events, without message deltas', async () => {
    const store = createStore()
    await delegatingTurn(store)
    const snapshot = await store.readConversationSnapshot(session.id)
    expect(snapshot?.lastSeq).toBe(10)
    expect(snapshot!.messages.map((json) => JSON.parse(json) as unknown)).toEqual(
      (await store.load(session.id)).messages,
    )
    // The repeated acknowledgment (seq 9) changes nothing and is left out.
    expect(controlsOf(snapshot)).toEqual(expectedControls)
  })

  it('includes text still waiting for its batched save', async () => {
    const store = createStore()
    await createTurn(store)
    await store.append(session.id, {
      type: 'assistant.parts.appended',
      messageId: 'assistant1',
      parts: [{ type: 'text', text: 'Streaming now' }],
    })
    const snapshot = await store.readConversationSnapshot(session.id)
    expect(snapshot?.lastSeq).toBe(3)
    expect(snapshot!.messages.at(-1)).toContain('Streaming now')
  })

  it('rebuilds the event rows of a conversation saved before they existed, once', async () => {
    const first = createStore()
    await delegatingTurn(first)
    await first.close()
    const raw = new DatabaseSync(join(rootDir, 'conversations.sqlite'))
    raw.exec('DELETE FROM conversation_events')
    raw.exec('UPDATE conversations SET controls_seq=-2')
    raw.close()

    const store = createStore()
    const history = vi.spyOn(ConversationDatabase.prototype, 'history')
    expect(controlsOf(await store.readConversationSnapshot(session.id))).toEqual(expectedControls)
    expect(history).toHaveBeenCalled()
    history.mockClear()
    await store.append(session.id, { type: 'session.updated', title: 'Renamed' })
    const again = await store.readConversationSnapshot(session.id)
    expect(history).not.toHaveBeenCalled()
    expect(controlsOf(again).at(-1)).toMatchObject({ seq: 11, type: 'session.updated' })
  })

  it('opens a legacy conversation from a snapshot once it is imported', async () => {
    const legacy = createStore('jsonl')
    await delegatingTurn(legacy)
    await legacy.closeJournal(session.id)
    const store = createStore()
    expect(controlsOf(await store.readConversationSnapshot(session.id))).toEqual(expectedControls)
  })

  it('destroys SQLite state and legacy data without resurrecting a migrated session', async () => {
    const legacy = createStore('jsonl')
    await createTurn(legacy)
    await legacy.closeJournal(session.id)
    const store = createStore()
    await store.load(session.id)
    await store.destroy(session.id)
    expect(await store.exists(session.id)).toBe(false)
    expect(await store.listSessions()).toEqual([])
  })
})
