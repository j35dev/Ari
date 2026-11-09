import { describe, expect, it } from 'vitest'
import { ClaudeBackgroundTasks } from './background-tasks'
import { mapClaudeLine, type NativeLine } from './mapper'

const launch = (input: Record<string, unknown> = {}): NativeLine => ({
  type: 'assistant',
  message: {
    content: [
      {
        type: 'tool_use',
        id: 'call',
        name: 'Agent',
        input: { description: 'Read orchestration', ...input },
      },
    ],
  },
})
const result: NativeLine = {
  type: 'user',
  message: { content: [{ type: 'tool_result', tool_use_id: 'call', content: 'Launched' }] },
}
const started: NativeLine = {
  type: 'system',
  subtype: 'task_started',
  task_id: 'agent',
  tool_use_id: 'call',
  task_type: 'local_agent',
  description: 'Read orchestration',
  is_backgrounded: true,
  run_id: '01',
}

describe('Claude native tasks', () => {
  it('tracks concurrent Agent and Task calls and attributes child activity', () => {
    const tasks = new ClaudeBackgroundTasks()
    tasks.observe({ type: 'system', subtype: 'init', session_id: 'thread' })
    expect(tasks.observe(launch())).toMatchObject([
      { id: 'call', status: 'running', label: 'Read orchestration', providerThreadId: 'thread' },
    ])
    tasks.observe({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', id: 'other', name: 'Task', input: { description: 'Read box-yard' } },
        ],
      },
    })
    expect(tasks.running()).toHaveLength(2)
    expect(
      tasks.observe({
        type: 'assistant',
        parent_tool_use_id: 'call',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'read',
              name: 'Read',
              input: { file_path: 'server/captains.ts' },
            },
          ],
        },
      }),
    ).toMatchObject([{ id: 'call', detail: 'server/captains.ts', status: 'running' }])
  })

  it('ends a foreground agent with its result, but keeps async agents after the main reply', () => {
    const foreground = new ClaudeBackgroundTasks()
    foreground.observe(launch())
    expect(foreground.observe(result)).toMatchObject([{ status: 'completed' }])
    const tasks = new ClaudeBackgroundTasks()
    tasks.observe(launch({ run_in_background: true }))
    tasks.observe(result)
    expect(tasks.observe({ type: 'result' })).toEqual([])
    expect(tasks.running()).toHaveLength(1)
  })

  it('recognizes an async launch even when run_in_background was omitted', () => {
    const tasks = new ClaudeBackgroundTasks()
    tasks.observe(launch())
    tasks.observe({ ...result, tool_use_result: { isAsync: true, agentId: 'agent' } })
    expect(
      tasks.observe({
        type: 'system',
        subtype: 'task_notification',
        task_id: 'agent',
        status: 'completed',
        summary: 'Mapped the workflow',
      }),
    ).toMatchObject([{ id: 'call', status: 'completed', detail: 'Mapped the workflow' }])
  })

  it.each(['completed', 'failed', 'stopped'])(
    'joins task bookends to their tool call and reports %s',
    (status) => {
      const tasks = new ClaudeBackgroundTasks()
      tasks.observe(launch({ run_in_background: true }))
      tasks.observe(started)
      expect(tasks.running()).toHaveLength(1)
      expect(
        tasks.observe({
          ...started,
          subtype: 'task_progress',
          last_tool_name: 'Read',
          summary: 'Checking the durable workflows',
        }),
      ).toMatchObject([{ id: 'call', detail: 'Checking the durable workflows' }])
      expect(
        tasks.observe({
          ...started,
          subtype: 'task_notification',
          status,
          summary: 'Research ended',
        }),
      ).toMatchObject([{ id: 'call', status, detail: 'Research ended' }])
      expect(tasks.running()).toEqual([])
    },
  )

  it('reopens a resumed run and ignores a late bookend from its preceding run', () => {
    const tasks = new ClaudeBackgroundTasks()
    tasks.observe(started)
    tasks.observe({ ...started, subtype: 'task_notification', status: 'completed' })
    tasks.observe({ ...started, run_id: '02' })
    expect(tasks.observe({ ...started, subtype: 'task_notification', status: 'stopped' })).toEqual(
      [],
    )
    expect(tasks.running()).toMatchObject([{ status: 'running' }])
  })

  it('accepts level snapshots before a task start without duplicating its row', () => {
    const tasks = new ClaudeBackgroundTasks()
    tasks.observe({
      type: 'system',
      subtype: 'background_tasks_changed',
      tasks: [
        {
          task_id: 'agent',
          task_type: 'local_agent',
          description: 'Read orchestration',
          run_id: '01',
        },
        { task_id: 'ambient', task_type: 'local_agent', ambient: true },
      ],
    })
    tasks.observe(started)
    tasks.observe(launch())
    expect(tasks.running()).toHaveLength(1)
    expect(
      tasks.observe({ type: 'system', subtype: 'background_tasks_changed', tasks: [] }),
    ).toMatchObject([{ status: 'stopped', detail: 'No longer reported as running' }])
    expect(
      tasks.observe({ ...started, subtype: 'task_notification', status: 'failed' }),
    ).toMatchObject([{ status: 'failed' }])
  })

  it('keeps a tool-backed agent running while an early level snapshot has not yet bound its native id', () => {
    const tasks = new ClaudeBackgroundTasks()
    tasks.observe(launch({ run_in_background: true }))
    expect(
      tasks.observe({
        type: 'system',
        subtype: 'background_tasks_changed',
        tasks: [
          {
            task_id: 'agent',
            task_type: 'local_agent',
            description: 'Read orchestration',
            run_id: '01',
          },
        ],
      }),
    ).toEqual([])
    tasks.observe(started)
    expect(tasks.running()).toMatchObject([{ id: 'call', status: 'running' }])
  })

  it('observes shells only in the background and handles TaskStop by native id', () => {
    const tasks = new ClaudeBackgroundTasks()
    expect(tasks.observe({ ...started, task_type: 'local_bash', is_backgrounded: false })).toEqual(
      [],
    )
    tasks.observe({ ...started, task_type: 'local_bash', is_backgrounded: true })
    tasks.observe({
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', id: 'stop', name: 'TaskStop', input: { task_id: 'agent' } }],
      },
    })
    expect(
      tasks.observe({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'stop' }] },
      }),
    ).toMatchObject([{ kind: 'shell', status: 'stopped' }])
  })

  it('keeps native task metadata and subagent prose out of the parent transcript', () => {
    expect(mapClaudeLine(JSON.stringify({ ...started, session_id: 'thread' }))).toEqual([])
    expect(
      mapClaudeLine(
        JSON.stringify({
          type: 'stream_event',
          parent_tool_use_id: 'call',
          event: { delta: { type: 'text_delta', text: 'Private agent research' } },
        }),
      ),
    ).toEqual([])
    expect(
      mapClaudeLine(
        JSON.stringify({ type: 'assistant', parent_tool_use_id: 'call', error: 'tool_error' }),
      ),
    ).toEqual([])
  })
})
