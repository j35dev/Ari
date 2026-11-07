import type {
  OrchestrationTask,
  OrchestrationView,
  ResultPackage,
} from '@ari/contracts/orchestration'
import type { DelegatedChild } from './types'

export const SNAPSHOT = 'a'.repeat(40)
export const child: DelegatedChild = {
  sessionId: 'worker',
  title: 'Search API',
  role: 'implementation',
  driverKind: 'codex',
  modelId: null,
  state: 'done',
  startedAt: null,
  report: 'Implemented search.',
  anchor: { messageId: 'prompt', partIndex: 0 },
}
export function resultFixture(overrides: Partial<ResultPackage> = {}): ResultPackage {
  return {
    resultId: 'result-1',
    taskId: 'task',
    attemptId: 'attempt',
    version: 1,
    turnId: 'turn',
    createdAt: 100,
    summary: 'Search implemented.',
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
export function taskFixture(overrides: Partial<OrchestrationTask> = {}): OrchestrationTask {
  return {
    taskId: 'task',
    title: 'Search API',
    assignment: null,
    driverKind: 'codex',
    modelId: null,
    effort: null,
    workspaceMode: 'isolated',
    attempts: [
      {
        attemptId: 'attempt',
        sessionId: 'worker',
        createdAt: 1,
        contextId: null,
        consumedContextAt: null,
        submission: 'submitted',
        baselineTurnId: null,
      },
    ],
    currentAttemptId: 'attempt',
    currentResultId: 'result-1',
    results: [resultFixture()],
    stopRequestedAt: null,
    child: null,
    requests: [],
    currentActivity: {
      phase: 'ended',
      terminalStatus: 'completed',
      waitReason: null,
      decisionOwner: null,
      detail: null,
      observedAt: 100,
      freshness: 'live',
    },
    capabilities: {
      inspect: true,
      message: true,
      stop: false,
      steer: false,
      answer: false,
      nativeFork: false,
      respondAfterReconnect: false,
      unavailableReason: null,
    },
    ...overrides,
  }
}
export function viewFixture(task: OrchestrationTask | null): OrchestrationView {
  return {
    sessionId: 'parent',
    revision: 1,
    observedAt: 100,
    tasks: task ? [task] : [],
    operations: [],
    budgets: {
      scope: 'tree',
      inputTokens: null,
      outputTokens: null,
      costUsd: null,
      maxTokens: null,
      maxCostUsd: null,
    },
  }
}
export const diffFixture = {
  sessionId: 'worker',
  baseCommit: 'b'.repeat(40),
  currentSnapshotCommit: SNAPSHOT,
  files: [{ path: 'src/search.ts', status: 'modified', additions: 1, deletions: 1, binary: false }],
  totals: { files: 1, additions: 1, deletions: 1 },
  patch:
    'diff --git a/src/search.ts b/src/search.ts\n--- a/src/search.ts\n+++ b/src/search.ts\n@@ -1 +1 @@\n-old\n+new\n',
}
