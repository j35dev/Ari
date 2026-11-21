import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { ClaudeMessageMapper } from './mapper'

const message = (value: unknown) => value as SDKMessage
describe('Claude SDK message mapping', () => {
  it('accounts for a CLI counter reset after /clear inside the same query', () => {
    const mapper = new ClaudeMessageMapper()
    mapper.map(
      message({
        type: 'result',
        total_cost_usd: 0.1,
        modelUsage: { haiku: { inputTokens: 20, outputTokens: 7, cacheReadInputTokens: 10 } },
      }),
    )
    const usage = mapper
      .map(
        message({
          type: 'result',
          total_cost_usd: 0.01,
          modelUsage: { haiku: { inputTokens: 2, outputTokens: 1, cacheReadInputTokens: 0 } },
        }),
      )
      .find((event) => event.type === 'usage')
    expect(usage).toMatchObject({
      inputTokens: 2,
      outputTokens: 1,
      cachedInputTokens: 0,
      costUsd: 0.01,
    })
  })
  it('combines SDK input usage at message_start with output-only message_delta for the context gauge', () => {
    const mapper = new ClaudeMessageMapper()
    mapper.map(
      message({
        type: 'stream_event',
        event: {
          type: 'message_start',
          message: { id: 'context', usage: { input_tokens: 100, cache_read_input_tokens: 50 } },
        },
      }),
    )
    expect(
      mapper.map(
        message({
          type: 'stream_event',
          event: { type: 'message_delta', usage: { output_tokens: 10 } },
        }),
      ),
    ).toContainEqual({ type: 'context-usage', usedTokens: 160, windowTokens: null })
  })
  it('subtracts a cold-resume accounting baseline instead of billing the old turns again', () => {
    const mapper = new ClaudeMessageMapper()
    mapper.seedUsage(0.1, {
      opus: { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 80 },
    })
    const usage = mapper
      .map(
        message({
          type: 'result',
          total_cost_usd: 0.12,
          modelUsage: { opus: { inputTokens: 110, outputTokens: 25, cacheReadInputTokens: 90 } },
        }),
      )
      .find((event) => event.type === 'usage')
    expect(usage).toMatchObject({
      inputTokens: 20,
      outputTokens: 5,
      cachedInputTokens: 10,
    })
    expect(usage?.costUsd).toBeCloseTo(0.02)
  })
  it('preserves Edit/Write/TodoWrite tool inputs for the existing diff and plan renderers', () => {
    const mapper = new ClaudeMessageMapper()
    const inputs = [
      {
        name: 'Edit',
        input: { file_path: '/repo/a.ts', old_string: 'before', new_string: 'after' },
      },
      { name: 'Write', input: { file_path: '/repo/a.ts', content: 'after' } },
      {
        name: 'TodoWrite',
        input: {
          todos: [
            {
              content: 'Implement parity',
              status: 'in_progress',
              activeForm: 'Implementing parity',
            },
          ],
        },
      },
    ]
    for (const [index, tool] of inputs.entries()) {
      const events = mapper.map(
        message({
          type: 'assistant',
          message: { content: [{ type: 'tool_use', id: `call-${index}`, ...tool }] },
        }),
      )
      expect(events).toEqual([
        {
          type: 'tool-started',
          callId: `call-${index}`,
          name: tool.name,
          argsJson: JSON.stringify(tool.input),
        },
      ])
    }
  })
  it.each(['authentication_failed', 'rate_limit', 'overloaded_error'])(
    'keeps %s visible as an explicit provider error',
    (error) => {
      expect(
        new ClaudeMessageMapper().map(
          message({
            type: 'assistant',
            error,
            message: {
              content: [{ type: 'text', text: 'Retry or resume after fixing the provider.' }],
            },
          }),
        ),
      ).toEqual([
        {
          type: 'error',
          message: `${error}: Retry or resume after fixing the provider.`,
          rawJson: null,
        },
      ])
    },
  )
  it('replays a real two-turn SDK recording without duplicated text or cumulative usage', () => {
    const mapper = new ClaudeMessageMapper()
    const lines = readFileSync(
      new URL('__fixtures__/sdk-two-turn-session.jsonl', import.meta.url),
      'utf8',
    )
      .trim()
      .split('\n')
    const messages = lines.map((line) => JSON.parse(line) as SDKMessage)
    const events = messages.flatMap((message) => mapper.map(message))
    expect(
      events
        .filter((event) => event.type === 'text-delta')
        .map((event) => event.text)
        .join(''),
    ).toBe('OKOK')
    expect(events.filter((event) => event.type === 'done')).toHaveLength(2)
    const costs = events
      .filter((event) => event.type === 'usage')
      .reduce((total, event) => total + (event.costUsd ?? 0), 0)
    const results = messages.filter((message) => message.type === 'result')
    expect(costs).toBeCloseTo(results.at(-1)!.total_cost_usd)
  })
  it('maps recorded cached usage including subagent models, then emits only subsequent cost/token deltas', () => {
    const mapper = new ClaudeMessageMapper()
    const lines = readFileSync(
      new URL('__fixtures__/cached-session.jsonl', import.meta.url),
      'utf8',
    )
      .trim()
      .split('\n')
    const events = lines.flatMap((line) => mapper.map(JSON.parse(line) as SDKMessage))
    expect(events.filter((event) => event.type === 'context-usage')).toHaveLength(3)
    const result = JSON.parse(lines.at(-1)!) as Record<string, unknown>
    expect(mapper.map(message(result)).find((event) => event.type === 'usage')).toMatchObject({
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    })
    expect(events.find((event) => event.type === 'usage')).toMatchObject({
      inputTokens: 17 + 47040 + 15507 + 4 + 6100 + 900,
      outputTokens: 166 + 210,
      costUsd: 0.036565,
    })
  })

  it('preserves recorded API errors and reports SDK error results with their errors array', () => {
    const mapper = new ClaudeMessageMapper()
    const recorded = readFileSync(
      new URL('__fixtures__/error-model-not-found.jsonl', import.meta.url),
      'utf8',
    )
      .trim()
      .split('\n')
    expect(
      recorded
        .flatMap((line) => mapper.map(JSON.parse(line) as SDKMessage))
        .some((event) => event.type === 'error' && event.message.includes('model')),
    ).toBe(true)
    expect(
      mapper.map(
        message({
          type: 'result',
          subtype: 'error_during_execution',
          errors: ['Process exited unexpectedly'],
        }),
      ),
    ).toContainEqual({ type: 'error', message: 'Process exited unexpectedly', rawJson: null })
  })

  it('streams text and thinking once and fills a missing final delta', () => {
    const mapper = new ClaudeMessageMapper()
    const events = [
      { type: 'stream_event', event: { type: 'message_start', message: { id: 'msg' } } },
      { type: 'stream_event', event: { delta: { type: 'text_delta', text: 'Hel' } } },
      {
        type: 'assistant',
        message: {
          id: 'msg',
          content: [
            { type: 'text', text: 'Hello' },
            { type: 'thinking', thinking: 'Consider this' },
          ],
        },
      },
    ].flatMap((frame) => mapper.map(message(frame)))
    expect(events).toEqual([
      { type: 'text-delta', text: 'Hel' },
      { type: 'text-delta', text: 'lo' },
      { type: 'thinking-delta', text: 'Consider this' },
    ])
  })

  it('deduplicates SDK retransmissions and repeated finalized tool calls', () => {
    const mapper = new ClaudeMessageMapper()
    const first = {
      type: 'assistant',
      uuid: 'one',
      message: {
        content: [
          { type: 'tool_use', id: 'call', name: 'Read', input: { file_path: '/repo/file' } },
        ],
      },
    }
    expect(mapper.map(message(first))).toHaveLength(1)
    expect(mapper.map(message(first))).toEqual([])
    expect(mapper.map(message({ ...first, uuid: 'two' }))).toEqual([])
  })

  it('surfaces rate limits and plan transitions as existing notices without failing the turn', () => {
    const mapper = new ClaudeMessageMapper()
    const events = mapper.map(
      message({
        type: 'rate_limit_event',
        rate_limit_info: {
          status: 'allowed_warning',
          rateLimitType: 'five_hour',
          utilization: 0.9,
          resetsAt: 2_000_000_000,
        },
      }),
    )
    expect(events).toEqual([
      {
        type: 'notice',
        message:
          'Claude five_hour limit: allowed_warning (90% used); resets 2033-05-18T03:33:20.000Z',
      },
    ])
    expect(
      mapper.map(message({ type: 'system', subtype: 'status', permissionMode: 'plan' })),
    ).toEqual([{ type: 'notice', message: 'Claude entered plan mode.' }])
    expect(
      mapper.map(message({ type: 'system', subtype: 'status', permissionMode: 'acceptEdits' })),
    ).toEqual([{ type: 'permission-mode', mode: 'allow-edits' }])
  })

  it('keeps child prose out of the parent transcript, in the subagent’s own', () => {
    expect(
      new ClaudeMessageMapper().map(
        message({
          type: 'assistant',
          parent_tool_use_id: 'agent-call',
          message: { content: [{ type: 'text', text: 'Private child reply' }] },
        }),
      ),
    ).toEqual([
      {
        type: 'subagent-activity',
        taskId: 'agent-call',
        event: { type: 'text-delta', text: 'Private child reply' },
      },
    ])
  })
})
