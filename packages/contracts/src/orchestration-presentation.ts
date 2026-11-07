import type { ChildTask } from './agent-control'
import type { OrchestrationTask } from './orchestration'

export type WorkState =
  | 'idle'
  | 'queued'
  | 'starting'
  | 'working'
  | 'waiting'
  | 'needs-lead'
  | 'needs-you'
  | 'stopping'
  | 'completed'
  | 'failed'
  | 'interrupted'
  | 'unknown'
export const WORK_LABEL: Record<WorkState, string> = {
  idle: 'Not started',
  queued: 'Queued',
  starting: 'Starting',
  working: 'Working',
  waiting: 'Waiting for agents',
  'needs-lead': 'Needs lead',
  'needs-you': 'Needs you',
  stopping: 'Stopping',
  completed: 'Result ready',
  failed: 'Failed',
  interrupted: 'Interrupted',
  unknown: 'Activity unknown',
}
export interface WorkPresentation {
  state: WorkState
  label: string
  live: boolean
  attentionOwner: 'human' | 'lead' | null
}

function present(state: WorkState, label = WORK_LABEL[state]): WorkPresentation {
  return {
    state,
    label,
    live: !['idle', 'completed', 'failed', 'interrupted'].includes(state),
    attentionOwner: state === 'needs-you' ? 'human' : state === 'needs-lead' ? 'lead' : null,
  }
}

/** Legacy CLI work and app-owned tasks use the same vocabulary. */
export function presentChildTask(task: ChildTask | OrchestrationTask): WorkPresentation {
  if ('currentActivity' in task) return presentOrchestrationTask(task)
  switch (task.workState) {
    case 'not_started':
      return present('idle')
    case 'queued':
      return present('queued')
    case 'working':
      return present('working')
    case 'waiting_for_children':
      return present('waiting')
    case 'blocked_on_parent':
      return present('needs-lead')
    case 'blocked_on_user':
      return present('needs-you')
    case 'result_available':
      return present(
        task.latestTurn?.stopReason === 'error'
          ? 'failed'
          : task.latestTurn?.stopReason === 'interrupted'
            ? 'interrupted'
            : 'completed',
      )
  }
}

export function presentOrchestrationTask(task: OrchestrationTask): WorkPresentation {
  const activity = task.currentActivity
  const observed = (value: WorkPresentation): WorkPresentation => ({
    ...value,
    live: value.live && activity.freshness === 'live' && activity.phase !== 'ended',
  })
  if (activity.decisionOwner)
    return observed(present(activity.decisionOwner === 'human' ? 'needs-you' : 'needs-lead'))
  if (activity.phase === 'ended') {
    const result = task.results.find((item) => item.resultId === task.currentResultId)
    if (result?.reviewState === 'changes_requested')
      return observed(present('needs-lead', 'Changes requested'))
    const label =
      result?.reviewState === 'integrated'
        ? 'Integrated'
        : result?.reviewState === 'accepted'
          ? 'Accepted'
          : result?.reviewState === 'reviewing'
            ? 'Reviewing result'
            : undefined
    return observed(present(activity.terminalStatus ?? 'unknown', label))
  }
  return observed(
    present(
      activity.phase,
      activity.phase === 'waiting' && activity.waitReason === 'dependencies'
        ? 'Waiting for prerequisites'
        : undefined,
    ),
  )
}
