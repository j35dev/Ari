import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentEvent } from '@ari/contracts/agent-event'
import { describe, expect, it } from 'vitest'
import { fakeHttp } from './__fixtures__/fake-http'
import { createSseParser } from './http'
import { OpencodeTurnMapper } from './sdk-mapper'
import type { OpencodeWire } from './wire'
import { WireV1 } from './wire-v1'
import { WireV2 } from './wire-v2'

/** Plays a recorded SSE stream through a wire adapter and the turn mapper. */
function play(fixture: string, wire: OpencodeWire) {
  const mapper = new OpencodeTurnMapper('ses_root')
  const events: AgentEvent[] = []
  const ends: string[] = []
  const parse = createSseParser((data) => {
    for (const event of wire.normalize(JSON.parse(data))) {
      const mapped = mapper.map(event)
      events.push(...mapped.events)
      if (mapped.end) ends.push(mapped.end)
    }
  })
  parse(readFileSync(join(import.meta.dirname, '__fixtures__', fixture), 'utf8'))
  return { events, ends, mapper }
}

const ofType = <T extends AgentEvent['type']>(events: AgentEvent[], type: T) =>
  events.filter((event): event is Extract<AgentEvent, { type: T }> => event.type === type)

describe('classic OpenCode stream', () => {
  const { events, ends } = play('v1-turn.sse', new WireV1(fakeHttp().http))

  it('streams text and reasoning once: deltas first, the final part only adds what is missing', () => {
    expect(ofType(events, 'thinking-delta').map((e) => e.text)).toEqual(['Thinking'])
    expect(ofType(events, 'text-delta').map((e) => [e.text, e.streamId])).toEqual([
      ['Hel', 'prt_t1'],
      ['lo', 'prt_t1'],
      [' world', 'prt_t1'],
    ])
  })

  it('reports tools with inputs and outputs, once each', () => {
    expect(ofType(events, 'tool-started')).toEqual([
      { type: 'tool-started', callId: 'call_1', name: 'bash', argsJson: '{"command":"ls"}' },
      {
        type: 'tool-started',
        callId: 'call_2',
        name: 'task',
        argsJson: JSON.stringify({
          description: 'Explore',
          subagent_type: 'explore',
          prompt: 'look',
        }),
      },
    ])
    expect(ofType(events, 'tool-completed')).toEqual([
      { type: 'tool-completed', callId: 'call_1', resultJson: '"a\\nb"', isError: false },
      { type: 'tool-completed', callId: 'call_2', resultJson: '"found it"', isError: false },
    ])
  })

  it('reports the child session as a sub-agent with its own activity', () => {
    const tasks = ofType(events, 'background-task')
    expect(tasks.map((task) => [task.id, task.status, task.label])).toEqual([
      ['opencode-ses_child', 'running', 'Explore (@explore subagent)'],
      ['opencode-ses_child', 'completed', 'Explore (@explore subagent)'],
    ])
    expect(tasks[1]?.result).toBe('found it')
    const activity = ofType(events, 'subagent-activity')
    expect(activity.map((e) => e.event.type)).toEqual([
      'text-delta',
      'tool-started',
      'tool-completed',
    ])
    expect(activity.every((e) => e.taskId === 'opencode-ses_child')).toBe(true)
  })

  it('adds usage per step, with context only for the root session', () => {
    expect(ofType(events, 'usage')).toEqual([
      { type: 'usage', inputTokens: 10, outputTokens: 2, cachedInputTokens: 0, costUsd: 0.001 },
      { type: 'usage', inputTokens: 160, outputTokens: 25, cachedInputTokens: 50, costUsd: 0.01 },
    ])
    expect(ofType(events, 'context-usage')).toEqual([
      { type: 'context-usage', usedTokens: 185, windowTokens: null },
    ])
  })

  it('surfaces permissions, questions and retries', () => {
    expect(ofType(events, 'approval-requested')[0]).toMatchObject({
      approvalId: 'per_1',
      toolName: 'bash',
      providerItemId: 'call_3',
      options: [{ optionId: 'once' }, { optionId: 'always' }, { optionId: 'reject' }],
    })
    const question = ofType(events, 'input-requested')[0]!
    expect(question.inputId).toBe('que_1')
    expect(JSON.parse(question.choicesJson!)).toMatchObject({
      kind: 'questionnaire',
      questions: [
        { id: '0', question: 'Which database?', header: 'Database', multiSelect: false },
        { id: '1', question: 'Features?', multiSelect: true },
      ],
    })
    expect(ofType(events, 'notice').map((e) => e.message)).toEqual([
      'OpenCode is retrying (attempt 1): Rate limited',
    ])
  })

  it('reports a provider error but not the abort, and ends on the root session going idle', () => {
    expect(ofType(events, 'error').map((e) => e.message)).toEqual(['Provider is overloaded'])
    expect(ends).toEqual(['completed'])
    // Another session's idle never ends this turn.
    expect(events.at(-1)?.type).toBe('error')
  })
})

describe('OpenCode 2 stream', () => {
  const { events, ends } = play('v2-turn.sse', new WireV2(fakeHttp().http, 0))

  it('streams text and reasoning by message ordinal', () => {
    expect(ofType(events, 'thinking-delta').map((e) => e.text)).toEqual(['Plan', ' it'])
    expect(ofType(events, 'text-delta').map((e) => e.text)).toEqual(['Hi', ' there'])
  })

  it('names tools from their input stream and maps success, failure and images', () => {
    expect(ofType(events, 'tool-started').map((e) => [e.callId, e.name, e.argsJson])).toEqual([
      ['call_1', 'shell', '{"command":"ls"}'],
      ['call_2', 'subagent', '{"agent":"explore","prompt":"look"}'],
    ])
    expect(ofType(events, 'tool-completed')).toEqual([
      { type: 'tool-completed', callId: 'call_1', resultJson: '"a\\nb"', isError: false },
      { type: 'tool-completed', callId: 'call_2', resultJson: '"child crashed"', isError: true },
    ])
    expect(ofType(events, 'image-output')).toEqual([
      { type: 'image-output', dataBase64: 'iVBORw0KGgo=', mimeType: 'image/png', name: 'shot.png' },
    ])
  })

  it('tracks the child session from creation to its execution end', () => {
    expect(
      ofType(events, 'background-task').map((t) => [t.status, t.subagentType ?? null]),
    ).toEqual([
      ['running', 'explore'],
      ['completed', null],
    ])
    expect(ofType(events, 'subagent-activity')).toEqual([
      {
        type: 'subagent-activity',
        taskId: 'opencode-ses_child',
        event: { type: 'text-delta', text: 'child says', streamId: 'msg_c:0' },
      },
    ])
  })

  it('maps forms onto questionnaires, skipping fields Ari cannot answer', () => {
    const question = ofType(events, 'input-requested')[0]!
    expect(question.prompt).toBe('Setup')
    const payload = JSON.parse(question.choicesJson!) as {
      questions: { id: string; multiSelect: boolean }[]
    }
    expect(payload.questions.map((q) => [q.id, q.multiSelect])).toEqual([
      ['db', false],
      ['features', true],
      ['tests', false],
      ['port', false],
    ])
  })

  it('ends on the execution result, not on the legacy idle event', () => {
    expect(ends).toEqual(['error'])
    expect(ofType(events, 'error').map((e) => e.message)).toEqual(['Out of credits'])
    expect(ofType(events, 'approval-requested')[0]).toMatchObject({
      approvalId: 'per_2',
      toolName: 'shell',
      providerItemId: 'call_3',
      summaryJson: '{"resources":["git push"],"metadata":{}}',
    })
    expect(ofType(events, 'usage').map((u) => u.costUsd)).toEqual([0.002, 0.02])
  })
})
