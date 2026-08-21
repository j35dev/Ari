import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { mapOpencodeLine, mapOpencodeStream } from './mapper'

function fixture(name: string): string[] {
  const raw = readFileSync(join(__dirname, '__fixtures__', name), 'utf8')
  return raw.split('\n').filter((l) => l.trim().length > 0)
}

describe('opencode mapper', () => {
  it('maps the live-recorded hello run: text, usage, done (step_start skipped)', () => {
    const events = mapOpencodeStream(fixture('live-run.jsonl'))
    const types = events.map((e) => e.type)
    expect(types).toEqual(['text-delta', 'usage', 'done'])
    if (events[0]?.type === 'text-delta') expect(events[0].text).toBe('hello')
    if (events[1]?.type === 'usage') {
      expect(events[1].inputTokens).toBe(9371)
      expect(events[1].outputTokens).toBe(15)
      expect(events[1].costUsd).toBe(0)
    }
  })

  it('maps the live-recorded server error to an error event', () => {
    const events = mapOpencodeStream(fixture('error-server.jsonl'))
    const errors = events.filter((e) => e.type === 'error')
    expect(errors.length).toBe(1)
    if (errors[0]?.type === 'error') {
      expect(errors[0].message).toContain('Unexpected server error')
    }
  })

  it('maps a completed tool part to tool-started + tool-completed with exit state', () => {
    const line = JSON.stringify({
      type: 'tool_use',
      part: {
        type: 'tool',
        tool: 'bash',
        callID: 'call_1',
        state: {
          status: 'completed',
          input: { command: 'echo ari-probe' },
          output: 'ari-probe\n',
          metadata: { exit: 0 },
        },
      },
    })
    const events = mapOpencodeLine(line)
    expect(events.map((e) => e.type)).toEqual(['tool-started', 'tool-completed'])
    if (events[0]?.type === 'tool-started') {
      expect(events[0].name).toBe('bash')
      expect(JSON.parse(events[0].argsJson)).toEqual({ command: 'echo ari-probe' })
    }
    if (events[1]?.type === 'tool-completed') {
      expect(events[1].isError).toBe(false)
      expect(JSON.parse(events[1].resultJson)).toBe('ari-probe\n')
    }
  })

  it('maps a pending tool part to tool-started only', () => {
    const line = JSON.stringify({
      type: 'tool_use',
      part: {
        type: 'tool',
        tool: 'bash',
        callID: 'call_2',
        state: { status: 'pending', input: { command: 'sleep 5' } },
      },
    })
    const events = mapOpencodeLine(line)
    expect(events.map((e) => e.type)).toEqual(['tool-started'])
  })

  it('marks errored tools and non-zero exits as tool errors', () => {
    const errored = mapOpencodeLine(
      JSON.stringify({
        type: 'tool_use',
        part: { type: 'tool', tool: 'bash', callID: 'c3', state: { status: 'error' } },
      }),
    )
    if (errored[1]?.type === 'tool-completed') expect(errored[1].isError).toBe(true)
    else throw new Error('expected tool-completed')

    const failedExit = mapOpencodeLine(
      JSON.stringify({
        type: 'tool_use',
        part: {
          type: 'tool',
          tool: 'bash',
          callID: 'c4',
          state: { status: 'completed', metadata: { exit: 2 } },
        },
      }),
    )
    if (failedExit[1]?.type === 'tool-completed') expect(failedExit[1].isError).toBe(true)
    else throw new Error('expected tool-completed')
  })

  it('keeps multi-step sessions open on tool-calls step finishes', () => {
    const finish = (reason: string): string =>
      JSON.stringify({
        type: 'step_finish',
        part: { type: 'step-finish', reason, tokens: { input: 10, output: 2 }, cost: 0 },
      })
    expect(mapOpencodeLine(finish('tool-calls')).map((e) => e.type)).toEqual(['usage'])
    expect(mapOpencodeLine(finish('stop')).map((e) => e.type)).toEqual(['usage', 'done'])
  })

  it('maps documented reasoning parts to thinking deltas', () => {
    const line = JSON.stringify({
      type: 'reasoning',
      part: { type: 'reasoning', text: 'thinking it through' },
    })
    const events = mapOpencodeLine(line)
    expect(events).toEqual([{ type: 'thinking-delta', text: 'thinking it through' }])
  })

  it('skips unknown transport lines without emitting anything', () => {
    expect(mapOpencodeLine(JSON.stringify({ type: 'session_info', sessionID: 'ses_x' }))).toEqual(
      [],
    )
    expect(mapOpencodeLine('INFO opencode: server started')).toEqual([])
  })

  it('never throws on malformed lines', () => {
    const events = mapOpencodeLine('{{{')
    expect(events[0]?.type).toBe('error')
  })
})
