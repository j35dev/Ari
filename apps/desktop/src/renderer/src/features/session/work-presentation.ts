import type { ChildTask } from '@ari/contracts/agent-control'
import type { OrchestrationTask } from '@ari/contracts/orchestration'

export { WORK_LABEL } from '@ari/contracts/orchestration-presentation'
import {
  presentChildTask,
  presentOrchestrationTask,
  type WorkState,
} from '@ari/contracts/orchestration-presentation'
export type { WorkState } from '@ari/contracts/orchestration-presentation'

export function workState(task: ChildTask | OrchestrationTask): WorkState {
  return ('currentActivity' in task ? presentOrchestrationTask(task) : presentChildTask(task)).state
}

export function workLabel(task: ChildTask | OrchestrationTask): string {
  return ('currentActivity' in task ? presentOrchestrationTask(task) : presentChildTask(task)).label
}

export const isWorkLive = (state: WorkState) =>
  !['idle', 'completed', 'failed', 'interrupted'].includes(state)
/** Only successful finished work folds automatically; problems remain reachable. */
export const isWorkFolded = (task: ChildTask | OrchestrationTask) => workState(task) === 'completed'
const ORDER: WorkState[] = [
  'needs-you',
  'needs-lead',
  'failed',
  'unknown',
  'working',
  'starting',
  'waiting',
  'stopping',
  'queued',
  'interrupted',
  'completed',
  'idle',
]

export function orderWork(tasks: readonly ChildTask[]): ChildTask[] {
  return [...tasks].sort((a, b) => ORDER.indexOf(workState(a)) - ORDER.indexOf(workState(b)))
}

export function workSummary(tasks: readonly (ChildTask | OrchestrationTask)[]): string {
  const states = tasks.map(workState)
  const pieces: string[] = []
  const phrases: Partial<Record<WorkState, string>> = {
    'needs-you': 'need you',
    'needs-lead': 'need lead',
    failed: 'failed',
    working: 'working',
    waiting: 'waiting',
    starting: 'starting',
    stopping: 'stopping',
    unknown: 'activity unknown',
    queued: 'queued',
    completed: 'results ready',
    interrupted: 'interrupted',
    idle: 'not started',
  }
  for (const state of ORDER) {
    if (state === 'completed') {
      const labels = tasks.filter((task) => workState(task) === state).map(workLabel)
      for (const label of [
        'Result ready',
        'Reviewing result',
        'Changes requested',
        'Accepted',
        'Integrated',
      ]) {
        const count = labels.filter((value) => value === label).length
        if (count)
          pieces.push(
            `${count} ${label === 'Result ready' && count > 1 ? 'results ready' : label.toLowerCase()}`,
          )
      }
      continue
    }
    const count = states.filter((value) => value === state).length
    if (count)
      pieces.push(
        `${count} ${count === 1 && state === 'needs-you' ? 'needs you' : count === 1 && state === 'needs-lead' ? 'needs lead' : phrases[state]}`,
      )
  }
  return pieces.slice(0, 3).join(' · ')
}
