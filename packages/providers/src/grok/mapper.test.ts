import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { mapGrokLine, mapGrokStream } from './mapper'

function fixture(name: string): string[] {
  const raw = readFileSync(join(__dirname, '__fixtures__', name), 'utf8')
  return raw.split('\n').filter((l) => l.trim().length > 0)
}

describe('grok mapper', () => {
  it('maps a successful session: thinking delta, text delta, usage, done', () => {
    const events = mapGrokStream(fixture('success-session.jsonl'))
    const types = events.map((e) => e.type)
    expect(types).toEqual(['thinking-delta', 'text-delta', 'usage', 'done'])
    if (events[0]?.type === 'thinking-delta') {
      expect(events[0].text).toBe('User wants exactly one word.')
    }
    if (events[1]?.type === 'text-delta') expect(events[1].text).toBe('hello')
    if (events[2]?.type === 'usage') {
      expect(events[2].inputTokens).toBe(42)
      expect(events[2].outputTokens).toBe(3)
      expect(events[2].costUsd).toBeCloseTo(0.0001, 6)
    }
  })

  it('maps the recorded quota-failure fixture to error + done', () => {
    const events = mapGrokStream(fixture('error-quota.jsonl'))
    const errors = events.filter((e) => e.type === 'error')
    expect(errors.length).toBeGreaterThanOrEqual(1)
    if (errors[0]?.type === 'error') {
      expect(errors[0].message).toContain('balance exhausted')
    }
    expect(events[events.length - 1]?.type).toBe('done')
  })

  it('maps assistant tool_use blocks to tool-started with serialized args', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'toolu_1',
            name: 'run_terminal_command',
            input: { command: 'git status' },
          },
        ],
      },
    })
    const events = mapGrokLine(line)
    expect(events.map((e) => e.type)).toEqual(['tool-started'])
    if (events[0]?.type === 'tool-started') {
      expect(events[0].callId).toBe('toolu_1')
      expect(events[0].name).toBe('run_terminal_command')
      expect(JSON.parse(events[0].argsJson)).toEqual({ command: 'git status' })
    }
  })

  it('maps user tool_result blocks to tool-completed with error state', () => {
    const ok = JSON.stringify({
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'nothing to commit' }],
      },
    })
    const events = mapGrokLine(ok)
    expect(events.map((e) => e.type)).toEqual(['tool-completed'])
    if (events[0]?.type === 'tool-completed') {
      expect(events[0].isError).toBe(false)
      expect(JSON.parse(events[0].resultJson)).toBe('nothing to commit')
    }

    const failed = JSON.stringify({
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_2', content: 'boom', is_error: true },
        ],
      },
    })
    const failEvents = mapGrokLine(failed)
    if (failEvents[0]?.type === 'tool-completed') expect(failEvents[0].isError).toBe(true)
    else throw new Error('expected tool-completed')
  })

  it('joins block-list tool results into a single result string', () => {
    const line = JSON.stringify({
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_3',
            content: [
              { type: 'text', text: 'alpha' },
              { type: 'text', text: 'beta' },
            ],
          },
        ],
      },
    })
    const events = mapGrokLine(line)
    if (events[0]?.type === 'tool-completed') {
      expect(JSON.parse(events[0].resultJson)).toBe('alphabeta')
    } else throw new Error('expected tool-completed')
  })

  it('never throws on malformed lines', () => {
    const events = mapGrokLine('{{{')
    expect(events[0]?.type).toBe('error')
  })
})
