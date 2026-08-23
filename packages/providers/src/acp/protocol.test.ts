import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AcpUpdateFolder, stopReasonEvents } from './protocol'
import type { AcpSessionNotification } from './protocol'

function fixtureLines(name: string): AcpSessionNotification[] {
  const raw = readFileSync(join(__dirname, '__fixtures__', name), 'utf8')
  return raw
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as AcpSessionNotification)
}

describe('AcpUpdateFolder', () => {
  it('folds a full recorded session into deltas, tools, and usage', () => {
    const folder = new AcpUpdateFolder()
    const events = fixtureLines('session-updates.jsonl').flatMap((n) => folder.fold(n))

    expect(events[0]).toEqual({ type: 'thinking-delta', text: 'Let me check the repo layout.' })
    expect(events[1]).toEqual({ type: 'text-delta', text: 'Looking at ' })
    expect(events[2]).toEqual({ type: 'text-delta', text: '**src/** now.' })

    // call_1: started once, completed once with text result.
    const started = events.filter((e) => e.type === 'tool-started')
    expect(started.map((e) => (e as { callId: string }).callId)).toEqual(['call_1', 'call_2'])
    expect(started[0]).toMatchObject({ name: 'read_file' })

    const completed = events.filter((e) => e.type === 'tool-completed')
    expect(completed.length).toBe(2)
    expect(completed[0]).toMatchObject({ callId: 'call_1', isError: false })
    expect(JSON.parse((completed[0] as { resultJson: string }).resultJson)).toEqual({
      text: 'export function main() {}',
    })
    expect(completed[1]).toMatchObject({ callId: 'call_2', isError: true })
    expect(JSON.parse((completed[1] as { resultJson: string }).resultJson)).toEqual({
      diff: { path: 'src/util.ts', oldText: 'a', newText: 'b' },
    })

    const usage = events.find((e) => e.type === 'usage') as { inputTokens: number; costUsd: number | null }
    expect(usage).toMatchObject({ inputTokens: 4210, costUsd: 0.0142 })

    // plan updates have no transcript surface.
    expect(events.some((e) => e.type === 'error')).toBe(false)
    expect(events.some((e) => e.type === 'done')).toBe(false)
  })

  it('ignores non-terminal bookkeeping updates entirely', () => {
    const folder = new AcpUpdateFolder()
    const events = fixtureLines('non-terminal-updates.jsonl').flatMap((n) => folder.fold(n))
    expect(events).toEqual([{ type: 'text-delta', text: 'Partial progress before the wall.' }])
  })

  it('synthesizes a start when an agent finalizes a tool without creating it', () => {
    const folder = new AcpUpdateFolder()
    const events = folder.fold({
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'late_1',
        status: 'completed',
        rawOutput: { ok: true },
      },
    })
    expect(events.map((e) => e.type)).toEqual(['tool-started', 'tool-completed'])
    expect(JSON.parse((events[1] as { resultJson: string }).resultJson)).toEqual({ ok: true })
  })

  it('treats non-USD costs and malformed payloads conservatively', () => {
    const folder = new AcpUpdateFolder()
    const events = folder.fold({
      update: { sessionUpdate: 'usage_update', used: 12, size: 100, cost: { amount: 5, currency: 'EUR' } },
    })
    expect(events[0]).toMatchObject({ costUsd: null })
    expect(folder.fold({})).toEqual([])
    expect(folder.fold({ update: { sessionUpdate: 'from_the_future' } })).toEqual([])
  })

  it('keeps empty text chunks out of the stream', () => {
    const folder = new AcpUpdateFolder()
    expect(
      folder.fold({ update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '' } } }),
    ).toEqual([])
  })
})

describe('stopReasonEvents', () => {
  it('maps successful and cancelled turns to done', () => {
    for (const reason of ['end_turn', 'cancelled', 'max_turn_requests']) {
      expect(stopReasonEvents(reason)).toEqual([{ type: 'done' }])
    }
  })

  it('surfaces refusals and token limits as errors before done', () => {
    const refusal = stopReasonEvents('refusal')
    expect(refusal[0]?.type).toBe('error')
    expect(refusal[1]?.type).toBe('done')
    const maxTokens = stopReasonEvents('max_tokens')
    expect(maxTokens[0]?.type).toBe('error')
  })

  it('degrades unknown reasons to a plain done', () => {
    expect(stopReasonEvents('something_new')).toEqual([{ type: 'done' }])
  })
})
