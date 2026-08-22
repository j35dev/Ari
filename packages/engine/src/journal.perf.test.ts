import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { JournalEvent } from '@ari/contracts/events'
import { encodeJsonLine, parseJsonLines } from '@ari/shared/jsonl'
import { Journal } from './journal'
import { projectEvents, type UnstampedEvent } from './projection'

const APPEND_COUNT = 10_000
const APPEND_BUDGET_MS_PER_EVENT = 5
const REPLAY_COUNT = 100_000
const REPLAY_BUDGET_MS = 2_000
const READ_BACK_BUDGET_MS = 2_000
const BASE_AT = 1_700_000_000_000
const SESSION_ID = 'sess_perf'

interface PerfEvent {
  seq: number
  kind: string
  payload: string
}

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ari-journal-perf-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/**
 * Long-session event mix: dense turn churn with a message-bearing turn every
 * 20th turn, mirroring real journal shape without tripping the projection's
 * per-message array copies into quadratic territory.
 */
function buildReplayLines(count: number): string[] {
  const lines: string[] = []
  let seq = 0
  const stamp = (event: UnstampedEvent): void => {
    if (seq >= count) return
    lines.push(encodeJsonLine({ ...event, seq, at: BASE_AT + seq, sessionId: SESSION_ID }))
    seq += 1
  }

  stamp({
    type: 'session.created',
    session: {
      id: SESSION_ID,
      projectId: 'proj_perf',
      title: 'Replay perf',
      driverKind: 'claude',
      modelId: null,
      permissionMode: 'ask',
      status: 'idle',
      createdAt: BASE_AT,
      updatedAt: BASE_AT,
    },
  })

  for (let turn = 0; seq < count; turn += 1) {
    const turnId = `turn_${turn}`
    stamp({ type: 'turn.started', turnId })
    stamp({ type: 'session.status.changed', from: 'idle', to: 'running', reason: null })
    if (turn % 20 === 0) {
      stamp({
        type: 'user.message.added',
        message: {
          id: `msg_user_${turn}`,
          sessionId: SESSION_ID,
          turnId,
          role: 'user',
          parts: [{ type: 'text', text: `run ${turn}` }],
          createdAt: BASE_AT + seq,
        },
      })
      stamp({
        type: 'assistant.parts.appended',
        messageId: `msg_asst_${turn}`,
        parts: [{ type: 'text', text: `reply ${turn}` }],
      })
      stamp({
        type: 'approval.requested',
        approvalId: `ap_${turn}`,
        toolName: 'bash',
        summaryJson: '{"command":"ls"}',
      })
      stamp({ type: 'approval.responded', approvalId: `ap_${turn}`, decision: 'allow' })
    }
    stamp({ type: 'session.status.changed', from: 'running', to: 'settled', reason: null })
    stamp({ type: 'turn.settled', turnId, stopReason: 'completed', errorMessage: null })
  }
  return lines
}

describe('journal performance budgets', () => {
  it('appends 10k events under the amortized per-append budget', { timeout: 120_000 }, async () => {
    // batch mode: per-append fsync would measure disk latency, not the journal
    // write path; the single trailing flush() restores durability.
    const journal = new Journal<PerfEvent>({ dir, name: 'perf-append', fsync: 'batch' })
    await journal.open()

    const start = performance.now()
    for (let i = 0; i < APPEND_COUNT; i += 1) {
      await journal.append({ seq: i, kind: 'perf', payload: 'x'.repeat(96) })
    }
    const amortizedMs = (performance.now() - start) / APPEND_COUNT
    await journal.flush()

    await journal.close()
    const entries = await journal.readAll()

    expect(entries).toHaveLength(APPEND_COUNT)
    expect(amortizedMs).toBeLessThan(APPEND_BUDGET_MS_PER_EVENT)
  })

  it('replays 100k events through parse + projection fold under the wall budget', { timeout: 30_000 }, async () => {
    const file = join(dir, 'replay.jsonl')
    await writeFile(file, `${buildReplayLines(REPLAY_COUNT).join('\n')}\n`, 'utf8')

    const start = performance.now()
    const content = await readFile(file, 'utf8')
    const parsed = parseJsonLines<JournalEvent>(content)
    const model = projectEvents(parsed.flatMap((p) => (p.kind === 'value' ? [p.value] : [])))
    const elapsedMs = performance.now() - start

    expect(elapsedMs).toBeLessThan(REPLAY_BUDGET_MS)
    expect(parsed.every((p) => p.kind === 'value')).toBe(true)
    expect(model.lastSeq).toBe(REPLAY_COUNT - 1)
    expect(model.messages.length).toBeGreaterThan(0)
  })

  it('reads back a persisted 10k-event journal under the wall budget', { timeout: 30_000 }, async () => {
    const journal = new Journal<PerfEvent>({ dir, name: 'perf-readback', fsync: 'batch' })
    await journal.open()
    for (let i = 0; i < APPEND_COUNT; i += 1) {
      await journal.append({ seq: i, kind: 'perf', payload: 'x'.repeat(96) })
    }
    await journal.flush()
    await journal.close()

    // Cold read: fresh instance, as the engine boot path (M3.9) does.
    const reopened = new Journal<PerfEvent>({ dir, name: 'perf-readback', fsync: 'batch' })
    await reopened.open()
    const start = performance.now()
    const entries = await reopened.readAll()
    const elapsedMs = performance.now() - start
    await reopened.close()

    expect(entries).toHaveLength(APPEND_COUNT)
    expect(entries.every((p) => p.kind === 'value')).toBe(true)
    expect(elapsedMs).toBeLessThan(READ_BACK_BUDGET_MS)
  })
})
