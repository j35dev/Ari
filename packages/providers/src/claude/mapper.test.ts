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
      'session-ref',
      'thinking-delta',
      'text-delta',
      'tool-started',
      'tool-completed',
      'text-delta',
      'usage',
      'done',
    ])

    const ref = events[0]
    if (ref?.type === 'session-ref') {
      expect(ref.ref).toBe('b3d1c2a4-1111-4c7e-9a21-5f5e8d9c0a01')
    } else {
      throw new Error('expected session-ref')
    }

    const toolStart = events[3]
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

    const toolDone = events[4]
    if (toolDone?.type === 'tool-completed') {
      expect(toolDone.callId).toBe('toolu_01')
      expect(toolDone.isError).toBe(false)
      expect(JSON.parse(toolDone.resultJson)).toBe('hello\n')
    } else {
      throw new Error('expected tool-completed')
    }

    const usage = events[6]
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

  it('surfaces the init session id as a provider ref without transcript noise', () => {
    const [init] = fixture('success-session.jsonl')
    const events = mapClaudeLine(init ?? '')
    if (events[0]?.type === 'session-ref') {
      expect(events[0].ref).toBe('b3d1c2a4-1111-4c7e-9a21-5f5e8d9c0a01')
    } else {
      throw new Error('expected session-ref')
    }
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

  it('maps can_use_tool control requests to approval-requested events', () => {
    const line = JSON.stringify({
      type: 'control_request',
      request_id: 'req_7',
      request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'rm -rf /tmp/x' } },
    })
    const events = mapClaudeLine(line)
    if (events[0]?.type === 'approval-requested') {
      expect(events[0].approvalId).toBe('req_7')
      expect(events[0].toolName).toBe('Bash')
      expect(JSON.parse(events[0].summaryJson)).toEqual({ command: 'rm -rf /tmp/x' })
    } else {
      throw new Error('expected approval-requested')
    }
  })

  it('ignores non-can_use_tool control requests without emitting noise', () => {
    const line = JSON.stringify({
      type: 'control_request',
      request_id: 'req_8',
      request: { subtype: 'mystery' },
    })
    expect(mapClaudeLine(line)).toEqual([])
  })
})
