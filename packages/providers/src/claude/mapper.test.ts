import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { mapClaudeLine, mapClaudeStream } from './mapper'

function fixture(name: string): string[] {
  const raw = readFileSync(join(__dirname, '__fixtures__', name), 'utf8')
  return raw.split('\n').filter((l) => l.trim().length > 0)
}

describe('claude mapper', () => {
  it('maps a successful session end-to-end', () => {
    const events = mapClaudeStream(fixture('success-session.jsonl'))
    const types = events.map((e) => e.type)
    expect(types).toEqual([
      'thinking-delta',
      'text-delta',
      'tool-started',
      'tool-completed',
      'text-delta',
      'usage',
      'done',
    ])

    const toolStart = events[2]
    if (toolStart?.type === 'tool-started') {
      expect(toolStart.callId).toBe('toolu_01')
      expect(toolStart.name).toBe('Bash')
      expect(JSON.parse(toolStart.argsJson)).toEqual({
        command: 'echo hello',
        description: 'Print hello',
      })
    } else {
      throw new Error('expected tool-started')
    }

    const toolDone = events[3]
    if (toolDone?.type === 'tool-completed') {
      expect(toolDone.callId).toBe('toolu_01')
      expect(toolDone.isError).toBe(false)
      expect(JSON.parse(toolDone.resultJson)).toBe('hello\n')
    } else {
      throw new Error('expected tool-completed')
    }

    const usage = events[5]
    if (usage?.type === 'usage') {
      expect(usage.inputTokens).toBe(450)
      expect(usage.outputTokens).toBe(120)
      expect(usage.costUsd).toBeCloseTo(0.0042)
    }
  })

  it('maps the recorded model_not_found error fixture to an error event + done', () => {
    const events = mapClaudeStream(fixture('error-model-not-found.jsonl'))
    const errors = events.filter((e) => e.type === 'error')
    expect(errors.length).toBeGreaterThan(0)
    if (errors[0]?.type === 'error') {
      expect(errors[0].message).toContain('model_not_found')
    }
    expect(events[events.length - 1]?.type).toBe('done')
  })

  it('never throws on malformed lines — surfaces an error event instead', () => {
    const events = mapClaudeLine('{not json')
    expect(events).toHaveLength(1)
    if (events[0]?.type === 'error') {
      expect(events[0].message).toContain('unparseable line')
    } else {
      throw new Error('expected error event')
    }
  })

  it('ignores system/init lines without emitting transcript noise', () => {
    const [init] = fixture('success-session.jsonl')
    expect(mapClaudeLine(init ?? '')).toEqual([])
  })

  it('maps tool errors with isError=true', () => {
    const line = JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 't1', content: 'boom', is_error: true },
        ],
      },
    })
    const events = mapClaudeLine(line)
    if (events[0]?.type === 'tool-completed') {
      expect(events[0].isError).toBe(true)
    } else {
      throw new Error('expected tool-completed')
    }
  })
})
