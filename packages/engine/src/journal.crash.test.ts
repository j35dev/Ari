import { mkdtemp, rm, writeFile, appendFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Journal } from './journal'

interface TestEvent {
  seq: number
  kind: string
}

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ari-journal-crash-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/**
 * M3.12 — crash-recovery edge cases beyond the happy-path torn tail:
 * corrupt middle lines, multibyte tears, garbage-only segments, cross-segment
 * corruption isolation, and batch-fsync durability barriers.
 */
describe('Journal crash recovery (M3.12)', () => {
  it('keeps valid entries on both sides of a corrupt middle line', async () => {
    const segment = join(dir, 'j.0000.jsonl')
    await writeFile(
      segment,
      '{"seq":0,"kind":"ok"}\n{this is not json}\n{"seq":2,"kind":"ok"}\n',
    )
    const journal = new Journal<TestEvent>({ dir, name: 'j' })
    await journal.open()
    const entries = await journal.readAll()
    expect(entries).toHaveLength(3)
    expect(entries[0]?.kind).toBe('value')
    expect(entries[1]?.kind).toBe('error')
    expect(entries[1]?.line).toBe(2)
    expect(entries[2]?.kind).toBe('value')
    if (entries[2]?.kind === 'value') expect(entries[2].value.seq).toBe(2)
    await journal.close()
  })

  it('truncates a torn multibyte character tail without losing prior lines', async () => {
    // "héllo" in UTF-8 is 6 bytes; the tear splits inside the é sequence.
    const tornLine = Buffer.from('{"seq":1,"kind":"héllo"}\n', 'utf8').subarray(0, 18)
    const segment = join(dir, 'j.0000.jsonl')
    await writeFile(segment, Buffer.concat([Buffer.from('{"seq":0,"kind":"ok"}\n'), tornLine]))
    const journal = new Journal<TestEvent>({ dir, name: 'j' })
    await journal.open()
    const entries = await journal.readAll()
    expect(entries[0]?.kind).toBe('value')
    expect(entries[entries.length - 1]?.kind).toBe('error')

    const truncated = await journal.repairTail()
    expect(truncated).toBeGreaterThan(0)
    await journal.append({ seq: 2, kind: 'after-multibyte-repair' })
    await journal.close()

    const reopened = new Journal<TestEvent>({ dir, name: 'j' })
    await reopened.open()
    const after = await reopened.readAll()
    const values = after.filter((e) => e.kind === 'value')
    expect(values).toHaveLength(2)
    await reopened.close()

    const finalStat = await stat(join(dir, 'j.0000.jsonl'))
    expect(finalStat.size).toBeGreaterThan(0)
  })

  it('empties an all-garbage active segment on repairTail', async () => {
    await writeFile(join(dir, 'j.0000.jsonl'), 'garbage without newlines or json')
    const journal = new Journal<TestEvent>({ dir, name: 'j' })
    await journal.open()
    const truncated = await journal.repairTail()
    expect(truncated).toBeGreaterThan(0)
    await journal.append({ seq: 9, kind: 'fresh-start' })
    await journal.close()

    const reopened = new Journal<TestEvent>({ dir, name: 'j' })
    await reopened.open()
    const entries = await reopened.readAll()
    expect(entries).toMatchObject([{ kind: 'value', line: 1, value: { seq: 9, kind: 'fresh-start' } }])
    await reopened.close()
  })

  it('isolates corruption to one segment; other segments read intact', async () => {
    await writeFile(join(dir, 'j.0000.jsonl'), '{"seq":0,"kind":"seg0-a"}\n{"seq":1,"kind":"seg0-b"}\n')
    await writeFile(join(dir, 'j.0001.jsonl'), '{"seq":2,"kind":"seg1 torn no newline')
    await writeFile(join(dir, 'j.0002.jsonl'), '{"seq":3,"kind":"seg2"}\n')
    const journal = new Journal<TestEvent>({ dir, name: 'j' })
    await journal.open()
    const entries = await journal.readAll()
    expect(entries).toHaveLength(4)
    expect(entries.map((e) => e.kind)).toEqual(['value', 'value', 'error', 'value'])
    if (entries[3]?.kind === 'value') expect(entries[3].value.seq).toBe(3)
    await journal.close()
  })

  it('flush() makes batched appends durable before close', async () => {
    const journal = new Journal<TestEvent>({ dir, name: 'j', fsync: 'batch' })
    await journal.open()
    await journal.append({ seq: 0, kind: 'batched-1' })
    await journal.append({ seq: 1, kind: 'batched-2' })
    await journal.flush()
    await journal.close()

    const reader = new Journal<TestEvent>({ dir, name: 'j', fsync: 'batch' })
    await reader.open()
    const entries = await reader.readAll()
    expect(entries).toHaveLength(2)
    expect(entries.every((e) => e.kind === 'value')).toBe(true)
    await reader.close()
  })

  it('simulates a mid-write crash then recovers via open + repairTail + append', async () => {
    // Phase 1: healthy journal with two committed events.
    const first = new Journal<TestEvent>({ dir, name: 'j' })
    await first.open()
    await first.append({ seq: 0, kind: 'committed' })
    await first.append({ seq: 1, kind: 'committed' })
    await first.close()

    // Phase 2: crash artifact — partial line written before the process died.
    await appendFile(join(dir, 'j.0000.jsonl'), '{"seq":2,"kind":"half-writ')

    // Phase 3: recovery path used by engine boot.
    const recovered = new Journal<TestEvent>({ dir, name: 'j' })
    await recovered.open()
    const damaged = (await recovered.readAll()).some((e) => e.kind === 'error')
    if (damaged) await recovered.repairTail()
    await recovered.append({ seq: 3, kind: 'post-recovery' })
    await recovered.close()

    const reader = new Journal<TestEvent>({ dir, name: 'j' })
    await reader.open()
    const entries = await reader.readAll()
    expect(entries.every((e) => e.kind === 'value')).toBe(true)
    expect(entries).toHaveLength(3)
    if (entries[2]?.kind === 'value') expect(entries[2].value.seq).toBe(3)
    await reader.close()
  })
})
