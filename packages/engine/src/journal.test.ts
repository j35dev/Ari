import { mkdtemp, rm, writeFile, appendFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Journal, destroyJournal } from './journal'

interface TestEvent {
  seq: number
  kind: string
}

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ari-journal-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('Journal', () => {
  it('appends and reads back entries in order', async () => {
    const journal = new Journal<TestEvent>({ dir, name: 'j' })
    await journal.open()
    await journal.append({ seq: 0, kind: 'a' })
    await journal.append({ seq: 1, kind: 'b' })
    await journal.close()

    const reopened = new Journal<TestEvent>({ dir, name: 'j' })
    await reopened.open()
    const entries = await reopened.readAll()
    expect(entries).toHaveLength(2)
    expect(entries[0]).toMatchObject({ kind: 'value', line: 1, value: { seq: 0, kind: 'a' } })
    expect(entries[1]).toMatchObject({ kind: 'value', line: 2, value: { seq: 1, kind: 'b' } })
    await reopened.close()
  })

  it('rotates segments when the size cap is exceeded', async () => {
    const journal = new Journal<TestEvent>({ dir, name: 'j', rotateBytes: 40 })
    await journal.open()
    for (let i = 0; i < 10; i++) await journal.append({ seq: i, kind: 'rotate-test' })
    await journal.close()

    const reopened = new Journal<TestEvent>({ dir, name: 'j' })
    await reopened.open()
    const entries = await reopened.readAll()
    expect(entries).toHaveLength(10)
    expect(entries.every((e) => e.kind === 'value')).toBe(true)
    await reopened.close()
  })

  it('reports a torn tail as an error entry without losing earlier data', async () => {
    const segment = join(dir, 'j.0000.jsonl')
    await writeFile(segment, '{"seq":0,"kind":"ok"}\n{"seq":1,"kin')
    const journal = new Journal<TestEvent>({ dir, name: 'j' })
    await journal.open()
    const entries = await journal.readAll()
    expect(entries[0]?.kind).toBe('value')
    expect(entries[1]?.kind).toBe('error')
    await journal.close()
  })

  it('repairTail truncates the corrupt line and appends stay parseable', async () => {
    const segment = join(dir, 'j.0000.jsonl')
    await writeFile(segment, '{"seq":0,"kind":"ok"}\n{"seq":1,"kin')
    const journal = new Journal<TestEvent>({ dir, name: 'j' })
    await journal.open()
    const truncated = await journal.repairTail()
    expect(truncated).toBeGreaterThan(0)
    await journal.append({ seq: 2, kind: 'after-repair' })
    await journal.close()

    const reopened = new Journal<TestEvent>({ dir, name: 'j' })
    await reopened.open()
    const entries = await reopened.readAll()
    expect(entries).toHaveLength(2)
    expect(entries.every((e) => e.kind === 'value')).toBe(true)
    if (entries[1]?.kind === 'value') expect(entries[1].value.seq).toBe(2)
    await reopened.close()
  })

  it('destroyJournal removes every segment', async () => {
    const journal = new Journal<TestEvent>({ dir, name: 'j', rotateBytes: 20 })
    await journal.open()
    for (let i = 0; i < 6; i++) await journal.append({ seq: i, kind: 'x' })
    await journal.close()
    await destroyJournal(dir, 'j')
    const fresh = new Journal<TestEvent>({ dir, name: 'j' })
    await fresh.open()
    expect(await fresh.readAll()).toHaveLength(0)
    await fresh.close()
  })

  it('appends after reopen continue the existing sequence file position', async () => {
    const first = new Journal<TestEvent>({ dir, name: 'j' })
    await first.open()
    await first.append({ seq: 0, kind: 'one' })
    await first.close()

    // Simulate an external partial write (crash artifact) then reopen.
    await appendFile(join(dir, 'j.0000.jsonl'), '{"seq":1,"kind":"torn')

    const second = new Journal<TestEvent>({ dir, name: 'j' })
    await second.open()
    await second.repairTail()
    await second.append({ seq: 1, kind: 'two' })
    await second.close()

    const reader = new Journal<TestEvent>({ dir, name: 'j' })
    await reader.open()
    const entries = await reader.readAll()
    expect(entries.filter((e) => e.kind === 'value')).toHaveLength(2)
    await reader.close()
  })
})
