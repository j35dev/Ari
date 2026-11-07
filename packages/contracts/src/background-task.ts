import { z } from 'zod'

/**
 * Work an agent's own harness runs beside its main conversation: a sub-agent
 * (Claude Code's Agent/Task tool, a Codex collab agent) or a shell command it
 * sent to the background. Ari only observes these; it does not run them.
 */
export const backgroundTaskKindSchema = z.enum(['subagent', 'shell'])
export type BackgroundTaskKind = z.infer<typeof backgroundTaskKindSchema>

export const backgroundTaskStatusSchema = z.enum(['running', 'completed', 'failed', 'stopped'])
export type BackgroundTaskStatus = z.infer<typeof backgroundTaskStatusSchema>

export interface ProviderTaskIdentity {
  providerThreadId?: string
  providerTurnId?: string
  providerItemId?: string
}

/** One task as the session read model holds it. */
export interface BackgroundTask extends ProviderTaskIdentity {
  id: string
  kind: BackgroundTaskKind
  label: string
  status: BackgroundTaskStatus
  /** What it is doing now, or how it ended; null when nothing is known. */
  detail: string | null
  startedAt: number
  updatedAt: number
  /** When it stopped running; null while it runs. */
  endedAt: number | null
}

/** A report about one task, as journaled. An absent `detail` keeps the last one. */
export interface BackgroundTaskReport extends ProviderTaskIdentity {
  taskId: string
  kind: BackgroundTaskKind
  label: string
  status: BackgroundTaskStatus
  detail?: string | null | undefined
}

/** Tasks a session keeps; finished ones are dropped oldest first past this. */
export const MAX_BACKGROUND_TASKS = 40

/**
 * Folds one report into a session's task list. The latest report wins, so a
 * task can also reopen (a sub-agent found to run on asynchronously after its
 * call returned). Shared by the engine projection and the renderer.
 */
export function foldBackgroundTask(
  tasks: readonly BackgroundTask[],
  report: BackgroundTaskReport,
  at: number,
): BackgroundTask[] {
  const previous = tasks.find((task) => task.id === report.taskId)
  const running = report.status === 'running'
  const next: BackgroundTask = {
    id: report.taskId,
    ...(previous?.providerThreadId ? { providerThreadId: previous.providerThreadId } : {}),
    ...(previous?.providerTurnId ? { providerTurnId: previous.providerTurnId } : {}),
    ...(previous?.providerItemId ? { providerItemId: previous.providerItemId } : {}),
    ...(report.providerThreadId !== undefined ? { providerThreadId: report.providerThreadId } : {}),
    ...(report.providerTurnId !== undefined ? { providerTurnId: report.providerTurnId } : {}),
    ...(report.providerItemId !== undefined ? { providerItemId: report.providerItemId } : {}),
    kind: report.kind,
    label: report.label.length > 0 ? report.label : (previous?.label ?? ''),
    status: report.status,
    detail: report.detail !== undefined ? report.detail : (previous?.detail ?? null),
    startedAt: previous?.startedAt ?? at,
    updatedAt: at,
    endedAt: running ? null : previous?.endedAt != null ? previous.endedAt : at,
  }
  const list = previous ? tasks.map((task) => (task === previous ? next : task)) : [...tasks, next]
  let excess = list.length - MAX_BACKGROUND_TASKS
  if (excess <= 0) return list
  // Finished tasks go first; running ones only when nothing else is left.
  const kept = list.filter((task) => {
    if (excess > 0 && task.status !== 'running') {
      excess--
      return false
    }
    return true
  })
  return excess > 0 ? kept.slice(excess) : kept
}

/** The tasks still running, oldest first. */
export function runningBackgroundTasks(tasks: readonly BackgroundTask[]): BackgroundTask[] {
  return tasks.filter((task) => task.status === 'running')
}
