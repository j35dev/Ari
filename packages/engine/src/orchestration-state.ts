import { ControlFailure, type ChildTask } from '@ari/contracts/agent-control'
import type {
  OrchestrationActivity,
  OrchestrationRequest,
  OrchestrationTaskRecord,
} from '@ari/contracts/orchestration'
import type { SessionReadModel } from './projection'

export function assertTaskDag(tasks: readonly OrchestrationTaskRecord[]): void {
  const byId = new Map(tasks.map((task) => [task.taskId, task]))
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (id: string): void => {
    if (visiting.has(id))
      throw new ControlFailure('dependency_cycle', 'Task dependencies contain a cycle.')
    if (visited.has(id)) return
    const task = byId.get(id)
    if (!task)
      throw new ControlFailure('dependency_not_found', 'Dependency is outside this task family.')
    visiting.add(id)
    for (const dependency of task.assignment?.dependsOn ?? []) visit(dependency)
    visiting.delete(id)
    visited.add(id)
  }
  for (const task of tasks) visit(task.taskId)
}

export function dependenciesAccepted(
  task: OrchestrationTaskRecord,
  tasks: readonly OrchestrationTaskRecord[],
): boolean {
  return (task.assignment?.dependsOn ?? []).every((id) => {
    const dependency = tasks.find((entry) => entry.taskId === id)
    const result = dependency?.results.find(
      (entry) => entry.resultId === dependency.currentResultId,
    )
    return Boolean(
      result &&
      result.attemptId === dependency?.currentAttemptId &&
      !result.snapshotUnavailable &&
      (result.snapshotCommit
        ? result.reviewState === 'integrated'
        : result.reviewState === 'accepted' || result.reviewState === 'integrated'),
    )
  })
}

/** Shared projection: lifecycle is separate from review and integration. */
export function orchestrationActivity(
  task: OrchestrationTaskRecord,
  child: ChildTask | null,
  model: SessionReadModel | null,
  live: boolean,
  ready: boolean,
  requests: readonly OrchestrationRequest[],
  family: readonly OrchestrationTaskRecord[] = [],
): OrchestrationActivity {
  const activity: OrchestrationActivity = {
    phase: 'queued',
    waitReason: null,
    decisionOwner: null,
    terminalStatus: null,
    detail: null,
    observedAt: model?.lastObservedAt ?? null,
    freshness: live ? 'live' : 'journal',
  }
  const attempt = task.attempts.find((entry) => entry.attemptId === task.currentAttemptId)
  if (attempt?.sessionId && !model?.session) {
    const result = task.results.find((entry) => entry.resultId === task.currentResultId)
    return {
      ...activity,
      phase: result ? 'ended' : 'unknown',
      terminalStatus: result?.terminalStatus ?? null,
      freshness: 'unavailable',
      detail: 'The worker session is unavailable.',
    }
  }
  if (task.stopRequestedAt !== null && (live || model?.activeTurnId))
    return { ...activity, phase: 'stopping' }
  if (task.stopRequestedAt !== null && !model?.queuedMessages.length) {
    const turn = model?.lastTurn?.turnId !== attempt?.baselineTurnId ? model?.lastTurn : null
    return {
      ...activity,
      phase: 'ended',
      terminalStatus: turn
        ? turn.stopReason === 'error'
          ? 'failed'
          : turn.stopReason
        : 'interrupted',
    }
  }
  if (attempt?.submission === 'uncertain' || (model?.activeTurnId && !live))
    return {
      ...activity,
      phase: 'unknown',
      waitReason: 'disconnected',
      freshness: 'unavailable',
      detail: 'The previous process outcome is uncertain.',
    }
  if (attempt?.submission === 'cancelled')
    return { ...activity, phase: 'ended', terminalStatus: 'interrupted' }
  if (attempt?.submission === 'pending' && !ready)
    return {
      ...activity,
      phase: 'waiting',
      waitReason: 'dependencies',
      detail: `Waiting for ${task.assignment?.dependsOn
        .map((id) => {
          const dependency = family.find((entry) => entry.taskId === id)
          return dependency?.title ?? id
        })
        .join(', ')}: integrate current code results or accept report-only results.`,
    }
  const decision = requests.find((request) => request.kind === 'approval') ?? requests[0]
  if (decision)
    return {
      ...activity,
      phase: 'waiting',
      waitReason: decision.owner === 'lead' ? 'lead_decision' : 'human_decision',
      decisionOwner: decision.owner,
    }
  if (model?.activeTurnId)
    return {
      ...activity,
      phase: model.streamingMessageId ? 'working' : 'starting',
      detail:
        [
          ...(model.messages.find((message) => message.id === model.streamingMessageId)?.parts ??
            []),
        ]
          .reverse()
          .find((part) => part.type === 'tool-call')?.name ?? null,
    }
  if (child?.workState === 'waiting_for_children')
    return { ...activity, phase: 'waiting', waitReason: 'children' }
  if (model?.queuedMessages.length || attempt?.submission === 'pending')
    return {
      ...activity,
      phase: 'queued',
      waitReason: 'capacity',
      detail: 'Waiting for a delegation slot.',
    }
  if (model?.lastTurn)
    return {
      ...activity,
      phase: 'ended',
      terminalStatus: model.lastTurn.stopReason === 'error' ? 'failed' : model.lastTurn.stopReason,
    }
  return { ...activity, waitReason: 'capacity', detail: 'No turn has been submitted.' }
}

export function childRequests(
  child: ChildTask,
  model: SessionReadModel,
  capabilities: { approval: boolean; question: boolean },
): OrchestrationRequest[] {
  const asked = model.messages.find(
    (message) => message.role === 'user' && message.turnId === model.activeTurnId,
  )
  const leadOwns =
    asked?.origin?.kind === 'session' && asked.origin.sessionId === child.parentSessionId
  const unavailableReason =
    'The live provider callback is unavailable. Start a new attempt to recover.'
  return [
    ...model.pendingApprovals.map((request): OrchestrationRequest => ({
      requestId: request.approvalId,
      childSessionId: child.sessionId,
      title: child.title,
      turnId: model.activeTurnId,
      kind: 'approval',
      owner: 'human',
      prompt: request.summaryJson,
      toolName: request.toolName,
      summaryJson: request.summaryJson,
      choicesJson: null,
      options: request.options,
      actionable: capabilities.approval && model.activeTurnId !== null,
      unavailableReason:
        capabilities.approval && model.activeTurnId !== null ? null : unavailableReason,
    })),
    ...model.pendingInputs.map((request): OrchestrationRequest => ({
      requestId: request.inputId,
      childSessionId: child.sessionId,
      title: child.title,
      turnId: model.activeTurnId,
      kind: 'question',
      owner: leadOwns ? 'lead' : 'human',
      prompt: request.prompt,
      toolName: null,
      summaryJson: null,
      choicesJson: request.choicesJson,
      options: [],
      actionable: capabilities.question && model.activeTurnId !== null,
      unavailableReason:
        capabilities.question && model.activeTurnId !== null ? null : unavailableReason,
    })),
  ]
}
