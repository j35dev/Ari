import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { mapCodexLine, mapCodexStream } from './mapper'

function fixture(name: string): string[] {
  const raw = readFileSync(join(__dirname, '__fixtures__', name), 'utf8')
  return raw.split('\n').filter((l) => l.trim().length > 0)
}

describe('codex mapper', () => {
  it('maps a successful session: reasoning, message, usage, done', () => {
    const events = mapCodexStream(fixture('success-session.jsonl'))
    const types = events.map((e) => e.type)
    expect(types).toEqual(['thinking-delta', 'text-delta', 'usage', 'done'])
    if (events[1]?.type === 'text-delta') expect(events[1].text).toBe('hello')
    if (events[2]?.type === 'usage') {
      expect(events[2].inputTokens).toBe(42)
      expect(events[2].outputTokens).toBe(3)
      expect(events[2].costUsd).toBeNull()
    }
  })

  it('maps the recorded quota-failure fixture to error + done, skipping reconnect noise', () => {
    const events = mapCodexStream(fixture('error-quota.jsonl'))
    const errors = events.filter((e) => e.type === 'error')
    expect(errors.length).toBeGreaterThanOrEqual(1)
    if (errors[0]?.type === 'error') {
      expect(errors[0].message).toContain('quota is not enough')
    }
    expect(events[events.length - 1]?.type).toBe('done')
  })

  it('maps command execution items to tool-started + tool-completed with exit state', () => {
    const line = JSON.stringify({
      type: 'item.completed',
      item: {
        id: 'item_9',
        type: 'command_execution',
        command: 'git status',
        aggregated_output: 'nothing to commit',
        exit_code: 0,
        status: 'completed',
      },
    })
    const events = mapCodexLine(line)
    expect(events.map((e) => e.type)).toEqual(['tool-started', 'tool-completed'])
    if (events[0]?.type === 'tool-started') {
      expect(events[0].name).toBe('bash')
      expect(JSON.parse(events[0].argsJson)).toEqual({ command: 'git status' })
    }
    if (events[1]?.type === 'tool-completed') {
      expect(events[1].isError).toBe(false)
      expect(JSON.parse(events[1].resultJson)).toBe('nothing to commit')
    }
  })

  it('marks non-zero exit codes as tool errors', () => {
    const line = JSON.stringify({
      type: 'item.completed',
      item: { id: 'x', type: 'command_execution', command: 'oops', exit_code: 2 },
    })
    const events = mapCodexLine(line)
    if (events[1]?.type === 'tool-completed') expect(events[1].isError).toBe(true)
    else throw new Error('expected tool-completed')
  })

  it('never throws on malformed lines', () => {
    const events = mapCodexLine('{{{')
    expect(events[0]?.type).toBe('error')
  })
})
