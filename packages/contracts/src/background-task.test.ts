import { describe, expect, it } from 'vitest'
import {
  foldBackgroundTask,
  MAX_BACKGROUND_TASKS,
  runningBackgroundTasks,
  type BackgroundTask,
} from './background-task'

describe('foldBackgroundTask', () => {
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
