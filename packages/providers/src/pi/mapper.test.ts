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
      'thinking-delta',
      'tool-started',
      'tool-completed',
      'text-delta',
      'usage',
      'done',
    ])
    if (events[0]?.type === 'thinking-delta') {
      expect(events[0].text).toBe('User wants a listing first.')
    }
    if (events[1]?.type === 'tool-started') {
      expect(events[1].name).toBe('read')
      expect(JSON.parse(events[1].argsJson)).toEqual({ path: 'README.md' })
    }
    if (events[2]?.type === 'tool-completed') {
      expect(events[2].isError).toBe(false)
      expect(JSON.parse(events[2].resultJson)).toEqual({ output: '# proj' })
    }
    if (events[3]?.type === 'text-delta') expect(events[3].text).toBe('hello')
    if (events[4]?.type === 'usage') {
      // Usage comes from the last assistant message of agent_end.
      expect(events[4].inputTokens).toBe(60)
      expect(events[4].outputTokens).toBe(25)
      expect(events[4].costUsd).toBeCloseTo(0.000305, 8)
    }
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
