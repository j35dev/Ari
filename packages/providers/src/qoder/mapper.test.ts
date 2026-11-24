import { describe, expect, it } from 'vitest'
import type { SDKMessage } from '@qoder-ai/qoder-agent-sdk'
import { pushMessageParts, type MessagePart } from '@ari/contracts/message'
import { QoderMessageMapper } from './mapper'

const sdk = (value: unknown) => value as SDKMessage
const partial = (event: unknown, parent_tool_use_id: string | null = null) =>
  sdk({ type: 'stream_event', session_id: 's', parent_tool_use_id, uuid: 'partial', event })
const result = (uuid = 'result') =>
  sdk({
    type: 'result',
    subtype: 'success',
    session_id: 's',
    uuid,
    is_error: false,
    result: 'subscription.',
    usage: { input_tokens: 10, output_tokens: 4 },
    total_cost_usd: 0,
    terminal_reason: 'completed',
  })

describe('QoderMessageMapper', () => {
  it('joins late native/tool bindings and routes streamed model and current tool to the child', () => {
    const mapper = new QoderMessageMapper()
    const started = sdk({
      type: 'system',
      subtype: 'task_started',
      session_id: 's',
      task_id: 'native',
      task_type: 'local_agent',
      description: 'Fixture agent',
    })
    mapper.map(started)
    mapper.map(
      partial({
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'tool_use',
          id: 'call',
          name: 'Agent',
          input: { prompt: 'Inspect fixture.' },
        },
      }),
    )
    expect(mapper.tasks.size).toBe(2)
    mapper.map(sdk({ ...started, tool_use_id: 'call' }))
    expect(mapper.tasks.size).toBe(1)
    expect(mapper.tasks.get('native')).toMatchObject({
      nativeId: 'native',
      event: { providerItemId: 'call', prompt: 'Inspect fixture.' },
    })
    const model = mapper.map(
      partial({ type: 'message_start', message: { id: 'child', model: 'reported-model' } }, 'call'),
    )
    expect(model).toMatchObject([
      { type: 'background-task', id: 'native', model: 'reported-model' },
    ])
    const read = mapper.map(
      partial(
        {
          type: 'content_block_start',
          index: 0,
          content_block: {
            type: 'tool_use',
            id: 'read',
            name: 'Read',
            input: { file_path: 'fixture.txt' },
          },
        },
        'call',
      ),
    )
    expect(read.find((event) => event.type === 'background-task')).toMatchObject({
      id: 'native',
      detail: 'fixture.txt',
    })
    expect(read.find((event) => event.type === 'subagent-activity')).toMatchObject({
      taskId: 'native',
      event: { type: 'tool-started', callId: 'read' },
    })
    expect(read.some((event) => event.type === 'tool-started')).toBe(false)
  })
  it('tracks foreground Agent launches with their prompt, model and result', () => {
    const mapper = new QoderMessageMapper()
    const launched = mapper.map(
      sdk({
        type: 'assistant',
        session_id: 's',
        uuid: 'parent',
        parent_tool_use_id: null,
        message: {
          id: 'm',
          content: [
            {
              type: 'tool_use',
              id: 'agent-call',
              name: 'Agent',
              input: {
                description: 'Survey fixture',
                prompt: 'Inspect the fixture only.',
                subagent_type: 'reviewer',
              },
            },
          ],
        },
      }),
    )
    expect(launched.find((event) => event.type === 'background-task')).toMatchObject({
      id: 'agent-call',
      kind: 'subagent',
      label: 'Survey fixture',
      status: 'running',
      prompt: 'Inspect the fixture only.',
      subagentType: 'reviewer',
      providerThreadId: 's',
    })
    const child = mapper.map(
      sdk({
        type: 'assistant',
        session_id: 's',
        uuid: 'child',
        parent_tool_use_id: 'agent-call',
        message: {
          id: 'child-m',
          model: 'qoder-model',
          content: [{ type: 'text', text: 'Fixture report.' }],
        },
      }),
    )
    expect(child.find((event) => event.type === 'background-task')).toMatchObject({
      model: 'qoder-model',
    })
    expect(child.find((event) => event.type === 'subagent-activity')).toMatchObject({
      taskId: 'agent-call',
      event: { type: 'text-delta', text: 'Fixture report.' },
    })
    const completed = mapper.map(
      sdk({
        type: 'user',
        session_id: 's',
        uuid: 'output',
        parent_tool_use_id: null,
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'agent-call',
              content: [{ type: 'text', text: 'Fixture report.' }],
            },
          ],
        },
      }),
    )
    expect(completed.find((event) => event.type === 'background-task')).toMatchObject({
      id: 'agent-call',
      status: 'completed',
      result: 'Fixture report.',
    })
    expect(mapper.tasks.get('agent-call')?.event).toMatchObject({
      prompt: 'Inspect the fixture only.',
      model: 'qoder-model',
      result: 'Fixture report.',
    })
  })
  it('keeps background agents running after the parent result and correlates native IDs', () => {
    const mapper = new QoderMessageMapper()
    mapper.map(
      sdk({
        type: 'assistant',
        session_id: 's',
        uuid: 'parent',
        parent_tool_use_id: null,
        message: {
          id: 'm',
          content: [
            {
              type: 'tool_use',
              id: 'agent-call',
              name: 'Agent',
              input: {
                description: 'Background fixture',
                prompt: 'Fixture only.',
                subagent_type: 'reviewer',
                run_in_background: true,
              },
            },
          ],
        },
      }),
    )
    mapper.map(
      sdk({
        type: 'system',
        subtype: 'task_started',
        session_id: 's',
        uuid: 'started',
        task_id: 'native-task',
        tool_use_id: 'agent-call',
        task_type: 'local_agent',
        description: 'Background fixture',
        subagent_type: 'reviewer',
      }),
    )
    mapper.map(result())
    expect(mapper.tasks.size).toBe(1)
    expect(mapper.tasks.get('agent-call')).toMatchObject({
      nativeId: 'native-task',
      event: { status: 'running' },
    })
    expect(mapper.taskIdOf('native-task')).toBe('agent-call')
    mapper.map(partial({ type: 'message_start', message: { id: 'child' } }, 'native-task'))
    const routed = mapper.map(
      partial(
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'Child fixture report' },
        },
        'native-task',
      ),
    )
    expect(routed.find((event) => event.type === 'subagent-activity')).toMatchObject({
      taskId: 'agent-call',
    })
    mapper.map(
      sdk({
        type: 'system',
        subtype: 'task_updated',
        session_id: 's',
        uuid: 'stopped',
        task_id: 'native-task',
        patch: { status: 'killed' },
      }),
    )
    expect(mapper.tasks.get('agent-call')?.event.status).toBe('stopped')
  })
  it('preserves root stream identity when a child streams between root chunks', () => {
    const mapper = new QoderMessageMapper()
    mapper.map(partial({ type: 'message_start', message: { id: 'root-message' } }))
    const first = mapper
      .map(
        partial({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'sub' },
        }),
      )
      .find((event) => event.type === 'text-delta')
    mapper.map(partial({ type: 'message_start', message: { id: 'child-message' } }, 'child'))
    mapper.map(
      partial(
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'Child fixture' },
        },
        'child',
      ),
    )
    const last = mapper
      .map(
        partial({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'scription' },
        }),
      )
      .find((event) => event.type === 'text-delta')
    expect(first).toMatchObject({ streamId: 'qoder:s:root:root-message:text:0' })
    expect(last).toMatchObject({ streamId: 'qoder:s:root:root-message:text:0' })
  })
  it('uses the terminal reply when earlier assistant text was only a tool prelude', () => {
    const mapper = new QoderMessageMapper()
    mapper.map(
      sdk({
        type: 'assistant',
        session_id: 's',
        parent_tool_use_id: null,
        uuid: 'a',
        message: {
          id: 'm',
          content: [
            { type: 'text', text: 'Checking fixture.' },
            { type: 'tool_use', id: 't', name: 'Read', input: {} },
          ],
        },
      }),
    )
    expect(mapper.map(result()).find((event) => event.type === 'text-delta')).toMatchObject({
      text: 'subscription.',
      replace: true,
    })
  })
  it('does not turn a synthesized retry message into a terminal error', () => {
    const mapper = new QoderMessageMapper()
    expect(
      mapper
        .map(
          sdk({
            type: 'assistant',
            session_id: 's',
            parent_tool_use_id: null,
            uuid: 'error',
            isApiErrorMessage: true,
            error: 'server_error',
            message: { content: [{ type: 'text', text: 'Transient fixture error' }] },
          }),
        )
        .some((event) => event.type === 'error' || event.type === 'text-delta'),
    ).toBe(false)
  })
  it('reconciles full messages against text/private deltas using stable block identity', () => {
    const mapper = new QoderMessageMapper()
    const events = [
      ...mapper.map(partial({ type: 'message_start', message: { id: 'm' } })),
      ...mapper.map(
        partial({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'sub' },
        }),
      ),
      ...mapper.map(
        partial({
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'thinking_delta', thinking: 'opaque fixture' },
        }),
      ),
      ...mapper.map(
        partial({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'scription' },
        }),
      ),
      ...mapper.map(
        sdk({
          type: 'assistant',
          session_id: 's',
          uuid: 'assistant',
          parent_tool_use_id: null,
          message: {
            id: 'm',
            content: [
              { type: 'text', text: 'subscription.' },
              { type: 'thinking', thinking: 'opaque fixture' },
            ],
          },
        }),
      ),
      ...mapper.map(result()),
    ]
    const parts: MessagePart[] = []
    for (const event of events)
      if (event.type === 'text-delta' || event.type === 'thinking-delta')
        pushMessageParts(parts, [
          {
            type: event.type === 'text-delta' ? 'text' : 'thinking',
            text: event.text,
            streamId: event.streamId,
            replace: event.replace,
          },
        ])
    expect(parts.filter((part) => part.type === 'text')).toHaveLength(1)
    expect(parts[0]).toMatchObject({
      type: 'text',
      text: 'subscription.',
      streamId: 'qoder:s:root:m:text:0',
    })
    expect(parts.filter((part) => part.type === 'thinking')).toHaveLength(1)
    expect(events.filter((event) => event.type === 'session-ref')).toHaveLength(1)
    expect(events.filter((event) => event.type === 'done')).toHaveLength(1)
  })
  it('keeps partial tool input and output distinct from completion', () => {
    const mapper = new QoderMessageMapper()
    mapper.map(partial({ type: 'message_start', message: { id: 'm' } }))
    const started = mapper.map(
      partial({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 't', name: 'Bash', input: {} },
      }),
    )
    expect(started).toContainEqual({
      type: 'tool-started',
      callId: 't',
      name: 'Bash',
      argsJson: '{}',
    })
    expect(
      mapper.map(
        partial({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{"command":' },
        }),
      ),
    ).toEqual([])
    expect(
      mapper.map(
        partial({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '"test"}' },
        }),
      ),
    ).toContainEqual({
      type: 'tool-started',
      callId: 't',
      name: 'Bash',
      argsJson: '{"command":"test"}',
    })
    expect(
      mapper.map(
        sdk({
          type: 'tool_progress',
          session_id: 's',
          tool_use_id: 't',
          output: 'running',
          parent_tool_use_id: null,
        }),
      ),
    ).toEqual([{ type: 'tool-progress', callId: 't', resultJson: '"running"' }])
    const done = sdk({
      type: 'user',
      session_id: 's',
      parent_tool_use_id: null,
      message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'exit 0' }] },
    })
    expect(mapper.map(done)).toContainEqual({
      type: 'tool-completed',
      callId: 't',
      resultJson: '"exit 0"',
      isError: false,
    })
    expect(mapper.map(done)).toEqual([])
  })
  it('routes native child output to the child transcript', () => {
    const mapper = new QoderMessageMapper()
    mapper.map(partial({ type: 'message_start', message: { id: 'child' } }, 'parent-call'))
    expect(
      mapper.map(
        partial(
          {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'Child fixture report.' },
          },
          'parent-call',
        ),
      ),
    ).toEqual([
      {
        type: 'subagent-activity',
        taskId: 'parent-call',
        event: {
          type: 'text-delta',
          text: 'Child fixture report.',
          streamId: 'qoder:s:parent-call:child:text:0',
        },
      },
    ])
  })
  it('records background task lifecycle and deduplicates terminal result delivery', () => {
    const mapper = new QoderMessageMapper()
    const started = mapper.map(
      sdk({
        type: 'system',
        subtype: 'task_started',
        session_id: 's',
        task_id: 'native',
        task_type: 'local_agent',
        tool_use_id: 'call',
        description: 'Review fixture',
      }),
    )
    expect(started.find((event) => event.type === 'background-task')).toMatchObject({
      id: 'call',
      kind: 'subagent',
      status: 'running',
    })
    expect(
      mapper
        .map(
          sdk({
            type: 'system',
            subtype: 'task_notification',
            session_id: 's',
            task_id: 'native',
            tool_use_id: 'call',
            status: 'failed',
            summary: 'Fixture failed',
          }),
        )
        .find((event) => event.type === 'background-task'),
    ).toMatchObject({ status: 'failed', detail: 'Fixture failed' })
    mapper.map(result())
    expect(mapper.map(result())).toEqual([])
  })
})
