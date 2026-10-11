import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { mapPiLine, mapPiStream } from './mapper'

function fixture(name: string): string[] {
  const raw = readFileSync(join(__dirname, '__fixtures__', name), 'utf8')
  return raw.split('\n').filter((l) => l.trim().length > 0)
}

describe('pi mapper', () => {
  it('maps a successful session: thinking, text, tool round-trip, usage, done', () => {
    const events = mapPiStream(fixture('success-session.jsonl'))
    const types = events.map((e) => e.type)
    expect(types).toEqual([
      'session-ref',
      'thinking-delta',
      'tool-started',
      'tool-completed',
      'text-delta',
      'usage',
      'context-usage',
      'done',
    ])
    if (events[0]?.type === 'session-ref') {
      expect(events[0].ref).toBe('01a0231d-d596-772a-be45-b0f56eb563a9')
    }
    if (events[1]?.type === 'thinking-delta') {
      expect(events[1].text).toBe('User wants a listing first.')
    }
    if (events[2]?.type === 'tool-started') {
      expect(events[2].name).toBe('read')
      expect(JSON.parse(events[2].argsJson)).toEqual({ path: 'README.md' })
    }
    if (events[3]?.type === 'tool-completed') {
      expect(events[3].isError).toBe(false)
      expect(JSON.parse(events[3].resultJson)).toEqual({ output: '# proj' })
    }
    if (events[4]?.type === 'text-delta') expect(events[4].text).toBe('hello')
    if (events[5]?.type === 'usage') {
      // Both model calls of agent_end count: 42 + 60 in, 20 + 25 out.
      expect(events[5].inputTokens).toBe(102)
      expect(events[5].outputTokens).toBe(45)
      expect(events[5].costUsd).toBeCloseTo(0.000505, 8)
    } else {
      throw new Error('expected usage')
    }
    // The window holds what the last call saw: 60 in + 25 out.
    expect(events[6]).toEqual({ type: 'context-usage', usedTokens: 85, windowTokens: null })
  })

  it('counts cache reads as input and reports the last call as the context', () => {
    // Per-call counts recorded from a real pi session log.
    const call = (input: number, output: number, cacheRead: number) => ({
      role: 'assistant',
      usage: { input, output, cacheRead, cacheWrite: 0, cost: { total: 0.01 } },
    })
    const events = mapPiLine(
      JSON.stringify({
        type: 'agent_end',
        messages: [{ role: 'user' }, call(5000, 221, 113), call(2552, 191, 5105)],
      }),
    )
    expect(events).toEqual([
      {
        type: 'usage',
        inputTokens: 5113 + 7657,
        outputTokens: 412,
        cachedInputTokens: 5218,
        costUsd: 0.02,
      },
      { type: 'context-usage', usedTokens: 7848, windowTokens: null },
      { type: 'done' },
    ])
  })

  it('ignores message_update streaming deltas to avoid double emission', () => {
    const line = JSON.stringify({
      type: 'message_update',
      usage: {},
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'hel' },
    })
    expect(mapPiLine(line)).toEqual([])
  })

  it('maps the recorded credits-failure fixture to error + done', () => {
    const events = mapPiStream(fixture('error-provider-credits.jsonl'))
    const errors = events.filter((e) => e.type === 'error')
    expect(errors.length).toBe(1)
    if (errors[0]?.type === 'error') {
      expect(errors[0].message).toContain('out of credits')
    }
    expect(events[events.length - 1]?.type).toBe('done')
  })

  it('maps the recorded auth-failure fixture to error + done', () => {
    const events = mapPiStream(fixture('error-auth.jsonl'))
    const errors = events.filter((e) => e.type === 'error')
    expect(errors.length).toBe(1)
    if (errors[0]?.type === 'error') {
      expect(errors[0].message).toContain('Invalid bearer token')
    }
    expect(events[events.length - 1]?.type).toBe('done')
  })

  it('marks failed tool executions as tool errors', () => {
    const line = JSON.stringify({
      type: 'tool_execution_end',
      toolCallId: 'toolcall_9',
      toolName: 'bash',
      result: 'command not found',
      isError: true,
    })
    const events = mapPiLine(line)
    if (events[0]?.type === 'tool-completed') {
      expect(events[0].isError).toBe(true)
      expect(JSON.parse(events[0].resultJson)).toBe('command not found')
    } else throw new Error('expected tool-completed')
  })

  it('never throws on malformed lines', () => {
    const events = mapPiLine('{{{')
    expect(events[0]?.type).toBe('error')
  })
})
