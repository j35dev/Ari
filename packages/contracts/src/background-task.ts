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

/** Longest sub-agent prompt or result a report carries; the rest is cut. */
export const MAX_SUBAGENT_TEXT = 16_000

/**
 * What a native sub-agent was asked and what it answered, when the harness
 * says. Each is optional on a report: absent keeps the last value.
 */
export const subagentFields = {
  /** The harness's agent type (`general-purpose`, `Explore`). */
  subagentType: z.string().max(200).nullable().optional(),
  prompt: z.string().max(MAX_SUBAGENT_TEXT).nullable().optional(),
  model: z.string().max(200).nullable().optional(),
  /** Its final answer, once it has one. */
  result: z.string().max(MAX_SUBAGENT_TEXT).nullable().optional(),
}

export interface SubagentDetails {
  subagentType?: string | null
  prompt?: string | null
  model?: string | null
  result?: string | null
}

/** One task as the session read model holds it. */
export interface BackgroundTask extends ProviderTaskIdentity, SubagentDetails {
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
export interface BackgroundTaskReport extends ProviderTaskIdentity, SubagentDetails {
  taskId: string
  kind: BackgroundTaskKind
  label: string
  status: BackgroundTaskStatus
  detail?: string | null | undefined
}

/** Cuts a sub-agent prompt or result to what a report may carry. */
export function clipSubagentText(value: string): string {
  return value.length > MAX_SUBAGENT_TEXT ? `${value.slice(0, MAX_SUBAGENT_TEXT - 1)}…` : value
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
    ...subagentDetails(previous, report),
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

function subagentDetails(
  previous: SubagentDetails | undefined,
  report: SubagentDetails,
): SubagentDetails {
  const details: SubagentDetails = {}
  for (const key of ['subagentType', 'prompt', 'model', 'result'] as const) {
    const value = report[key] !== undefined ? report[key] : previous?.[key]
    if (value !== undefined) details[key] = value
  }
  return details
}

/** The tasks still running, oldest first. */
export function runningBackgroundTasks(tasks: readonly BackgroundTask[]): BackgroundTask[] {
  return tasks.filter((task) => task.status === 'running')
}
