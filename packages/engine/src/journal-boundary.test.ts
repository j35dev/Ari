import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Session } from '@ari/contracts/session'
import { Journal } from './journal'
import { SessionStore } from './session-store'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ari-journal-boundary-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('journal line boundaries', () => {
  it.each(['', '{"text":"hello"}\n', '{"text":"héllo 🌍"}', '{"torn":', ' \r'])(
    'terminates %j without discarding bytes and is idempotent',
    async (content) => {
      const path = join(dir, 'j.0000.jsonl')
      await writeFile(path, content)
      const journal = new Journal({ dir, name: 'j' })
      await journal.open()
      try {
        const added = content.length > 0 && !content.endsWith('\n') ? 1 : 0
        expect(await journal.ensureTrailingNewline()).toBe(added)
        expect(await journal.ensureTrailingNewline()).toBe(0)
        expect(await readFile(path, 'utf8')).toBe(content + (added ? '\n' : ''))
      } finally {
        await journal.close()
      }
    },
  )

  it('repairTail preserves a valid unterminated record and accounts for rotation', async () => {
    const content = '{"text":"héllo 🌍"}'
    await writeFile(join(dir, 'j.0000.jsonl'), content)
    const journal = new Journal({ dir, name: 'j', rotateBytes: Buffer.byteLength(content) + 1 })
    await journal.open()
    try {
      expect(await journal.repairTail()).toBe(0)
      await journal.append({ text: 'next' })
      expect(await journal.readAll()).toMatchObject([
        { kind: 'value', value: { text: 'héllo 🌍' } },
        { kind: 'value', value: { text: 'next' } },
      ])
      expect(await readFile(join(dir, 'j.0001.jsonl'), 'utf8')).toBe('{"text":"next"}\n')
    } finally {
      await journal.close()
    }
  })

  it('requires an open journal', async () => {
    await expect(new Journal({ dir, name: 'j' }).ensureTrailingNewline()).rejects.toThrow(
      'journal not opened',
    )
  })

  it.each(['', '{"torn":'])(
    'store recovery preserves prior events and quarantines only corrupt tail %j',
    async (tail) => {
      const session: Session = {
        id: 'sess_boundary',
        projectId: 'proj_1',
        title: 'Before',
        driverKind: 'claude',
        modelId: null,
        permissionMode: 'ask',
        status: 'idle',
        createdAt: 1,
        updatedAt: 1,
      }
      const store = new SessionStore({ rootDir: dir })
      await store.append(session.id, { type: 'session.created', session })
      await store.closeJournal(session.id)
      const path = join(dir, session.id, 'journal.0000.jsonl')
      const original = await readFile(path, 'utf8')
      await writeFile(path, tail ? original + tail : original.trimEnd())
      try {
        await store.append(session.id, { type: 'session.updated', title: 'After' })
        await store.closeJournal(session.id)
        const model = await store.load(session.id)
        expect(model.session?.title).toBe('After')
        expect(model.lastSeq).toBe(1)
        expect(store.replayDiagnostics(session.id).rejectedCount).toBe(tail ? 1 : 0)
        const index: unknown = JSON.parse(
          await readFile(join(dir, session.id, 'index.json'), 'utf8'),
        )
        expect(index).toMatchObject({ journalBytes: (await stat(path)).size })
        if (tail) {
          const rejected = await readFile(join(dir, session.id, 'journal.rejected.jsonl'), 'utf8')
          expect(rejected.trim().split('\n')).toHaveLength(1)
          expect(rejected).toContain('torn')
        }
      } finally {
        await store.closeJournal(session.id)
      }
    },
  )
})
