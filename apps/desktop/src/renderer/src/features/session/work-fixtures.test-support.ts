import type {
  OrchestrationTask,
  OrchestrationView,
  ResultPackage,
} from '@ari/contracts/orchestration'

export const SNAPSHOT = 'a'.repeat(40)
export function workResult(overrides: Partial<ResultPackage> = {}): ResultPackage {
  return {
    resultId: 'result-1',
    taskId: 'task-1',
    attemptId: 'attempt-1',
    version: 1,
    turnId: 'turn-1',
    createdAt: 100,
    summary: 'Search API implemented.',
    files: ['src/search.ts'],
    snapshotCommit: SNAPSHOT,
    workerReportedChecks: [],
    verifiedChecks: [],
    unresolvedIssues: [],
    nextAction: null,
    terminalStatus: 'completed',
    reviewState: 'available',
    reviewHistory: [],
    ...overrides,
  }
}
export function workTask(overrides: Partial<OrchestrationTask> = {}): OrchestrationTask {
  return {
    taskId: 'task-1',
    title: 'Search API',
    assignment: {
      goal: 'Implement search',
      role: 'implementation',
      ownedPaths: ['src/search.ts'],
      acceptanceCriteria: ['Empty queries return no results'],
      dependsOn: [],
    },
    driverKind: 'codex',
    modelId: null,
    effort: null,
    workspaceMode: 'isolated',
    attempts: [
      {
        attemptId: 'attempt-1',
        sessionId: 'worker-1',
        createdAt: 10,
        contextId: null,
        consumedContextAt: null,
        submission: 'submitted',
        baselineTurnId: null,
      },
    ],
    currentAttemptId: 'attempt-1',
    currentResultId: null,
    results: [],
    stopRequestedAt: null,
    child: null,
    requests: [],
    currentActivity: {
      phase: 'working',
      waitReason: null,
      decisionOwner: null,
      terminalStatus: null,
      detail: null,
      observedAt: 100,
      freshness: 'live',
    },
    capabilities: {
      inspect: true,
      message: true,
      stop: true,
      steer: false,
      answer: true,
      nativeFork: false,
      respondAfterReconnect: false,
      unavailableReason: null,
    },
    ...overrides,
  }
}
export function workView(tasks: OrchestrationTask[] = [workTask()]): OrchestrationView {
  return {
    sessionId: 'lead',
    revision: 1,
    observedAt: 100,
    tasks,
    budgets: {
      scope: 'tree',
      inputTokens: null,
      outputTokens: null,
      costUsd: null,
      maxTokens: null,
      maxCostUsd: null,
    },
    operations: [],
  }
}
