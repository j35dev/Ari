import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Session } from '@ari/contracts/session'
import type { UnstampedEvent } from './projection'
import { SessionStore } from './session-store'
import { Journal } from './journal'

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof fs>()),
}))

const actualFs = await vi.importActual<typeof fs>('node:fs/promises')

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
  vi.restoreAllMocks()
  await rm(rootDir, { recursive: true, force: true })
})

describe('SessionStore', () => {
  it('does not treat an unreadable session root as a new installation', async () => {
    const path = join(rootDir, 'not-a-directory')
    await writeFile(path, 'preserve')
    const broken = new SessionStore({ rootDir: path })
    await expect(broken.listSessions()).rejects.toThrow()
    await rm(path)
    expect(await broken.listSessions()).toEqual([])
  })

  it('ignores entries that are not session directories and still lists the rest', async () => {
    await writeFile(join(rootDir, 'broken-entry'), 'not a session directory')
    await mkdir(join(rootDir, 'not a session'))
    expect(await store.listSessions()).toEqual([])
    await store.append(session.id, { type: 'session.created', session })
    expect((await store.listSessions()).map((entry) => entry.id)).toEqual([session.id])
  })
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
      message: {
        id: 'm1',
        sessionId: s2.id,
        turnId: 'turn_1',
        role: 'user',
        parts: [{ type: 'text', text: 'hi' }],
        createdAt: 2001,
      },
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
    await j2.append({
      type: 'session.updated',
      title: 'Renamed',
      seq: 2,
      at: 2500,
      sessionId: s2.id,
    })

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

  describe('streamed parts', () => {
    const part = (text: string): UnstampedEvent => ({
      type: 'assistant.parts.appended',
      messageId: 'm1',
      parts: [{ type: 'text', text }],
    })
    const sidecar = async (): Promise<{ journalBytes: number }> => {
      const { readFile } = await import('node:fs/promises')
      return JSON.parse(await readFile(join(rootDir, session.id, 'index.json'), 'utf8')) as {
        journalBytes: number
      }
    }

    it('leaves the sidecar and the fsync to the next event that is not a part', async () => {
      await store.append(session.id, { type: 'session.created', session })
      await store.append(session.id, { type: 'turn.started', turnId: 'turn_1' })
      const before = await sidecar()
      const flush = vi.spyOn(await store.openJournal(session.id), 'flush')

      await store.append(session.id, part('hel'))
      await store.append(session.id, part('lo'))
      expect(await sidecar()).toEqual(before)
      expect(flush).not.toHaveBeenCalled()
      // The streamed text is journaled and folded all the same.
      expect((await store.load(session.id)).messages[0]?.parts).toHaveLength(2)

      await store.append(session.id, {
        type: 'turn.settled',
        turnId: 'turn_1',
        stopReason: 'completed',
        errorMessage: null,
      })
      expect(flush).toHaveBeenCalledTimes(1)
      expect((await sidecar()).journalBytes).toBeGreaterThan(before.journalBytes)
      // Caught up: a cold reader trusts the sidecar without replaying.
      const cold = new SessionStore({ rootDir })
      const replay = vi.spyOn(await cold.openJournal(session.id), 'readAll')
      expect(await cold.listSessions()).toHaveLength(1)
      expect(replay).not.toHaveBeenCalled()
    })

    it('lists a streaming session from memory while its sidecar trails', async () => {
      await store.append(session.id, { type: 'session.created', session })
      await store.listSessions()
      const replay = vi.spyOn(await store.openJournal(session.id), 'readAll')

      await store.append(session.id, part('still streaming'))
      expect(await store.listSessions()).toHaveLength(1)
      expect(replay).not.toHaveBeenCalled()
    })

    it('writes the trailing sidecar when the journal closes mid-stream', async () => {
      await store.append(session.id, { type: 'session.created', session })
      const before = await sidecar()
      await store.append(session.id, part('cut short'))

      await store.closeJournal(session.id)
      expect((await sidecar()).journalBytes).toBeGreaterThan(before.journalBytes)
    })
  })

  describe('index preview', () => {
    it('truncates huge transcript text into the stored preview cap', async () => {
      const big = 'x'.repeat(600_000)
      await store.append(session.id, { type: 'session.created', session })
      await store.append(session.id, {
        type: 'user.message.added',
        message: {
          id: 'm_big',
          sessionId: session.id,
          turnId: 'turn_1',
          role: 'user',
          parts: [{ type: 'text', text: big }],
          createdAt: 1001,
        },
      })
      const list = await store.listSessions()
      expect(list[0]?.lastMessagePreview?.length).toBe(160)
      expect(await store.load(session.id).then((m) => m.messages[0]?.parts)).toHaveLength(1)
    })

    it('collapses whitespace without re-sweeping megabytes of formatting', async () => {
      const word = 'a'.repeat(8)
      const huge = `${word}${'  \n\r'.repeat(4)}`.repeat(400)
      await store.append(session.id, { type: 'session.created', session })
      await store.append(session.id, {
        type: 'user.message.added',
        message: {
          id: 'm_ws',
          sessionId: session.id,
          turnId: 'turn_1',
          role: 'user',
          parts: [{ type: 'text', text: huge }],
          createdAt: 1002,
        },
      })
      const preview = (await store.listSessions())[0]?.lastMessagePreview
      expect(preview).not.toBeNull()
      expect(preview?.length).toBeLessThanOrEqual(160)
      // Runs of whitespace became single spaces; no newline survives.
      expect(preview?.split(' ').length).toBeGreaterThan(8)
      expect(preview?.includes('\n')).toBe(false)
      expect(preview?.trim()).toBe(preview)
    }, 20000)

    it('skips leading whitespace before the preview window, across parts', async () => {
      const body = 'b'.repeat(200)
      await store.append(session.id, { type: 'session.created', session })
      await store.append(session.id, {
        type: 'user.message.added',
        message: {
          id: 'm_indent',
          sessionId: session.id,
          turnId: 'turn_1',
          role: 'user',
          parts: [
            { type: 'text', text: ' \n'.repeat(400) },
            { type: 'text', text: `\t\t${body}` },
          ],
          createdAt: 1003,
        },
      })
      const preview = (await store.listSessions())[0]?.lastMessagePreview
      expect(preview).toBe(body.slice(0, 160))
    })
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

  it('serves usage.summary from sidecar indexes without replaying journals', async () => {
    const s2: Session = {
      ...session,
      id: 'sess_test2',
      title: 'Second',
      driverKind: 'codex',
      updatedAt: 3000,
    }
    await store.append(session.id, { type: 'session.created', session })
    await store.append(session.id, {
      type: 'usage.recorded',
      inputTokens: 100,
      outputTokens: 40,
      costUsd: 0.02,
    })
    await store.append(s2.id, { type: 'session.created', session: s2 })
    await store.append(s2.id, {
      type: 'usage.recorded',
      inputTokens: 50,
      outputTokens: 10,
      costUsd: null,
    })

    // Warm-up listing builds the sidecar indexes (may replay).
    expect(await store.listSessions()).toHaveLength(2)

    const spies = []
    for (const id of [session.id, s2.id]) {
      const j = await store.openJournal(id)
      spies.push(vi.spyOn(j, 'readAll'))
    }

    const summary = await store.usageSummary()
    // Warm path reads only the sidecars — zero journal replays.
    expect(spies.every((s) => s.mock.calls.length === 0)).toBe(true)
    expect(summary.totals).toEqual({ inputTokens: 150, outputTokens: 50, costUsd: 0.02 })
    expect(summary.rows.map((r) => r.sessionId)).toEqual(['sess_test2', 'sess_test1'])
    expect(summary.rows[1]).toEqual({
      sessionId: session.id,
      title: 'Test session',
      driverKind: 'claude',
      updatedAt: 1000,
      inputTokens: 100,
      outputTokens: 40,
      costUsd: 0.02,
    })
  })

  it('omits sessions without usage and reports empty totals', async () => {
    await store.append(session.id, { type: 'session.created', session })
    const summary = await store.usageSummary()
    expect(summary.rows).toEqual([])
    expect(summary.totals).toEqual({ inputTokens: 0, outputTokens: 0, costUsd: null })
  })

  it('migrates pre-M18.5 sidecar indexes via replay and rewrites them', async () => {
    await store.append(session.id, { type: 'session.created', session })
    await store.append(session.id, {
      type: 'usage.recorded',
      inputTokens: 7,
      outputTokens: 3,
      costUsd: null,
    })
    expect(await store.listSessions()).toHaveLength(1)

    // Hand-rollback to the v1 shape (correct bytes, no usage fields).
    const { readFile, writeFile } = await import('node:fs/promises')
    const indexPath = join(rootDir, session.id, 'index.json')
    const legacy = JSON.parse(await readFile(indexPath, 'utf8')) as Record<string, unknown>
    delete legacy['driverKind']
    delete legacy['inputTokens']
    delete legacy['outputTokens']
    delete legacy['costUsd']
    legacy['version'] = 1
    await writeFile(indexPath, JSON.stringify(legacy), 'utf8')

    // Cold reader rejects the old version, replays once, and still answers.
    const fresh = new SessionStore({ rootDir })
    const summary = await fresh.usageSummary()
    expect(summary.totals.inputTokens).toBe(7)
    expect(summary.totals.outputTokens).toBe(3)

    // The repair persisted as a current index carrying the token pair.
    const migrated = JSON.parse(await readFile(indexPath, 'utf8')) as Record<string, unknown>
    expect(migrated['version']).toBe(5)
    expect(migrated['inputTokens']).toBe(7)
    expect(migrated['outputTokens']).toBe(3)
  })

  it('fills v5 lead identity without replay and leaves other fields until journal growth', async () => {
    const lead = {
      ...session,
      lead: true as const,
      effort: 'high',
      permissionMode: 'full' as const,
      createdBy: { kind: 'session' as const, sessionId: 'old-aria' },
    }
    await store.append(lead.id, { type: 'session.created', session: lead })
    await store.listSessions()
    const { readFile, writeFile } = await import('node:fs/promises')
    const path = join(rootDir, lead.id, 'index.json')
    const old = JSON.parse(await readFile(path, 'utf8')) as {
      version: number
      hierarchy: Record<string, unknown>
    }
    old.version = 5
    for (const key of ['createdAt', 'permissionMode', 'effort', 'lead', 'createdBy'])
      delete old.hierarchy[key]
    await writeFile(path, JSON.stringify(old))
    await store.closeJournal(lead.id)
    const fresh = new SessionStore({ rootDir })
    const replay = vi.spyOn(Journal.prototype, 'readAll')
    const opening = vi.spyOn(fresh, 'openJournal')
    try {
      const [row] = await fresh.listSessions()
      expect(row).toMatchObject({ lead: true, createdBy: lead.createdBy })
      expect(row).not.toHaveProperty('permissionMode')
      expect(replay).not.toHaveBeenCalled()
      expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
        ...old,
        leadIdentityRead: true,
        hierarchy: { ...old.hierarchy, lead: true, createdBy: lead.createdBy },
      })
      const head = vi.spyOn(fs, 'open')
      expect((await new SessionStore({ rootDir }).listSessions())[0]).toMatchObject({
        lead: true,
        createdBy: lead.createdBy,
      })
      expect(head).not.toHaveBeenCalled()
      head.mockRestore()
      const { appendFile } = await import('node:fs/promises')
      await appendFile(
        join(rootDir, lead.id, 'journal.0000.jsonl'),
        JSON.stringify({
          type: 'session.updated',
          title: 'Changed',
          sessionId: lead.id,
          seq: 1,
          at: 2000,
        }) + '\n',
      )
      expect((await fresh.listSessions())[0]).toMatchObject({
        createdAt: lead.createdAt,
        permissionMode: 'full',
        effort: 'high',
        lead: true,
        createdBy: { kind: 'session', sessionId: 'old-aria' },
      })
      expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ version: 5 })
      expect(replay).toHaveBeenCalledOnce()
      expect(opening).not.toHaveBeenCalled()
      // Rebuilds did not cache the transcript: an explicit load still replays it.
      await fresh.load(lead.id)
      expect(replay).toHaveBeenCalledTimes(2)
    } finally {
      await fresh.closeJournal(lead.id)
      replay.mockRestore()
      opening.mockRestore()
    }
  })

  it('shares concurrent index repairs without retaining journals or full models', async () => {
    await store.append(session.id, { type: 'session.created', session })
    await store.closeJournal(session.id)
    await writeFile(join(rootDir, session.id, 'index.json'), '{bad')
    const fresh = new SessionStore({ rootDir })
    const replay = vi.spyOn(Journal.prototype, 'readAll')
    const opening = vi.spyOn(fresh, 'openJournal')
    try {
      await Promise.all([fresh.listSessions(), fresh.usageSummary(), fresh.listSessions()])
      expect(replay).toHaveBeenCalledOnce()
      expect(opening).not.toHaveBeenCalled()
      await fresh.load(session.id)
      expect(replay).toHaveBeenCalledTimes(2)
    } finally {
      await fresh.closeJournal(session.id)
      replay.mockRestore()
      opening.mockRestore()
    }
  })

  it('preserves an already-open journal without adding a model cache during repair', async () => {
    await store.append(session.id, { type: 'session.created', session })
    await store.closeJournal(session.id)
    await writeFile(join(rootDir, session.id, 'index.json'), '{bad')
    const fresh = new SessionStore({ rootDir })
    const opened = await fresh.openJournal(session.id)
    const replay = vi.spyOn(opened, 'readAll')
    try {
      await fresh.listSessions()
      expect(await fresh.openJournal(session.id)).toBe(opened)
      await fresh.load(session.id)
      expect(replay).toHaveBeenCalledTimes(2)
    } finally {
      await fresh.closeJournal(session.id)
    }
  })

  it('checks and reads deleted sessions without creating their directories', async () => {
    expect(await store.exists('deleted')).toBe(false)
    expect(await store.loadExisting('deleted')).toBeNull()
    const { readdir } = await import('node:fs/promises')
    expect(await readdir(rootDir)).toEqual([])
  })

  it.each(['cached', 'listed', 'loaded'])(
    'checks %s sessions without reading their journal heads',
    async (kind) => {
      await store.append(session.id, { type: 'session.created', session })
      await store.closeJournal(session.id)
      const fresh = kind === 'cached' ? store : new SessionStore({ rootDir })
      if (kind === 'listed') await fresh.listSessions()
      if (kind === 'loaded') await fresh.load(session.id)
      const open = vi.spyOn(fs, 'open')
      try {
        expect(await fresh.exists(session.id)).toBe(true)
        expect(await fresh.exists(session.id)).toBe(true)
        expect(open).not.toHaveBeenCalled()
      } finally {
        open.mockRestore()
        await fresh.closeJournal(session.id)
      }
    },
  )

  it('shares and caches positive head reads until the session is destroyed', async () => {
    await store.append(session.id, { type: 'session.created', session })
    await store.closeJournal(session.id)
    const fresh = new SessionStore({ rootDir })
    const open = vi.spyOn(fs, 'open')
    expect(
      await Promise.all([
        fresh.exists(session.id),
        fresh.exists(session.id),
        fresh.exists(session.id),
      ]),
    ).toEqual([true, true, true])
    expect(await fresh.exists(session.id)).toBe(true)
    expect(open).toHaveBeenCalledTimes(1)
    await fresh.destroy(session.id)
    expect(await fresh.exists(session.id)).toBe(false)
    const replacement = new SessionStore({ rootDir })
    await replacement.append(session.id, { type: 'session.created', session })
    await replacement.closeJournal(session.id)
    open.mockClear()
    expect(await fresh.exists(session.id)).toBe(true)
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('does not restore a destroyed session to the existence cache when an earlier index read finishes', async () => {
    await store.append(session.id, { type: 'session.created', session })
    await store.closeJournal(session.id)
    const path = join(rootDir, session.id, 'index.json')
    const readFile = actualFs.readFile.bind(actualFs)
    let finish!: () => void
    let started!: () => void
    const gate = new Promise<void>((resolve) => {
      finish = resolve
    })
    const reading = new Promise<void>((resolve) => {
      started = resolve
    })
    vi.spyOn(fs, 'readFile').mockImplementation(async (name, options) => {
      const text = await readFile(name, options)
      if (name === path) {
        started()
        await gate
      }
      return text
    })
    const fresh = new SessionStore({ rootDir })
    const listing = fresh.listSessions()
    try {
      await reading
      await fresh.destroy(session.id)
      finish()
      await listing
      expect(await fresh.exists(session.id)).toBe(false)
      expect(await fresh.loadExisting(session.id)).toBeNull()
      expect(await fs.readdir(rootDir)).toEqual([])
    } finally {
      finish()
      await listing
    }
  })

  it('maintains the current Aria lookup from listings, archives and destruction', async () => {
    for (const [id, updatedAt] of [
      ['aria1', 1],
      ['aria2', 2],
    ] as const) {
      await store.append(id, {
        type: 'session.created',
        session: { ...session, id, projectId: 'helm', updatedAt },
      })
      await store.closeJournal(id)
    }
    const fresh = new SessionStore({ rootDir })
    await fresh.listSessions()
    const listing = vi
      .spyOn(fresh, 'listSessions')
      .mockRejectedValue(new Error('Unexpected listing'))
    expect(fresh.currentHelmSession()).toBe('aria2')
    await fresh.append('aria2', { type: 'session.updated', archived: true })
    expect(fresh.currentHelmSession()).toBe('aria1')
    await fresh.destroy('aria1')
    expect(fresh.currentHelmSession()).toBeNull()
    expect(listing).not.toHaveBeenCalled()
    await fresh.closeJournal('aria2')
  })

  it.each(['invalid-head', 'read-error'])(
    'keeps an indexed session with unknown lead identity after %s',
    async (failure) => {
      await store.append(session.id, { type: 'session.created', session })
      await store.closeJournal(session.id)
      const path = join(rootDir, session.id, 'index.json')
      const index = JSON.parse(await fs.readFile(path, 'utf8')) as {
        hierarchy: Record<string, unknown>
        journalBytes: number
      }
      delete index.hierarchy.lead
      delete index.hierarchy.createdBy
      if (failure === 'invalid-head') {
        const journal = join(rootDir, session.id, 'journal.0000.jsonl')
        const text = '{broken}\n' + (await fs.readFile(journal, 'utf8'))
        await writeFile(journal, text)
        index.journalBytes = Buffer.byteLength(text)
      }
      await writeFile(path, JSON.stringify(index))
      const open = vi.spyOn(fs, 'open')
      if (failure === 'read-error')
        open.mockRejectedValueOnce(Object.assign(new Error('Busy head'), { code: 'EACCES' }))
      const fresh = new SessionStore({ rootDir })
      const [row] = await fresh.listSessions()
      expect(row).toMatchObject({ id: session.id, title: session.title })
      expect(row).not.toHaveProperty('lead')
      expect(row).not.toHaveProperty('createdBy')
      expect(await fresh.exists(session.id)).toBe(true)
      expect(open).toHaveBeenCalledTimes(1)
      expect(JSON.parse(await fs.readFile(path, 'utf8'))).toMatchObject({
        version: 5,
        leadIdentityRead: true,
      })
      open.mockClear()
      expect(await new SessionStore({ rootDir }).listSessions()).toEqual([row])
      expect(open).not.toHaveBeenCalled()
    },
  )

  it('replays a session behind an invalid first line when its index needs repair', async () => {
    await store.append(session.id, { type: 'session.created', session })
    await store.closeJournal(session.id)
    const journal = join(rootDir, session.id, 'journal.0000.jsonl')
    await writeFile(journal, '{broken}\n' + (await fs.readFile(journal, 'utf8')))
    await writeFile(join(rootDir, session.id, 'index.json'), '{bad')
    const fresh = new SessionStore({ rootDir })
    const open = vi.spyOn(fresh, 'openJournal')
    expect((await fresh.listSessions())[0]).toMatchObject({ id: session.id, title: session.title })
    expect(await fresh.exists(session.id)).toBe(true)
    expect(open).not.toHaveBeenCalled()
  })

  it('reports transient session-directory read errors instead of silently dropping the row', async () => {
    await store.append(session.id, { type: 'session.created', session })
    await store.closeJournal(session.id)
    const directory = join(rootDir, session.id)
    const readdir = actualFs.readdir.bind(actualFs)
    vi.spyOn(fs, 'readdir').mockImplementation((path, options) => {
      if (path === directory)
        return Promise.reject(Object.assign(new Error('Busy directory'), { code: 'EACCES' }))
      return readdir(path, options)
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await expect(new SessionStore({ rootDir }).listSessions()).rejects.toThrow(
      'Saved sessions could not be read.',
    )
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('session could not be listed'),
      expect.objectContaining({ sessionId: session.id }),
    )
  })

  it.each(['directory', 'empty-journal', 'uncreated-journal', 'sidecar-only'])(
    'treats a leftover %s as nonexistent without changing any files',
    async (kind) => {
      const { readdir, readFile } = await import('node:fs/promises')
      const path = join(rootDir, session.id)
      await mkdir(path)
      if (kind === 'empty-journal') await writeFile(join(path, 'journal.0000.jsonl'), '')
      if (kind === 'uncreated-journal')
        await writeFile(
          join(path, 'journal.0000.jsonl'),
          JSON.stringify({
            type: 'session.updated',
            sessionId: session.id,
            seq: 0,
            at: 1,
            title: 'Ghost',
          }) + '\n',
        )
      if (kind === 'sidecar-only') await writeFile(join(path, 'index.json'), '{}')
      const before = await Promise.all(
        (await readdir(path)).map(async (name) => [name, await readFile(join(path, name), 'utf8')]),
      )
      const opening = vi.spyOn(store, 'openJournal')
      expect(await store.exists(session.id)).toBe(false)
      expect(await store.loadExisting(session.id)).toBeNull()
      expect(await store.listSessions()).toEqual([])
      expect(opening).not.toHaveBeenCalled()
      expect(
        await Promise.all(
          (await readdir(path)).map(async (name) => [
            name,
            await readFile(join(path, name), 'utf8'),
          ]),
        ),
      ).toEqual(before)
      opening.mockRestore()
    },
  )

  it('keeps the pre-replay byte count when a writer appends during index repair', async () => {
    const { appendFile, readFile, stat } = await import('node:fs/promises')
    await store.append(session.id, { type: 'session.created', session })
    await store.closeJournal(session.id)
    await writeFile(join(rootDir, session.id, 'index.json'), '{bad')
    const path = join(rootDir, session.id, 'journal.0000.jsonl')
    const before = (await stat(path)).size
    const journal = new Journal({ dir: join(rootDir, session.id), name: 'journal' })
    const readAll = journal.readAll.bind(journal)
    const replay = vi.spyOn(Journal.prototype, 'readAll').mockImplementationOnce(async () => {
      const events = await readAll()
      await appendFile(
        path,
        JSON.stringify({
          type: 'session.updated',
          sessionId: session.id,
          seq: 1,
          at: 2000,
          title: 'Concurrent title',
        }) + '\n',
      )
      return events
    })
    const fresh = new SessionStore({ rootDir })
    try {
      expect((await fresh.listSessions())[0]?.title).toBe(session.title)
      expect(
        JSON.parse(await readFile(join(rootDir, session.id, 'index.json'), 'utf8')),
      ).toMatchObject({ journalBytes: before })
      expect((await fresh.listSessions())[0]?.title).toBe('Concurrent title')
      expect(replay).toHaveBeenCalledTimes(2)
    } finally {
      replay.mockRestore()
    }
  })

  it('serves a warm listing while an append is waiting in the session queue', async () => {
    await store.append(session.id, { type: 'session.created', session })
    let finish!: () => void
    const gate = new Promise<void>((resolve) => {
      finish = resolve
    })
    const original = store.openJournal.bind(store)
    const opening = vi.spyOn(store, 'openJournal').mockImplementationOnce(async (id) => {
      await gate
      return original(id)
    })
    const appending = store.append(session.id, { type: 'turn.started', turnId: 'waiting' })
    let listed = false
    try {
      await vi.waitFor(() => expect(opening).toHaveBeenCalledOnce())
      const listing = store.listSessions().then((rows) => {
        listed = true
        return rows
      })
      await vi.waitFor(() => expect(listed).toBe(true))
      expect(await listing).toHaveLength(1)
    } finally {
      finish()
      await appending
      opening.mockRestore()
    }
  })

  it('reads an index entry that still carries a removed Hive botId, and drops it', async () => {
    await store.append(session.id, { type: 'session.created', session })
    expect(await store.listSessions()).toHaveLength(1)

    const { readFile, writeFile } = await import('node:fs/promises')
    const indexPath = join(rootDir, session.id, 'index.json')
    const legacy = JSON.parse(await readFile(indexPath, 'utf8')) as Record<string, unknown>
    legacy['botId'] = 'bot_ada'
    await writeFile(indexPath, JSON.stringify(legacy), 'utf8')

    const fresh = new SessionStore({ rootDir })
    const [row] = await fresh.listSessions()
    expect(row?.id).toBe(session.id)
    expect(row).not.toHaveProperty('botId')
  })

  it('indexes what a session last said as its one-line roster preview', async () => {
    await store.append(session.id, { type: 'session.created', session })
    // Nothing said yet: the roster has no line to show.
    expect((await store.listSessions())[0]?.lastMessagePreview).toBeNull()

    await store.append(session.id, { type: 'turn.started', turnId: 'turn_1' })
    await store.append(session.id, {
      type: 'assistant.parts.appended',
      messageId: 'msg_1',
      parts: [
        { type: 'thinking', text: 'weighing options' },
        { type: 'text', text: 'Read  the   file' },
        { type: 'text', text: '\nand fixed it.' },
      ],
    })
    expect((await store.listSessions())[0]?.lastMessagePreview).toBe('Read the file and fixed it.')

    // A turn that adds only reasoning is not something the session "said".
    await store.append(session.id, {
      type: 'assistant.parts.appended',
      messageId: 'msg_2',
      parts: [{ type: 'thinking', text: 'considering the failure' }],
    })
    expect((await store.listSessions())[0]?.lastMessagePreview).toBe('Read the file and fixed it.')

    // Cold reader: the preview lives in the index, so it survives a restart
    // without replaying the journal behind it.
    const cold = new SessionStore({ rootDir })
    expect((await cold.listSessions())[0]?.lastMessagePreview).toBe('Read the file and fixed it.')
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

    // The stale version forces one authoritative replay that repairs to the
    // current index version.
    const fresh = new SessionStore({ rootDir })
    const list = await fresh.listSessions()
    expect(list).toHaveLength(1)
    expect(list[0]?.title).toBe('Test session')
    expect(list[0]?.pinned).toBe(true)
    expect(list[0]?.archived).toBe(false)
  })

  it('folds appends into the cached read model instead of replaying per event', async () => {
    await store.append(session.id, { type: 'session.created', session })
    await store.load(session.id) // one authoritative warm-up replay

    const j = await store.openJournal(session.id)
    const spy = vi.spyOn(j, 'readAll')

    // A streamed turn appends dozens of events; none may re-read the journal.
    for (let i = 0; i < 25; i++) {
      await store.append(session.id, { type: 'turn.started', turnId: `turn_${i}` })
    }
    expect(spy).not.toHaveBeenCalled()

    // The cached model stays coherent and `load` serves it without a replay.
    const model = await store.load(session.id)
    expect(spy).not.toHaveBeenCalled()
    expect(model.lastSeq).toBe(25)
    expect(model.activeTurnId).toBe('turn_24')

    // closeJournal drops the cache so a reopened journal replays fresh.
    await store.closeJournal(session.id)
    const reopened = await store.openJournal(session.id)
    const spy2 = vi.spyOn(reopened, 'readAll')
    await store.append(session.id, {
      type: 'turn.settled',
      turnId: 'turn_0',
      stopReason: 'completed',
      errorMessage: null,
    })
    expect(spy2).toHaveBeenCalledTimes(1) // cache was dropped: one fresh replay
    expect(await store.nextSeq(session.id)).toBe(27) // then folds in memory
    expect(spy2).toHaveBeenCalledTimes(1)
  })

  it('serves repeated loads from memory and matches a cold replay', async () => {
    await store.append(session.id, { type: 'session.created', session })
    await store.append(session.id, { type: 'turn.started', turnId: 'turn_1' })
    await store.append(session.id, {
      type: 'assistant.parts.appended',
      messageId: 'm1',
      parts: [{ type: 'text', text: 'hel' }],
    })
    const spy = vi.spyOn(await store.openJournal(session.id), 'readAll')

    const first = await store.load(session.id)
    const second = await store.load(session.id)
    expect(spy).not.toHaveBeenCalled()
    expect(second).toBe(first)

    // Appends replace the cached model, so an earlier snapshot never changes.
    await store.append(session.id, {
      type: 'assistant.parts.appended',
      messageId: 'm1',
      parts: [{ type: 'text', text: 'lo' }],
    })
    const after = await store.load(session.id)
    expect(first.messages[0]?.parts).toHaveLength(1)
    expect(after.messages[0]?.parts).toHaveLength(2)
    expect(spy).not.toHaveBeenCalled()

    await store.closeJournal(session.id)
    expect(await new SessionStore({ rootDir }).load(session.id)).toEqual(after)
  })

  it('caches the schema-parsed event so memory matches a replay', async () => {
    await store.append(session.id, { type: 'session.created', session })
    const image = {
      type: 'image',
      attachmentId: 'att_1',
      name: 'a.png',
      mimeType: 'image/png',
      size: 2,
    }
    await store.append(session.id, {
      type: 'assistant.parts.appended',
      messageId: 'm1',
      parts: [{ ...image, id: 'att_1' } as typeof image & { type: 'image' }],
    })
    const live = await store.load(session.id)
    expect(live.messages[0]?.parts).toEqual([image])
    await store.closeJournal(session.id)
    expect(await new SessionStore({ rootDir }).load(session.id)).toEqual(live)
  })

  it('waits for an in-flight append before serving the cached model', async () => {
    await store.append(session.id, { type: 'session.created', session })
    const appending = store.append(session.id, { type: 'turn.started', turnId: 'turn_1' })
    const model = await store.load(session.id)
    await appending
    expect(model.activeTurnId).toBe('turn_1')
  })

  it('serializes destroy against an in-flight append so the session cannot resurrect', async () => {
    await store.append(session.id, { type: 'session.created', session })
    await store.closeJournal(session.id)
    const original = store.openJournal.bind(store)
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    store.openJournal = async (id) => {
      await gate
      return original(id)
    }
    const appending = store.append(session.id, {
      type: 'turn.started',
      turnId: 'turn_race',
    })
    await Promise.resolve()
    const destroying = store.destroy(session.id)
    release()
    await Promise.all([appending, destroying])
    const { readdir } = await import('node:fs/promises')
    expect(await readdir(rootDir)).toEqual([])
    expect(await store.listSessions()).toEqual([])
  })

  it('rejects destroy of a missing session', async () => {
    await expect(store.destroy('sess_missing')).rejects.toMatchObject({ code: 'session_not_found' })
  })

  // Two overlapping first opens used to build two journals for one session and
  // leak the loser's file handle until GC (Node's fd-close warning, #332).
  it('hands concurrent callers of a first open the same journal', async () => {
    const [a, b] = await Promise.all([store.openJournal(session.id), store.openJournal(session.id)])
    expect(a).toBe(b)
    expect(await store.openJournal(session.id)).toBe(a)

    await store.append(session.id, { type: 'session.created', session })
    expect((await store.load(session.id)).session?.id).toBe(session.id)
  })

  it('closes a journal whose first open was still in flight', async () => {
    const opening = store.openJournal(session.id)
    const closing = store.closeJournal(session.id)
    await Promise.all([opening, closing])

    // The closed journal cannot append, so a later append must open a fresh one.
    const reopened = await store.openJournal(session.id)
    expect(reopened).not.toBe(await opening)
    await store.append(session.id, { type: 'session.created', session })
    expect((await store.load(session.id)).session?.id).toBe(session.id)
  })
})
