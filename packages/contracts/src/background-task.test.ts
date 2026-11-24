import { describe, expect, it } from 'vitest'
import {
  foldBackgroundTask,
  MAX_BACKGROUND_TASKS,
  runningBackgroundTasks,
  type BackgroundTask,
} from './background-task'

describe('foldBackgroundTask', () => {
  it('joins explicitly bound native and launch records, preserving metadata and first start', () => {
    let tasks: BackgroundTask[] = []
    tasks = foldBackgroundTask(
      tasks,
      {
        taskId: 'native',
        providerItemId: 'native',
        providerThreadId: 'thread',
        kind: 'subagent',
        label: 'Fixture',
        status: 'running',
        model: 'model',
      },
      1,
    )
    tasks = foldBackgroundTask(
      tasks,
      {
        taskId: 'call',
        providerItemId: 'call',
        providerThreadId: 'thread',
        kind: 'subagent',
        label: 'Fixture',
        status: 'running',
        prompt: 'Inspect the fixture.',
      },
      2,
    )
    tasks = foldBackgroundTask(
      tasks,
      {
        taskId: 'other-thread',
        providerItemId: 'call',
        providerThreadId: 'other',
        kind: 'subagent',
        label: 'Fixture',
        status: 'running',
      },
      3,
    )
    expect(tasks).toHaveLength(3)
    tasks = foldBackgroundTask(
      tasks,
      {
        taskId: 'native',
        providerItemId: 'call',
        providerThreadId: 'thread',
        kind: 'subagent',
        label: 'Fixture',
        status: 'completed',
        result: 'Done.',
      },
      4,
    )
    expect(tasks).toHaveLength(2)
    expect(tasks[0]).toMatchObject({
      id: 'native',
      startedAt: 1,
      endedAt: 4,
      prompt: 'Inspect the fixture.',
      model: 'model',
      result: 'Done.',
    })
    expect(tasks[1]?.id).toBe('other-thread')
  })
  it('keeps the first start and end times while later reports change the rest', () => {
    let tasks: BackgroundTask[] = []
    tasks = foldBackgroundTask(
      tasks,
      { taskId: 'a', kind: 'subagent', label: 'Survey', status: 'running' },
      1,
    )
    tasks = foldBackgroundTask(
      tasks,
      { taskId: 'a', kind: 'subagent', label: '', status: 'completed', detail: 'Done' },
      5,
    )
    tasks = foldBackgroundTask(
      tasks,
      { taskId: 'a', kind: 'subagent', label: '', status: 'stopped' },
      9,
    )
    expect(tasks).toEqual([
      {
        id: 'a',
        kind: 'subagent',
        label: 'Survey',
        status: 'stopped',
        detail: 'Done',
        startedAt: 1,
        updatedAt: 9,
        endedAt: 5,
      },
    ])
  })

  it('keeps what a subagent was asked while later reports add its model and result', () => {
    let tasks: BackgroundTask[] = []
    tasks = foldBackgroundTask(
      tasks,
      {
        taskId: 'a',
        kind: 'subagent',
        label: 'Survey',
        status: 'running',
        subagentType: 'Explore',
        prompt: 'Look around',
      },
      1,
    )
    tasks = foldBackgroundTask(
      tasks,
      { taskId: 'a', kind: 'subagent', label: '', status: 'running', model: 'haiku' },
      2,
    )
    tasks = foldBackgroundTask(
      tasks,
      { taskId: 'a', kind: 'subagent', label: '', status: 'completed', result: 'Found it.' },
      3,
    )
    expect(tasks[0]).toMatchObject({
      subagentType: 'Explore',
      prompt: 'Look around',
      model: 'haiku',
      result: 'Found it.',
      status: 'completed',
    })
  })

  it('drops finished tasks before running ones past the cap', () => {
    let tasks: BackgroundTask[] = []
    tasks = foldBackgroundTask(
      tasks,
      { taskId: 'live', kind: 'shell', label: 'dev server', status: 'running' },
      0,
    )
    for (let i = 0; i < MAX_BACKGROUND_TASKS + 5; i++)
      tasks = foldBackgroundTask(
        tasks,
        { taskId: `done_${i}`, kind: 'shell', label: 'job', status: 'completed' },
        i + 1,
      )
    expect(tasks).toHaveLength(MAX_BACKGROUND_TASKS)
    expect(runningBackgroundTasks(tasks).map((task) => task.id)).toEqual(['live'])
    expect(tasks.at(-1)?.id).toBe(`done_${MAX_BACKGROUND_TASKS + 4}`)
  })
})
