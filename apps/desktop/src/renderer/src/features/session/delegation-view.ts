import type { ChildTask } from '@ari/contracts/agent-control'
import type { DelegatedChild, DelegatedChildState } from '../transcript/types'
import type { SessionActivity } from './session-activity'

/** A `child.session.spawned` event as the transcript remembers it. */
export interface SpawnRecord {
  sessionId: string
  title: string
  role: string | null
  driverKind: string
  modelId: string | null
  /** The message and part on screen when the spawn happened. */
  anchor: { messageId: string | null; partIndex: number }
  destroyed: boolean
}

/**
 * A child's card state. Live activity wins while a turn runs because it
 * arrives with every event; the task snapshot, fetched on settle, decides how
 * a finished turn ended.
 */
export function delegatedChildState(
  task: ChildTask | undefined,
  activity: SessionActivity | undefined,
  destroyed: boolean,
): DelegatedChildState {
  if (destroyed) return 'removed'
  if (activity?.phase === 'paused') return 'needs-you'
  if (activity?.phase === 'working') return 'working'
  if (task === undefined) {
    if (activity?.phase === 'done') return 'done'
    return activity?.phase === 'error' ? 'failed' : 'idle'
  }
  switch (task.workState) {
    case 'working':
      return 'working'
    case 'blocked_on_user':
      return 'needs-you'
    case 'waiting_for_children':
      return 'waiting'
    case 'not_started':
      return 'idle'
    case 'result_available':
      if (task.latestTurn?.stopReason === 'error') return 'failed'
      return task.latestTurn?.stopReason === 'interrupted' ? 'stopped' : 'done'
  }
}

/** Joins spawn history with the latest task snapshot and live activity into task cards. */
export function delegatedChildren(
  spawns: readonly SpawnRecord[],
  tasks: readonly ChildTask[],
  activityOf?: (id: string) => SessionActivity | undefined,
): DelegatedChild[] {
  const byId = new Map(tasks.map((task) => [task.sessionId, task]))
  return spawns.map((spawn) => {
    const task = byId.get(spawn.sessionId)
    const activity = activityOf?.(spawn.sessionId)
    const state = delegatedChildState(task, activity, spawn.destroyed)
    return {
      sessionId: spawn.sessionId,
      title: task?.title ?? spawn.title,
      role: task?.role ?? spawn.role,
      driverKind: task?.driverKind ?? spawn.driverKind,
      modelId: task?.modelId ?? spawn.modelId,
      state,
      startedAt: state === 'working' ? (activity?.startedAt ?? null) : null,
      report: task?.report ?? null,
      anchor: spawn.anchor,
    }
  })
}
