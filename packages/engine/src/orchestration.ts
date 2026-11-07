import { createHash } from 'node:crypto'
import { ControlFailure } from '@ari/contracts/agent-control'
import {
  orchestrationParams,
  type ContextPackage,
  type OperationReceipt,
  type OrchestrationDiff,
  type OrchestrationMethod,
  type OrchestrationParams,
  type OrchestrationResults,
  type OrchestrationChangedFrame,
  type OrchestrationTaskRecord,
  type OrchestrationTask,
  type ResultPackage,
  type TaskAttempt,
} from '@ari/contracts/orchestration'
import type { Session } from '@ari/contracts/session'
import type { ControlHost } from './agent-control'
import { descendantIds, type AgentControlService } from './agent-control'
import { finalAssistantText } from './delegation-state'
import {
  assertTaskDag,
  childRequests,
  dependenciesAccepted,
  orchestrationActivity,
} from './orchestration-state'

export interface OrchestrationHost {
  control: AgentControlService
  host: ControlHost
  liveCapabilities(sessionId: string): { approval: boolean; question: boolean; steer: boolean }
  readFile(
    session: Session,
    path: string,
    maxChars: number,
  ): Promise<{ content: string; truncated: boolean }>
  freezeBase?(session: Session, key: string): Promise<string>
  verifySnapshot?(
    session: Session,
    snapshotCommit: string,
  ): Promise<ResultPackage['verifiedChecks'][number]>
}

const stableId = (prefix: string, value: string) =>
  `${prefix}_${createHash('sha256').update(value).digest('hex').slice(0, 32)}`
const currentAttempt = (task: OrchestrationTaskRecord) =>
  task.attempts.find((attempt) => attempt.attemptId === task.currentAttemptId)!

/** Small app-owned task layer above existing scoped sessions and durable journals. */
export class OrchestrationService {
  readonly #queues = new Map<string, Promise<unknown>>()
  readonly #activeOperations = new Set<string>()
  constructor(readonly options: OrchestrationHost) {}

  /** One coalesced journal observer; no polling or broad per-event scans. */
  subscribeChanged(listener: (frame: OrchestrationChangedFrame) => void, delayMs = 75): () => void {
    const changed = new Set<string>()
    let timer: ReturnType<typeof setTimeout> | null = null
    let closed = false
    const flush = async () => {
      timer = null
      const ids = [...changed]
      changed.clear()
      const families = new Map<string, Set<string>>()
      for (const changedId of ids) {
        let session = (await this.options.host.store.load(changedId)).session
        const projectId = session?.projectId
        const seen = new Set<string>()
        while (session && !seen.has(session.id) && session.projectId === projectId) {
          seen.add(session.id)
          const members = families.get(session.id) ?? new Set<string>()
          members.add(changedId)
          families.set(session.id, members)
          session = session.parentSessionId
            ? (await this.options.host.store.load(session.parentSessionId)).session
            : null
        }
      }
      if (closed) return
      for (const [sessionId, members] of families)
        listener({ sessionId, changedSessionIds: [...members], at: Date.now() })
    }
    const unsubscribe = this.options.host.store.subscribe((event) => {
      if (closed) return
      changed.add(event.sessionId)
      if (timer === null)
        timer = setTimeout(() => {
          void flush().catch(() => undefined)
        }, delayMs)
    })
    return () => {
      closed = true
      unsubscribe()
      if (timer !== null) clearTimeout(timer)
      changed.clear()
    }
  }

  async #scope(callerId: string, targetId: string, reportParent = false): Promise<Session> {
    const caller = (await this.options.host.store.load(callerId)).session
    const resolvedId =
      targetId === 'self'
        ? callerId
        : targetId === 'parent' && reportParent
          ? caller?.parentSessionId
          : targetId
    const target = resolvedId ? (await this.options.host.store.load(resolvedId)).session : null
    if (!caller || !target) throw new ControlFailure('session_not_found', 'Session not found.')
    const ids = descendantIds(await this.options.host.store.listSessions(), callerId)
    if (
      target.projectId !== caller.projectId ||
      (target.id !== callerId &&
        !ids.includes(target.id) &&
        !(reportParent && caller.parentSessionId === target.id))
    )
      throw new ControlFailure('scope_denied', 'Target is outside this session subtree.')
    return target
  }

  async #serial<T>(id: string, run: () => Promise<T>): Promise<T> {
    const next = (this.#queues.get(id) ?? Promise.resolve()).catch(() => undefined).then(run)
    this.#queues.set(id, next)
    try {
      return await next
    } finally {
      if (this.#queues.get(id) === next) this.#queues.delete(id)
    }
  }

  async invoke<M extends OrchestrationMethod>(
    callerId: string,
    method: M,
    raw: unknown,
    human = false,
    signal?: AbortSignal,
  ): Promise<OrchestrationResults[M]> {
    const parsed = orchestrationParams[method].safeParse(raw)
    if (!parsed.success)
      throw new ControlFailure('invalid_request', 'Invalid orchestration parameters.')
    const parent = await this.#scope(
      callerId,
      parsed.data.sessionId,
      method === 'orchestration.result',
    )
    return this.#serial(parent.id, async () => {
      await this.#refresh(parent)
      const run = () => this.#run(parent, method, parsed.data, callerId, human, signal)
      return (
        'idempotencyKey' in parsed.data && typeof parsed.data.idempotencyKey === 'string'
          ? await this.#operation(
              parent.id,
              `${method}:${parsed.data.idempotencyKey}`,
              method,
              parsed.data,
              run,
            )
          : await run()
      ) as OrchestrationResults[M]
    })
  }

  async #operation<T>(
    parentId: string,
    key: string,
    method: string,
    params: unknown,
    run: () => Promise<T>,
  ): Promise<T> {
    const operationId = stableId('op', key)
    const fingerprint = JSON.stringify(params)
    const previous = (await this.options.host.store.load(parentId)).orchestration?.operations[
      operationId
    ]
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        throw new ControlFailure(
          'invalid_request',
          'Idempotency key already used with different parameters.',
        )
      if (previous.status === 'completed') {
        const result = previous.result as
          { operationFailure?: { code: string; message: string } } | undefined
        if (result?.operationFailure)
          throw new ControlFailure(result.operationFailure.code, result.operationFailure.message)
        return previous.result as T
      }
      throw new ControlFailure(
        'uncertain_outcome',
        previous.detail ??
          'The process ended during this operation. Inspect the task before an explicit recovery attempt.',
        { operationId },
      )
    }
    const receipt: OperationReceipt = {
      operationId,
      method,
      fingerprint,
      status: 'started',
      startedAt: Date.now(),
      completedAt: null,
      detail: null,
    }
    await this.options.host.record(parentId, {
      type: 'orchestration.operation.updated',
      operation: receipt,
    })
    this.#activeOperations.add(operationId)
    try {
      const result = await run()
      await this.options.host.record(parentId, {
        type: 'orchestration.operation.updated',
        operation: { ...receipt, status: 'completed', completedAt: Date.now(), result },
      })
      return result
    } catch (error) {
      const known =
        error instanceof ControlFailure &&
        error.code !== 'internal_error' &&
        error.code !== 'uncertain_outcome'
      await this.options.host.record(parentId, {
        type: 'orchestration.operation.updated',
        operation: {
          ...receipt,
          status: known ? 'completed' : 'uncertain',
          completedAt: known ? Date.now() : null,
          result: known
            ? { operationFailure: { code: error.code, message: error.message } }
            : undefined,
          detail: known
            ? error.message
            : 'The effect may have completed before its receipt was persisted. Inspect state before recovering.',
        },
      })
      throw error
    } finally {
      this.#activeOperations.delete(operationId)
    }
  }

  async #tasks(parentId: string) {
    return Object.values((await this.options.host.store.load(parentId)).orchestration?.tasks ?? {})
  }
  async #save(parentId: string, task: OrchestrationTaskRecord) {
    await this.options.host.record(parentId, { type: 'orchestration.task.updated', task })
    return task
  }
  async #task(parentId: string, taskId: string) {
    const task = (await this.options.host.store.load(parentId)).orchestration?.tasks[taskId]
    if (!task) throw new ControlFailure('task_not_found', 'Task not found in this family.')
    return task
  }
  async #call(
    parent: Session,
    method: Parameters<AgentControlService['invoke']>[1],
    params: unknown,
    signal?: AbortSignal,
  ) {
    const result = await this.options.control.invoke(parent.id, method, params, signal)
    if (!result.ok)
      throw new ControlFailure(result.error.code, result.error.message, result.error.details)
    return result.result
  }

  async #refresh(parent: Session): Promise<void> {
    const model = await this.options.host.store.load(parent.id)
    for (const operation of Object.values(model.orchestration?.operations ?? {})) {
      if (
        (operation.method.startsWith('orchestration.') || operation.method === 'task.submit') &&
        operation.status === 'started' &&
        !this.#activeOperations.has(operation.operationId)
      )
        await this.options.host.record(parent.id, {
          type: 'orchestration.operation.updated',
          operation: {
            ...operation,
            status: 'uncertain',
            detail:
              'Runtime disconnected during this operation; its effect is not safe to repeat automatically.',
          },
        })
    }
    const children = await this.options.control.tasks(parent.id)
    const tasks = await this.#tasks(parent.id)
    for (const child of children) {
      if (
        tasks.some((task) => task.attempts.some((attempt) => attempt.sessionId === child.sessionId))
      )
        continue
      const session = (await this.options.host.store.load(child.sessionId)).session!
      const attemptId = stableId('attempt', child.sessionId)
      const task: OrchestrationTaskRecord = {
        taskId: child.sessionId,
        title: child.title,
        assignment: null,
        driverKind: session.driverKind,
        modelId: session.modelId,
        effort: session.effort ?? null,
        workspaceMode: child.workspaceKind === 'managed-worktree' ? 'isolated' : 'shared',
        attempts: [
          {
            attemptId,
            sessionId: child.sessionId,
            createdAt: session.createdAt,
            contextId: null,
            consumedContextAt: null,
            submission: 'submitted',
            baselineTurnId: null,
          },
        ],
        currentAttemptId: attemptId,
        results: [],
        currentResultId: null,
        stopRequestedAt: null,
      }
      await this.#save(parent.id, task)
      tasks.push(task)
    }
    for (let task of tasks) {
      const attempt = currentAttempt(task)
      const integrated = task.results.filter(
        (result) =>
          result.reviewState !== 'integrated' &&
          result.snapshotCommit &&
          model.childEvents?.some(
            (event) =>
              event.type === 'child.session.integrated' &&
              event.childSessionId ===
                task.attempts.find((entry) => entry.attemptId === result.attemptId)?.sessionId &&
              event.snapshotCommit === result.snapshotCommit &&
              ['integrated', 'already_integrated'].includes(event.result),
          ),
      )
      if (integrated.length) {
        task = {
          ...task,
          results: task.results.map((result) =>
            integrated.includes(result)
              ? {
                  ...result,
                  reviewState: 'integrated',
                  reviewHistory: [
                    ...result.reviewHistory,
                    { at: Date.now(), state: 'integrated', feedback: null },
                  ],
                }
              : result,
          ),
        }
        await this.#save(parent.id, task)
      }
      if (attempt.submission === 'pending') {
        const submit = (await this.options.host.store.load(parent.id)).orchestration?.operations[
          stableId('op', `submit:${attempt.attemptId}`)
        ]
        if (submit?.status === 'uncertain') {
          task = {
            ...task,
            attempts: task.attempts.map((entry) =>
              entry.attemptId === attempt.attemptId ? { ...entry, submission: 'uncertain' } : entry,
            ),
          }
          await this.#save(parent.id, task)
        }
      }
      if (!attempt.sessionId) continue
      const state = await this.options.host.store.load(attempt.sessionId)
      if (!state.session) continue
      const currentResult = task.results.find((entry) => entry.resultId === task.currentResultId)
      if (
        currentResult &&
        (state.queuedMessages.length ||
          (state.activeTurnId && state.activeTurnId !== currentResult.turnId))
      ) {
        task = { ...task, currentResultId: null }
        await this.#save(parent.id, task)
      }
      if (
        !state.lastTurn ||
        state.lastTurn.turnId === attempt.baselineTurnId ||
        state.activeTurnId ||
        this.options.host.isRunning?.(attempt.sessionId)
      )
        continue
      if (task.results.some((result) => result.turnId === state.lastTurn?.turnId)) continue
      const report = finalAssistantText(state, state.lastTurn.turnId, 16_000)
      let diff: OrchestrationDiff | null = null
      let snapshotError: string | null = null
      if (state.session.workspace?.kind === 'managed-worktree') {
        try {
          diff = (await this.options.host.diff(state.session, false)) as OrchestrationDiff
        } catch {
          snapshotError =
            'Worker snapshot is unavailable. Restore its workspace or retry in a new session.'
        }
      }
      const resultId = stableId('result', `${task.taskId}:${state.lastTurn.turnId}`)
      const result: ResultPackage = {
        resultId,
        taskId: task.taskId,
        attemptId: attempt.attemptId,
        version: task.results.length + 1,
        turnId: state.lastTurn.turnId,
        createdAt: state.lastTurn.settledAt,
        summary: report.text,
        files: diff?.files.map((file) => file.path) ?? [],
        snapshotCommit: diff?.files.length ? diff.currentSnapshotCommit : null,
        ...(snapshotError ? { snapshotUnavailable: true } : {}),
        workerReportedChecks: [],
        verifiedChecks: [],
        unresolvedIssues: [state.lastTurn.errorMessage, snapshotError].filter(
          (entry): entry is string => Boolean(entry),
        ),
        nextAction: 'Review this result against its acceptance criteria.',
        terminalStatus:
          state.lastTurn.stopReason === 'error' ? 'failed' : state.lastTurn.stopReason,
        reviewState: 'available',
        reviewHistory: [{ at: Date.now(), state: 'available', feedback: null }],
      }
      // Worker metadata may arrive during the turn. Carry claims onto the final snapshot.
      const reported = task.results.find(
        (entry) => entry.attemptId === attempt.attemptId && entry.turnId === null,
      )
      if (reported) {
        if (!diff) result.files = reported.files
        result.workerReportedChecks = reported.workerReportedChecks
        result.unresolvedIssues.push(...reported.unresolvedIssues)
        result.nextAction = reported.nextAction
      }
      await this.#save(parent.id, {
        ...task,
        results: [...task.results, result],
        currentResultId: resultId,
      })
    }
  }

  async #submit(parent: Session, task: OrchestrationTaskRecord): Promise<OrchestrationTaskRecord> {
    const attempt = currentAttempt(task)
    if (
      attempt.submission !== 'pending' ||
      task.stopRequestedAt !== null ||
      !dependenciesAccepted(task, await this.#tasks(parent.id))
    )
      return task
    return this.#operation(
      parent.id,
      `submit:${attempt.attemptId}`,
      'task.submit',
      { taskId: task.taskId, attemptId: attempt.attemptId },
      async () => {
        // Validate the complete bounded brief before any workspace, session or provider effects.
        const family = await this.#tasks(parent.id)
        const prerequisites = (task.assignment?.dependsOn ?? []).map((id) => {
          const dependency = family.find((entry) => entry.taskId === id)!
          const result = dependency.results.find(
            (entry) => entry.resultId === dependency.currentResultId,
          )!
          return { dependency, result }
        })
        const context = attempt.contextId
          ? (await this.options.host.store.load(parent.id)).orchestration?.contexts[
              attempt.contextId
            ]
          : null
        if (attempt.contextId && !context)
          throw new ControlFailure('context_not_found', 'Context package not found.')
        const summaryChars = Math.min(2000, Math.floor(16000 / Math.max(1, prerequisites.length)))
        const dependencyBrief = prerequisites
          .map(
            ({ dependency, result }) =>
              `Prerequisite ${dependency.title.slice(0, 120)} (${dependency.taskId}): result ${result.resultId}, version ${result.version}, attempt ${result.attemptId}, snapshot ${result.snapshotCommit ?? 'report-only'}\n${result.summary.slice(0, summaryChars)}`,
          )
          .join('\n\n')
        const brief = [
          task.assignment?.goal ?? task.title,
          `Task: ${task.taskId}\nAttempt: ${attempt.attemptId}\nRole: ${task.assignment?.role ?? 'general'}`,
          `Owned paths: ${task.assignment?.ownedPaths.join(', ') || 'not specified'}`,
          `Acceptance criteria:\n${task.assignment?.acceptanceCriteria.join('\n') || 'Follow the assignment.'}`,
          ...(dependencyBrief ? [dependencyBrief] : []),
          ...(context
            ? [
                `Context package ${context.contextId}:\n${context.items.map((item) => `[${item.kind}: ${item.sourceId}]\n${item.content}`).join('\n\n')}`,
              ]
            : []),
        ].join('\n\n')
        if (brief.length > 64_000)
          throw new ControlFailure(
            'context_too_large',
            'Assignment, selected context and prerequisite summaries exceed the 64,000 character submission limit. Retry with a smaller package.',
          )
        let childId = attempt.sessionId
        if (!childId) {
          const spawned = (await this.#call(parent, 'session.spawn', {
            title: task.title,
            role: task.assignment?.role,
            driverKind: task.driverKind,
            modelId: task.modelId,
            effort: task.effort,
            workspaceMode: task.workspaceMode,
            permissionMode: task.permissionMode,
            idempotencyKey: attempt.attemptId,
            baseSnapshotCommit: task.baseSnapshotCommit,
          })) as { child: Session }
          childId = spawned.child.id
          task = {
            ...task,
            attempts: task.attempts.map((entry) =>
              entry.attemptId === attempt.attemptId ? { ...entry, sessionId: childId } : entry,
            ),
          }
          await this.#save(parent.id, task)
        }
        // Record consumption before the process-bound submission, so replay can inspect exactly what was sent.
        task = {
          ...task,
          attempts: task.attempts.map((entry) =>
            entry.attemptId === attempt.attemptId
              ? {
                  ...entry,
                  consumedContextAt: context ? Date.now() : null,
                  prerequisites: prerequisites.map(({ dependency, result }) => ({
                    taskId: dependency.taskId,
                    attemptId: result.attemptId,
                    resultId: result.resultId,
                    version: result.version,
                    snapshotCommit: result.snapshotCommit,
                  })),
                }
              : entry,
          ),
        }
        await this.#save(parent.id, task)
        await this.#call(parent, 'session.prompt', {
          targetSessionId: childId,
          text: brief,
          idempotencyKey: `prompt-${attempt.attemptId}`,
        })
        return this.#save(parent.id, {
          ...task,
          attempts: task.attempts.map((entry) =>
            entry.attemptId === attempt.attemptId ? { ...entry, submission: 'submitted' } : entry,
          ),
        })
      },
    )
  }

  async schedule(parentId: string): Promise<void> {
    const parent = (await this.options.host.store.load(parentId)).session
    if (!parent) return
    await this.#serial(parentId, async () => {
      await this.#refresh(parent)
      for (const task of await this.#tasks(parentId))
        await this.#submit(parent, task).catch(() => undefined)
    })
  }

  async #view(parent: Session): Promise<OrchestrationResults['orchestration.view']> {
    const records = await this.#tasks(parent.id)
    const children = await this.options.control.tasks(parent.id)
    const tasks: OrchestrationTask[] = []
    for (const task of records) {
      const id = currentAttempt(task).sessionId
      const child = children.find((entry) => entry.sessionId === id) ?? null
      const model = id ? await this.options.host.store.load(id) : null
      const live = id ? (this.options.host.isRunning?.(id) ?? false) : false
      const caps = id
        ? this.options.liveCapabilities(id)
        : { approval: false, question: false, steer: false }
      const requests = child && model ? childRequests(child, model, caps) : []
      const submitReceipt = (await this.options.host.store.load(parent.id)).orchestration
        ?.operations[stableId('op', `submit:${task.currentAttemptId}`)]
      const refused =
        submitReceipt?.status === 'completed'
          ? (submitReceipt.result as { operationFailure?: { message: string } })?.operationFailure
          : null
      const activity = orchestrationActivity(
        task,
        child,
        model,
        live,
        dependenciesAccepted(task, records),
        requests,
        records,
      )
      tasks.push({
        ...task,
        child,
        requests,
        currentActivity:
          refused && currentAttempt(task).submission === 'pending'
            ? {
                ...activity,
                phase: 'waiting',
                waitReason: 'lead_decision',
                decisionOwner: 'lead',
                detail: refused.message,
              }
            : activity,
        capabilities: {
          inspect: child !== null,
          message: child !== null && model?.session?.archived !== true,
          stop:
            live ||
            currentAttempt(task).submission === 'pending' ||
            Boolean(model?.queuedMessages.length),
          steer: caps.steer,
          answer: requests.some((request) => request.actionable),
          nativeFork: false,
          respondAfterReconnect: false,
          unavailableReason: child
            ? null
            : id
              ? 'The worker session is unavailable.'
              : 'Task has not been dispatched.',
        },
      })
    }
    // Provider-owned background work is observable, not an app-created session.
    for (const ownerId of [parent.id, ...children.map((child) => child.sessionId)]) {
      const owner = await this.options.host.store.load(ownerId)
      if (!owner.session) continue
      for (const background of owner.backgroundTasks ?? []) {
        const taskId = stableId('native', `${ownerId}:${background.id}`)
        const ended = background.status !== 'running'
        tasks.push({
          taskId,
          title: background.label,
          assignment: null,
          child: null,
          native: { taskId: background.id, sessionId: ownerId, kind: background.kind },
          driverKind: owner.session.driverKind,
          modelId: owner.session.modelId,
          effort: null,
          workspaceMode: 'shared',
          attempts: [],
          currentAttemptId: taskId,
          results: [],
          currentResultId: null,
          stopRequestedAt: null,
          requests: [],
          currentActivity: {
            phase: ended ? 'ended' : 'working',
            waitReason: null,
            decisionOwner: null,
            terminalStatus: ended
              ? background.status === 'failed'
                ? 'failed'
                : background.status === 'stopped'
                  ? 'interrupted'
                  : 'completed'
              : null,
            detail: background.detail,
            observedAt: background.updatedAt,
            freshness: 'journal',
          },
          capabilities: {
            inspect: true,
            message: false,
            stop: false,
            steer: false,
            answer: false,
            nativeFork: false,
            respondAfterReconnect: false,
            unavailableReason: 'Provider-owned background work is read only.',
          },
        })
      }
    }
    const model = await this.options.host.store.load(parent.id)
    const rows = await this.options.host.store.listSessions()
    const rootId = parent.rootSessionId ?? parent.id
    const members = rows.filter((row) => row.id === rootId || row.rootSessionId === rootId)
    const usage = await Promise.all(members.map((row) => this.options.host.store.load(row.id)))
    const policy = this.options.host.policy()
    return {
      sessionId: parent.id,
      revision: model.lastSeq,
      observedAt: Date.now(),
      tasks,
      budgets: {
        scope: 'tree',
        inputTokens: usage.some((entry) => entry.usageObserved)
          ? usage.reduce((sum, entry) => sum + entry.usage.inputTokens, 0)
          : null,
        outputTokens: usage.some((entry) => entry.usageObserved)
          ? usage.reduce((sum, entry) => sum + entry.usage.outputTokens, 0)
          : null,
        costUsd: usage.some((entry) => entry.usage.costUsd === null)
          ? null
          : usage.reduce((sum, entry) => sum + (entry.usage.costUsd ?? 0), 0),
        maxTokens: policy.maxTreeTokens,
        maxCostUsd: policy.maxTreeCostUsd,
      },
      operations: Object.values(model.orchestration?.operations ?? {}),
    }
  }

  async #launch(
    parent: Session,
    p: OrchestrationParams<'orchestration.launch'>,
    baseSnapshotCommit?: string,
  ): Promise<OrchestrationTaskRecord> {
    const taskId = stableId('task', `${parent.id}:${p.idempotencyKey}`)
    const attemptId = stableId('attempt', taskId)
    if (
      p.contextId &&
      !(await this.options.host.store.load(parent.id)).orchestration?.contexts[p.contextId]
    )
      throw new ControlFailure('context_not_found', 'Context package not found.')
    if (p.workspaceMode === 'shared') {
      const family = await this.#tasks(parent.id)
      const prerequisites = new Set<string>()
      const collect = (id: string): void => {
        if (prerequisites.has(id)) return
        prerequisites.add(id)
        for (const dependency of family.find((entry) => entry.taskId === id)?.assignment
          ?.dependsOn ?? [])
          collect(dependency)
      }
      for (const id of p.assignment.dependsOn) collect(id)
      const normalize = (value: string) =>
        value.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase()
      for (const existing of family) {
        if (
          existing.workspaceMode !== 'shared' ||
          existing.currentResultId ||
          existing.stopRequestedAt !== null
        )
          continue
        const overlaps = p.assignment.ownedPaths.some((path) =>
          existing.assignment?.ownedPaths.some((other) => {
            const a = normalize(path),
              b = normalize(other)
            return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)
          }),
        )
        if (overlaps && !prerequisites.has(existing.taskId))
          throw new ControlFailure(
            'owned_path_overlap',
            `Shared workspace owned paths overlap with ${existing.title}. Use isolation or sequence the writers.`,
          )
      }
    }
    const task: OrchestrationTaskRecord = {
      taskId,
      title: p.title,
      assignment: p.assignment,
      driverKind: p.driverKind,
      modelId: p.modelId,
      effort: p.effort,
      workspaceMode: p.workspaceMode,
      ...(p.permissionMode ? { permissionMode: p.permissionMode } : {}),
      attempts: [
        {
          attemptId,
          sessionId: null,
          createdAt: Date.now(),
          contextId: p.contextId ?? null,
          consumedContextAt: null,
          submission: 'pending',
          baselineTurnId: null,
        },
      ],
      currentAttemptId: attemptId,
      results: [],
      currentResultId: null,
      stopRequestedAt: null,
      ...(baseSnapshotCommit ? { baseSnapshotCommit } : {}),
    }
    assertTaskDag([...(await this.#tasks(parent.id)), task])
    await this.#save(parent.id, task)
    return this.#submit(parent, task)
  }

  async #result(
    parent: Session,
    task: OrchestrationTaskRecord,
    resultId: string,
    snapshot: string | null,
    checkCurrent = true,
  ): Promise<ResultPackage> {
    const result = task.results.find((entry) => entry.resultId === resultId)
    if (!result) throw new ControlFailure('result_not_found', 'Result not found.')
    if (result.snapshotUnavailable)
      throw new ControlFailure(
        'workspace_unavailable',
        'Restore the worker snapshot before review or retry in a new session.',
      )
    if (result.snapshotCommit !== snapshot)
      throw new ControlFailure('stale_snapshot', 'Review must name the exact result snapshot.')
    if (
      checkCurrent &&
      (result.resultId !== task.currentResultId || result.attemptId !== task.currentAttemptId)
    )
      throw new ControlFailure('stale_result', 'A newer attempt or result supersedes this result.')
    if (checkCurrent) {
      const child = (await this.options.host.store.load(currentAttempt(task).sessionId!)).session
      if (!child) throw new ControlFailure('session_not_found', 'Worker session is unavailable.')
      const state = await this.options.host.store.load(child.id)
      if (
        state.activeTurnId ||
        this.options.host.isRunning?.(child.id) ||
        state.queuedMessages.length
      )
        throw new ControlFailure('task_running', 'Wait for the worker before reviewing its result.')
      if (snapshot || child.workspace?.kind === 'managed-worktree') {
        const diff = (await this.options.host.diff(child, false)) as OrchestrationDiff
        if (snapshot ? diff.currentSnapshotCommit !== snapshot : diff.files.length > 0)
          throw new ControlFailure(
            'stale_snapshot',
            'Worker files changed after this result snapshot.',
          )
      }
    }
    return result
  }

  async #run(
    parent: Session,
    method: OrchestrationMethod,
    raw: unknown,
    callerId: string,
    human: boolean,
    signal?: AbortSignal,
  ): Promise<unknown> {
    switch (method) {
      case 'orchestration.inbox': {
        const p = raw as OrchestrationParams<'orchestration.inbox'>
        const records = await this.#tasks(parent.id)
        const task = p.taskId ? records.find((record) => record.taskId === p.taskId) : null
        if (p.taskId && !task)
          throw new ControlFailure('task_not_found', 'Task is outside this family.')
        const ids = task
          ? task.attempts
              .map((attempt) => attempt.sessionId)
              .filter((id): id is string => Boolean(id))
          : [parent.id, ...descendantIds(await this.options.host.store.listSessions(), parent.id)]
        const titles = new Map(
          (await this.options.host.store.listSessions()).map((session) => [
            session.id,
            session.title,
          ]),
        )
        const entries = (
          await Promise.all(
            [...new Set(ids)].map(async (id) => {
              const model = await this.options.host.store.load(id)
              if (model.session?.projectId !== parent.projectId) return []
              return Object.values(model.inbox ?? {})
            }),
          )
        )
          .flat()
          .filter((message) => p.includeConsumed || message.status !== 'consumed')
          .sort((a, b) => b.createdAt - a.createdAt || a.messageId.localeCompare(b.messageId))
        return {
          total: entries.length,
          messages: entries.slice(0, p.limit).map((message) => ({
            ...message,
            text: message.text.slice(0, 2000),
            textTruncated: message.text.length > 2000,
            senderTitle: titles.get(message.senderSessionId) ?? 'Unavailable conversation',
            recipientTitle: titles.get(message.recipientSessionId) ?? 'Unavailable conversation',
          })),
        }
      }
      case 'orchestration.routine.list': {
        const p = raw as OrchestrationParams<'orchestration.routine.list'>
        return this.#call(parent, 'routine.list', {
          targetSessionId: parent.id,
          recursive: p.recursive,
        })
      }
      case 'orchestration.routine.add': {
        const p = raw as OrchestrationParams<'orchestration.routine.add'>
        return this.#call(parent, 'routine.add', {
          targetSessionId: parent.id,
          prompt: p.prompt,
          at: p.at,
          everyMs: p.everyMs,
          idempotencyKey: p.idempotencyKey,
        })
      }
      case 'orchestration.routine.remove': {
        const p = raw as OrchestrationParams<'orchestration.routine.remove'>
        const outcome = (await this.#call(parent, 'routine.remove', {
          routineId: p.routineId,
          idempotencyKey: p.idempotencyKey,
        })) as { removed: boolean }
        return { removed: outcome.removed }
      }
      case 'orchestration.view':
        return this.#view(parent)
      case 'orchestration.launch':
        return this.#launch(parent, raw as OrchestrationParams<'orchestration.launch'>)
      case 'orchestration.compare': {
        const p = raw as OrchestrationParams<'orchestration.compare'>
        const tasks = []
        if (!this.options.freezeBase)
          throw new ControlFailure(
            'unsupported',
            'This runtime cannot freeze a comparison workspace.',
          )
        const base = await this.options.freezeBase(parent, stableId('compare', p.idempotencyKey))
        for (const [index, model] of p.models.entries())
          tasks.push(
            await this.#launch(
              parent,
              {
                ...p,
                ...model,
                title: `${p.title.slice(0, 70)} · ${(model.modelId ?? model.driverKind).slice(0, 45)}`,
                workspaceMode: 'isolated',
                idempotencyKey: stableId('compare', `${p.idempotencyKey}:${index}`),
              },
              base,
            ),
          )
        return tasks
      }
      case 'orchestration.context.get': {
        const p = raw as OrchestrationParams<'orchestration.context.get'>
        const context = (await this.options.host.store.load(parent.id)).orchestration?.contexts[
          p.contextId
        ]
        if (!context) throw new ControlFailure('context_not_found', 'Context package not found.')
        return context
      }
      case 'orchestration.context': {
        const p = raw as OrchestrationParams<'orchestration.context'>
        const model = await this.options.host.store.load(parent.id)
        const context: ContextPackage = {
          contextId: stableId('context', `${parent.id}:${p.idempotencyKey}`),
          sourceSessionId: parent.id,
          createdAt: Date.now(),
          purpose: p.purpose,
          items: [],
          maxChars: p.maxChars,
          chars: 0,
        }
        const add = (
          kind: 'message' | 'file' | 'result',
          sourceId: string,
          content: string,
          truncated = false,
        ) => {
          const remaining = p.maxChars - context.chars
          const selected = content.slice(0, remaining)
          context.items.push({
            kind,
            sourceId,
            content: selected,
            truncated: truncated || selected.length < content.length,
          })
          context.chars += selected.length
        }
        for (const id of p.messageIds) {
          const message = model.messages.find((entry) => entry.id === id)
          if (!message)
            throw new ControlFailure(
              'message_not_found',
              'Selected message not found in the source session.',
            )
          add(
            'message',
            id,
            message.parts
              .filter((part) => part.type === 'text')
              .map((part) => part.text)
              .join(''),
          )
        }
        for (const file of p.files) {
          const value = await this.options.readFile(
            parent,
            file,
            Math.max(0, p.maxChars - context.chars),
          )
          add('file', file, value.content, value.truncated)
        }
        const results = (await this.#tasks(parent.id)).flatMap((task) => task.results)
        for (const id of p.resultIds) {
          const result = results.find((entry) => entry.resultId === id)
          if (!result || !['accepted', 'integrated'].includes(result.reviewState))
            throw new ControlFailure(
              'result_not_accepted',
              'Context can include only accepted outputs.',
            )
          add(
            'result',
            id,
            JSON.stringify({
              summary: result.summary,
              files: result.files,
              snapshotCommit: result.snapshotCommit,
              verifiedChecks: result.verifiedChecks,
              unresolvedIssues: result.unresolvedIssues,
            }),
          )
        }
        await this.options.host.record(parent.id, {
          type: 'orchestration.context.created',
          context,
        })
        return context
      }
      case 'orchestration.answer': {
        const p = raw as OrchestrationParams<'orchestration.answer'>
        const children = await this.options.control.tasks(parent.id, true)
        const child = children.find((entry) => entry.sessionId === p.childSessionId)
        if (!child)
          throw new ControlFailure('scope_denied', 'Request is outside this session subtree.')
        const model = await this.options.host.store.load(child.sessionId)
        const request = childRequests(
          child,
          model,
          this.options.liveCapabilities(child.sessionId),
        ).find((entry) => entry.requestId === p.requestId && entry.kind === p.kind)
        if (!request) throw new ControlFailure('request_stale', 'Request is no longer pending.')
        if (!request.actionable)
          throw new ControlFailure('request_unavailable', request.unavailableReason!)
        if (!human && (request.owner !== 'lead' || child.parentSessionId !== callerId))
          throw new ControlFailure(
            'scope_denied',
            'Only the human can answer approvals and human-owned questions; lead questions belong to the direct parent.',
          )
        if (p.kind === 'approval' && !request.options.some((option) => option.optionId === p.value))
          throw new ControlFailure('invalid_request', 'Choose an exact provider-offered option ID.')
        const outcome = await this.options.host.dispatch(
          p.kind === 'approval'
            ? {
                type: 'approval.respond',
                sessionId: child.sessionId,
                approvalId: p.requestId,
                optionId: p.value,
              }
            : {
                type: 'input.respond',
                sessionId: child.sessionId,
                inputId: p.requestId,
                value: p.value,
              },
          human ? undefined : { kind: 'session', sessionId: callerId },
        )
        if (!outcome.accepted)
          throw new ControlFailure(
            'request_unavailable',
            outcome.reason ?? 'The provider refused this response.',
          )
        return { answered: true, requestId: p.requestId }
      }
      case 'orchestration.stop': {
        const p = raw as OrchestrationParams<'orchestration.stop'>
        const tasks = p.taskId
          ? [await this.#task(parent.id, p.taskId)]
          : await this.#tasks(parent.id)
        const rows = await this.options.host.store.listSessions()
        const ids = new Set<string>()
        for (const task of tasks) {
          const attempt = currentAttempt(task)
          await this.#save(parent.id, {
            ...task,
            stopRequestedAt: Date.now(),
            attempts: task.attempts.map((entry) =>
              entry.attemptId === attempt.attemptId && entry.submission === 'pending'
                ? { ...entry, submission: 'cancelled' }
                : entry,
            ),
          })
          if (attempt.sessionId) {
            ids.add(attempt.sessionId)
            for (const id of descendantIds(rows, attempt.sessionId)) ids.add(id)
          }
        }
        if (p.tree) {
          for (const id of descendantIds(rows, parent.id)) ids.add(id)
          ids.add(parent.id)
        }
        for (const ownerId of ids) {
          if (ownerId === parent.id) continue
          for (const nested of await this.#tasks(ownerId))
            await this.#save(ownerId, {
              ...nested,
              stopRequestedAt: Date.now(),
              attempts: nested.attempts.map((entry) =>
                entry.attemptId === nested.currentAttemptId && entry.submission === 'pending'
                  ? { ...entry, submission: 'cancelled' }
                  : entry,
              ),
            })
        }
        for (const id of ids) {
          await this.#call(parent, 'session.stop', {
            targetSessionId: id,
            idempotencyKey: stableId('stop', `${p.idempotencyKey}:${id}`),
          })
          for (const queued of (await this.options.host.store.load(id)).queuedMessages)
            await this.options.host.dispatch({
              type: 'message.dequeue',
              sessionId: id,
              text: queued.text,
              attachments: queued.attachments,
            })
        }
        return { requested: true, sessionIds: [...ids] }
      }
      default:
        break
    }
    const p = raw as OrchestrationParams<'orchestration.retry'>
    let task = await this.#task(parent.id, p.taskId)
    if (method === 'orchestration.verify') {
      const params = raw as OrchestrationParams<'orchestration.verify'>
      const result = await this.#result(parent, task, params.resultId, params.snapshotCommit)
      if (!this.options.verifySnapshot)
        throw new ControlFailure(
          'unsupported',
          'This runtime cannot independently verify snapshots.',
        )
      const child = (await this.options.host.store.load(currentAttempt(task).sessionId!)).session!
      const check = await this.options.verifySnapshot(child, params.snapshotCommit)
      const updated = { ...result, verifiedChecks: [...result.verifiedChecks, check] }
      await this.#save(parent.id, {
        ...task,
        results: task.results.map((entry) =>
          entry.resultId === result.resultId ? updated : entry,
        ),
      })
      return updated
    }
    if (method === 'orchestration.diff') {
      const params = raw as OrchestrationParams<'orchestration.diff'>
      const result = params.resultId
        ? task.results.find((entry) => entry.resultId === params.resultId)
        : null
      if (params.resultId && !result)
        throw new ControlFailure('result_not_found', 'Result not found.')
      const attempt = result
        ? task.attempts.find((entry) => entry.attemptId === result.attemptId)!
        : currentAttempt(task)
      if (!attempt.sessionId)
        throw new ControlFailure('task_not_started', 'Task has no worker session yet.')
      const diff = (await this.#call(parent, 'session.diff', {
        targetSessionId: attempt.sessionId,
        patch: params.patch,
      })) as OrchestrationDiff
      if (result?.snapshotCommit && diff.currentSnapshotCommit !== result.snapshotCommit)
        throw new ControlFailure(
          'stale_snapshot',
          'The selected result no longer matches the worker files.',
        )
      return diff
    }
    if (method === 'orchestration.review' || method === 'orchestration.integrate') {
      const params = raw as OrchestrationParams<'orchestration.review'>
      const result = await this.#result(parent, task, params.resultId, params.snapshotCommit)
      if (method === 'orchestration.integrate') {
        if (!['accepted', 'integrated'].includes(result.reviewState))
          throw new ControlFailure(
            'result_not_accepted',
            'Accept this result before integrating it.',
          )
        const outcome = (await this.#call(
          parent,
          'session.integrate',
          {
            targetSessionId: currentAttempt(task).sessionId,
            snapshotCommit: params.snapshotCommit,
            idempotencyKey: params.idempotencyKey,
            allowStale: false,
          },
          signal,
        )) as OrchestrationResults['orchestration.integrate']
        if (outcome.status === 'integrated' || outcome.status === 'already_integrated') {
          const updated = {
            ...result,
            reviewState: 'integrated' as const,
            reviewHistory: [
              ...result.reviewHistory,
              { at: Date.now(), state: 'integrated' as const, feedback: null },
            ],
          }
          await this.#save(parent.id, {
            ...task,
            results: task.results.map((entry) =>
              entry.resultId === result.resultId ? updated : entry,
            ),
          })
        }
        if (outcome.status === 'integrated' || outcome.status === 'already_integrated')
          for (const pending of await this.#tasks(parent.id))
            await this.#submit(parent, pending).catch(() => undefined)
        return outcome
      }
      if (result.reviewState === 'integrated')
        throw new ControlFailure(
          'result_integrated',
          'Integrated results retain their review history; retry to propose changes.',
        )
      const updated = {
        ...result,
        reviewState: params.state,
        reviewHistory: [
          ...result.reviewHistory,
          { at: Date.now(), state: params.state, feedback: params.feedback ?? null },
        ],
      }
      await this.#save(parent.id, {
        ...task,
        results: task.results.map((entry) =>
          entry.resultId === result.resultId ? updated : entry,
        ),
      })
      // Acceptance is durable even when a prerequisite-dependent submission
      // is refused. That submission keeps its own inspectable receipt.
      for (const pending of await this.#tasks(parent.id))
        await this.#submit(parent, pending).catch(() => undefined)
      return updated
    }
    if (method === 'orchestration.result') {
      const params = raw as OrchestrationParams<'orchestration.result'>
      if (params.attemptId !== task.currentAttemptId)
        throw new ControlFailure('stale_attempt', 'Worker report belongs to an older attempt.')
      if (!human && callerId !== parent.id && currentAttempt(task).sessionId !== callerId)
        throw new ControlFailure(
          'scope_denied',
          'Workers may report only their own assigned attempt.',
        )
      const result: ResultPackage = {
        resultId: stableId('result', `${task.taskId}:${params.idempotencyKey}`),
        taskId: task.taskId,
        attemptId: params.attemptId,
        version: task.results.length + 1,
        turnId: null,
        createdAt: Date.now(),
        summary: params.summary,
        files: params.files,
        snapshotCommit: null,
        workerReportedChecks: params.workerReportedChecks,
        verifiedChecks: [],
        unresolvedIssues: params.unresolvedIssues,
        nextAction: params.nextAction ?? null,
        terminalStatus: 'completed',
        reviewState: 'available',
        reviewHistory: [{ at: Date.now(), state: 'available', feedback: null }],
      }
      const previous = task.results.find(
        (entry) => entry.resultId === task.currentResultId && entry.attemptId === params.attemptId,
      )
      if (previous) {
        result.turnId = previous.turnId
        result.files = previous.snapshotCommit ? previous.files : params.files
        result.snapshotCommit = previous.snapshotCommit
        result.terminalStatus = previous.terminalStatus
        result.verifiedChecks = previous.verifiedChecks
      }
      await this.#save(parent.id, {
        ...task,
        results: [...task.results, result],
        currentResultId: previous ? result.resultId : task.currentResultId,
      })
      return result
    }
    if (method === 'orchestration.update') {
      const params = raw as OrchestrationParams<'orchestration.update'>
      task = {
        ...task,
        assignment: params.assignment ?? task.assignment,
        title: params.title ?? task.title,
      }
      assertTaskDag(
        (await this.#tasks(parent.id)).map((entry) =>
          entry.taskId === task.taskId ? task : entry,
        ),
      )
      await this.#save(parent.id, task)
      if (params.title && currentAttempt(task).sessionId)
        await this.options.host.record(currentAttempt(task).sessionId!, {
          type: 'session.updated',
          title: params.title,
        })
      if (params.redirect) {
        const id = currentAttempt(task).sessionId
        if (!id)
          task = {
            ...task,
            assignment: {
              ...(task.assignment ?? {
                role: 'general',
                ownedPaths: [],
                acceptanceCriteria: [],
                dependsOn: [],
              }),
              goal: params.redirect,
            },
          }
        else
          await this.#call(parent, 'session.message', {
            targetSessionId: id,
            text: params.redirect,
            idempotencyKey: params.idempotencyKey,
          })
      }
      await this.#save(parent.id, task)
      return this.#submit(parent, task)
    }
    if (method === 'orchestration.retry') {
      // Optional optimistic guards run inside the serialized mutation, before
      // creating an attempt or causing any worker/workspace effects. Explicit
      // null pins report-only snapshots (or the absence of a current result).
      if (
        (p.expectedResultId !== undefined && p.expectedResultId !== task.currentResultId) ||
        (p.expectedAttemptId !== undefined && p.expectedAttemptId !== task.currentAttemptId)
      )
        throw new ControlFailure(
          'stale_result',
          'A newer attempt or result supersedes this result.',
        )
      if (
        p.expectedSnapshotCommit !== undefined &&
        p.expectedSnapshotCommit !==
          (task.results.find((entry) => entry.resultId === task.currentResultId)?.snapshotCommit ??
            null)
      )
        throw new ControlFailure('stale_snapshot', 'Retry must name the exact result snapshot.')
      const attempt = currentAttempt(task)
      const state = attempt.sessionId ? await this.options.host.store.load(attempt.sessionId) : null
      if (
        state?.activeTurnId ||
        (attempt.sessionId && this.options.host.isRunning?.(attempt.sessionId)) ||
        state?.queuedMessages.length
      )
        throw new ControlFailure(
          'task_running',
          'Stop or finish the current attempt before retrying.',
        )
      if ((p.driverKind || p.modelId !== undefined) && !p.newSession)
        throw new ControlFailure(
          'new_session_required',
          'Provider/model handoff requires an explicit new session.',
        )
      if (
        p.contextId &&
        !(await this.options.host.store.load(parent.id)).orchestration?.contexts[p.contextId]
      )
        throw new ControlFailure('context_not_found', 'Context package not found.')
      if (attempt.submission === 'uncertain' && !p.newSession)
        throw new ControlFailure(
          'new_session_required',
          'Recover an uncertain submission with an explicit new session.',
        )
      const next: TaskAttempt = {
        attemptId: stableId('attempt', `${task.taskId}:${p.idempotencyKey}`),
        sessionId: p.newSession ? null : attempt.sessionId,
        createdAt: Date.now(),
        contextId: p.contextId ?? null,
        consumedContextAt: null,
        submission: 'pending',
        baselineTurnId: p.newSession ? null : (state?.lastTurn?.turnId ?? null),
      }
      const feedback =
        p.feedback ??
        task.results
          .find((entry) => entry.resultId === task.currentResultId)
          ?.reviewHistory.filter((entry) => entry.state === 'changes_requested')
          .at(-1)?.feedback
      task = {
        ...task,
        driverKind: p.driverKind ?? task.driverKind,
        modelId: p.modelId === undefined ? task.modelId : p.modelId,
        attempts: [...task.attempts, next],
        currentAttemptId: next.attemptId,
        currentResultId: null,
        stopRequestedAt: null,
        assignment: feedback
          ? {
              ...(task.assignment ?? {
                role: 'general',
                ownedPaths: [],
                acceptanceCriteria: [],
                dependsOn: [],
              }),
              goal: `${task.assignment?.goal ?? task.title}\n\nFeedback:\n${feedback}`,
            }
          : task.assignment,
      }
      await this.#save(parent.id, task)
      return this.#submit(parent, task)
    }
    throw new ControlFailure('unsupported', 'Unsupported orchestration operation.')
  }
}
