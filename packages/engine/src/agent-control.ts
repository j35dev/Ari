import type { CoordinationMessage } from '@ari/contracts/coordination'
import { newTypedId } from '@ari/shared/ids'
import { createHash } from 'node:crypto'
import type { OperationReceipt } from '@ari/contracts/orchestration'
import { exceedsPermission } from '@ari/contracts/common'
import { createLogger } from '@ari/shared/logger'
import {
  AGENT_CONTROL_VERSION,
  ControlFailure,
  controlParams,
  type ChildTask,
  type CreatedProject,
  type ControlMethod,
  type ControlParams,
  type ControlResult,
  type DelegationSettings,
  type HelmProject,
  type ScheduledRoutine,
  type SessionPromptReceipt,
  type SessionReadQueue,
} from '@ari/contracts/agent-control'
import {
  HELM_PROJECT_ID,
  isHelmSession,
  isHelmProjectLead,
  isHelmProjectSession,
} from '@ari/contracts/helm'
import type { Session, SessionWorkspace } from '@ari/contracts/session'
import type { Message } from '@ari/contracts/message'
import type { Command, CommandReceipt } from '@ari/contracts/commands'
import { journalEventSchema, type JournalEvent } from '@ari/contracts/events'
import type { SessionListEntry, SessionStore } from './session-store'
import type { SessionReadModel, UnstampedEvent } from './projection'
import { checkDelegation, sessionLineage } from './control-policy'
import { waitForTurn, type WaitOutcome } from './control-wait'
import { childWorkState, finalAssistantText } from './delegation-state'
import type { TreeSpend } from './tree-budget'
import {
  findSessions,
  turnRequester,
  helmTaskRecipient,
  helmReportRecipient,
  questionOwnerSessionId,
  type HelmView,
} from './helm'
import {
  resolveProjectAgent,
  type ProjectAgentDefaults,
  type ProjectAgentProvider,
} from './projects'
import type { ProjectAgent, ResolvedProjectAgent } from '@ari/contracts/project'
import { resolveLaunchEffort, type LaunchEffortOption } from './launch-effort'

const log = createLogger('engine:control')

const PROJECT_MODEL_REQUIRED =
  'No valid provider/model is selected for this project. Ask the user once which provider and model to use, suggesting your current model as an option, then save the answer with `ari project default <projectId> --agent <provider> --model <model>` before starting work.'
const PROJECT_DEFAULT_MODEL_REQUIRED =
  'The project saved default is missing a model. Ask the user which model to use, then save it with `ari project default <projectId> --agent <provider> --model <model>` before starting work.'
const PROJECT_HUMAN_WAIT_MS = 3 * 60_000

/**
 * Reported when the requesting call went away (control timeout, disconnect)
 * while its delegation approval was still open. Distinct from
 * `delegation_approval_required` (the user refused) so agents know the card
 * is still up and retry with the same idempotency key instead of treating
 * the wait as a denial.
 */
const APPROVAL_PENDING_MESSAGE =
  'Delegation approval is still waiting on the user. Retry with the same idempotency key.'

/**
 * Waits out a shared delegation approval, but a caller that is gone fails
 * fast with `delegation_approval_pending`. The shared card is untouched —
 * other waiters keep waiting on it.
 */
function raceApproval(pending: Promise<boolean>, signal?: AbortSignal): Promise<boolean> {
  if (signal === undefined) return pending
  if (signal.aborted)
    return Promise.reject(
      new ControlFailure('delegation_approval_pending', APPROVAL_PENDING_MESSAGE),
    )
  return new Promise<boolean>((resolve, reject) => {
    const onAbort = (): void => {
      reject(new ControlFailure('delegation_approval_pending', APPROVAL_PENDING_MESSAGE))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    pending.then(
      (allowed) => {
        signal.removeEventListener('abort', onAbort)
        resolve(allowed)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        // ControlFailure passes through untouched; anything else stays a
        // generic failure downstream, so normalizing it changes nothing.
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}

export interface ControlHost {
  orchestration?(
    callerId: string,
    method: string,
    params: unknown,
    signal?: AbortSignal,
  ): Promise<unknown>
  store: SessionStore
  version: string
  policy(): DelegationSettings
  providers(): Promise<
    (ProjectAgentProvider & {
      models: { id: string; label: string; aliases?: readonly string[] }[]
    })[]
  >
  create(session: Session): Promise<void>
  dispatch(
    command: Command,
    origin?: { kind: 'session'; sessionId: string },
  ): Promise<CommandReceipt>
  record(id: string, event: UnstampedEvent): Promise<JournalEvent>
  subscribe(listener: (event: JournalEvent) => void): () => void
  workspace(session: Session): Promise<string | null>
  isRunning?(id: string): boolean
  canDeliverCoordination?(id: string): boolean
  deliverCoordination?(message: CoordinationMessage): Promise<boolean>
  isolate(
    parent: Session,
    childId: string,
    title?: string,
    baseSnapshotCommit?: string,
  ): Promise<SessionWorkspace>
  diff(child: Session, patch: boolean): Promise<unknown>
  integrate(
    parent: Session,
    child: Session,
    snapshot: string,
    options?: { allowStale?: boolean },
  ): Promise<unknown>
  approve(root: Session): Promise<boolean>
  quiesce?(id: string): Promise<void>
  /** Revokes access and waits for parked processes and workspace handles to close. */
  revoke?(id: string): void | Promise<void>
  release(child: Session): Promise<void>
  /** A `session wait` by this caller ended; undelivered results may now be due. */
  waitEnded?(callerId: string): void
  /** Spend across a root's whole subtree, when the host can fold it. */
  treeSpend?(rootId: string): Promise<TreeSpend>
  /** The projects Aria can reach; a runtime without them has no Aria. */
  projects?(rows?: readonly SessionListEntry[]): Promise<HelmProject[]>
  createProject?(input: { name: string; path?: string }): Promise<CreatedProject>
  projectAgentDefaults?(): ProjectAgentDefaults
  /** Model-specific support from the active provider transport; failures must remain failures. */
  effortsForModel?(
    kind: Session['driverKind'],
    modelId: string | null,
  ): Promise<readonly LaunchEffortOption[]>
  setProjectDefault?(id: string, agent: ProjectAgent): Promise<boolean>
  /** Durable scheduled prompts; absent runtimes simply cannot schedule. */
  routines?: {
    add(input: {
      sessionId: string
      prompt: string
      at: number
      everyMs?: number
    }): Promise<ScheduledRoutine>
    list(): ScheduledRoutine[]
    remove(id: string): Promise<boolean>
  }
}

/** Scoped control primitives shared by the desktop host, local CLI and deterministic tests. */
export class AgentControlService {
  readonly #receipts = new Map<string, { fingerprint: string; result: Promise<unknown> }>()
  readonly #roots = new Map<string, Promise<unknown>>()
  readonly #approved = new Set<string>()
  readonly #approving = new Map<string, Promise<boolean>>()
  readonly #activeDeliveries = new Set<string>()
  readonly #rates = new Map<string, { at: number; count: number }>()
  readonly #gone = new Map<string, Set<() => void>>()
  readonly #waiting = new Map<string, Map<string, number>>()
  constructor(readonly host: ControlHost) {}

  /** Trusted supervisor path; agents cannot manufacture provider request metadata. */
  async notifyRequest(
    senderId: string,
    recipientId: string,
    text: string,
    request: NonNullable<CoordinationMessage['request']>,
    key: string,
  ): Promise<CoordinationMessage> {
    return this.#coordinate(
      await this.#get(senderId),
      await this.#get(recipientId),
      { text, targetSessionId: recipientId, idempotencyKey: key },
      request,
    )
  }

  /** Retry only known-unsubmitted inbox entries when a new live adapter becomes ready. */
  async deliverPendingCoordination(recipientId: string): Promise<void> {
    const model = await this.host.store.loadExisting(recipientId)
    if (!model?.session || model.session.archived || !this.host.policy().enabled) return
    for (const message of Object.values(model.inbox ?? {})) {
      if (message.status !== 'pending' || (message.request && message.request.resolvedAt !== null))
        continue
      if (message.request) {
        const source = await this.host.store.loadExisting(message.senderSessionId)
        if (
          source?.activeTurnId !== message.request.sourceTurnId ||
          !(message.request.kind === 'input'
            ? source.pendingInputs.some((input) => input.inputId === message.request!.requestId)
            : source.pendingApprovals.some(
                (approval) => approval.approvalId === message.request!.requestId,
              ))
        )
          continue
      }
      await this.#deliverInbox(message)
    }
  }

  /** True while `parentId` is blocked in `session wait` on `childId`. */
  isWaiting(parentId: string, childId: string): boolean {
    return (this.#waiting.get(parentId)?.get(childId) ?? 0) > 0
  }

  #trackWait(parentId: string, childId: string, delta: 1 | -1): void {
    const children = this.#waiting.get(parentId) ?? new Map<string, number>()
    const count = (children.get(childId) ?? 0) + delta
    if (count > 0) children.set(childId, count)
    else children.delete(childId)
    if (children.size > 0) this.#waiting.set(parentId, children)
    else this.#waiting.delete(parentId)
  }

  /**
   * Marks a child turn's outcome as seen by its parent so it is not delivered
   * again. The settle may not be journaled on the parent yet; the projection
   * accepts the acknowledgment first.
   */
  async #acknowledge(
    parentId: string,
    childSessionId: string,
    turnId: string,
    via: 'wait' | 'read' | 'disposed',
  ): Promise<void> {
    const seen = (await this.host.store.load(parentId)).childCompletions?.[childSessionId]
    if ((seen?.turnId === turnId && seen.acknowledged) || seen?.earlyAck === turnId) return
    await this.host.record(parentId, {
      type: 'child.session.acknowledged',
      childSessionId,
      turnId,
      via,
    })
  }

  async #get(id: string): Promise<Session> {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id))
      throw new ControlFailure('session_not_found', 'Session not found.')
    const session = (await this.host.store.loadExisting(id))?.session
    if (!session) throw new ControlFailure('session_not_found', 'Session not found.')
    return session
  }

  async #lineage(session: Session): Promise<Session[]> {
    return sessionLineage(session, async (id) => (await this.host.store.load(id)).session)
  }

  async #target(caller: Session, id: string, ancestors = false): Promise<Session> {
    if (id === 'self' || id === caller.id) return caller
    if (id === 'parent') {
      if (!caller.parentSessionId)
        throw new ControlFailure('scope_denied', 'Session has no parent.')
      id = caller.parentSessionId
    }
    const target = await this.#get(id)
    if (target.projectId !== caller.projectId)
      throw new ControlFailure('scope_denied', 'Cross-project control is denied.')
    const descendant = (await this.#lineage(target)).some((s) => s.id === caller.id)
    const ancestor = ancestors && (await this.#lineage(caller)).some((s) => s.id === target.id)
    if (!descendant && !ancestor)
      throw new ControlFailure('scope_denied', 'Target is outside this session scope.')
    return target
  }

  /**
   * Like `#target`, but Aria reaches every session outside its own project:
   * it may look at, prompt, message, wait on and stop them. Integrating and
   * answering approvals stay with the subtree or the user.
   */
  async #reach(caller: Session, id: string, ancestors = false, steering = false): Promise<Session> {
    if (!isHelmSession(caller) || id === 'self' || id === caller.id || id === 'parent')
      return this.#target(caller, id, ancestors)
    const target = await this.#get(id)
    if (isHelmSession(target)) return this.#target(caller, id, ancestors)
    if (steering) this.#checkReachPermission(caller, target)
    return target
  }

  #checkReachPermission(caller: Session, target: Session): void {
    if (!isHelmSession(caller) || isHelmSession(target)) return
    if (exceedsPermission(target.permissionMode, caller.permissionMode))
      throw new ControlFailure(
        'scope_denied',
        'This session has higher permissions than Aria. Ask the user to send the instruction or raise Aria permissions.',
      )
  }

  #helmView(
    rows: Awaited<ReturnType<SessionStore['listSessions']>>,
    projects: HelmProject[],
  ): HelmView {
    const names = new Map(projects.map((project) => [project.projectId, project.name]))
    return {
      rows,
      load: (id) => this.host.store.load(id),
      projectName: (id) => names.get(id) ?? null,
    }
  }

  async #helmProjects(caller: Session, rows?: readonly SessionListEntry[]): Promise<HelmProject[]> {
    if (!isHelmSession(caller))
      throw new ControlFailure('scope_denied', 'Only Aria works across projects.')
    if (!this.host.projects)
      throw new ControlFailure('unsupported', 'Projects are unavailable in this runtime.')
    return (await this.host.projects(rows)).filter(
      (project) => project.projectId !== HELM_PROJECT_ID,
    )
  }

  async #projectAgent(
    project: HelmProject,
    caller: Session,
    args?: Partial<ProjectAgent>,
    providers?: readonly ProjectAgentProvider[],
  ): Promise<ResolvedProjectAgent | null> {
    const agent = resolveProjectAgent({
      project,
      ...(args === undefined ? {} : { arguments: args }),
      providers: providers ?? (await this.host.providers()),
      maxPermissionMode: caller.permissionMode,
      app: { permissionMode: 'full' },
    })
    if (!agent && project.defaultAgent && !project.defaultAgent.modelId && !args?.modelId)
      throw new ControlFailure('model_unavailable', PROJECT_DEFAULT_MODEL_REQUIRED)
    return agent
  }

  async #effort(
    agent: Pick<ProjectAgent, 'driverKind' | 'modelId' | 'effort'>,
    requested?: string | null,
    text?: string,
    baselineSource: 'project' | 'inherited' | 'lead' = 'project',
    providers?: readonly ProjectAgentProvider[],
  ) {
    if (requested === null) return resolveLaunchEffort({ requested, options: [] })
    const provider = (providers ?? (await this.host.providers())).find(
      (entry) => entry.driverKind === agent.driverKind,
    )
    const model = provider?.models.find(
      (entry) =>
        entry.id === agent.modelId ||
        (agent.modelId != null && entry.aliases?.includes(agent.modelId)),
    )
    const options = this.host.effortsForModel
      ? await this.host.effortsForModel(agent.driverKind, model?.id ?? agent.modelId)
      : (model?.efforts ?? [])
    return resolveLaunchEffort({ requested, baseline: agent.effort, baselineSource, text, options })
  }

  /** Shared with the live snapshot so it names the same agent as a launch. */
  async projects(
    caller: Session,
    rows?: Awaited<ReturnType<SessionStore['listSessions']>>,
  ): Promise<HelmProject[]> {
    const [sessions, providers] = await Promise.all([
      rows ?? this.host.store.listSessions(),
      this.host.providers(),
    ])
    const projects = await this.#helmProjects(caller, sessions)
    return projects.map((project) => {
      const agent = resolveProjectAgent({
        project,
        providers,
        app: { permissionMode: 'full' },
        maxPermissionMode: caller.permissionMode,
      })
      return {
        ...project,
        agent,
        ...(!agent && project.defaultAgent && !project.defaultAgent.modelId
          ? { agentError: PROJECT_DEFAULT_MODEL_REQUIRED }
          : {}),
      }
    })
  }

  /** Validates every request at the authoritative policy boundary. */
  async invoke(
    callerId: string,
    method: ControlMethod,
    raw: unknown,
    signal?: AbortSignal,
  ): Promise<ControlResult> {
    try {
      const parsed = controlParams[method].safeParse(raw)
      if (!parsed.success)
        throw new ControlFailure(
          'invalid_request',
          ['projects.setDefault', 'projects.lead', 'session.switch'].includes(method) &&
            parsed.error.issues.some((issue) => issue.path[0] === 'modelId')
            ? 'This command requires --model. Ask the user which model to use.'
            : 'Invalid command parameters.',
        )
      const caller = await this.#get(callerId)
      const params = parsed.data
      const run = () => this.#run(caller, method, params, signal)
      // Orchestration owns durable receipts and serializes its own mutations;
      // taking this lock too would deadlock its scoped session operations.
      if (method.startsWith('orchestration.')) return { ok: true, result: await run() }
      if (!('idempotencyKey' in params)) {
        if (method !== 'session.diff' && method !== 'session.integrate')
          return { ok: true, result: await run() }
        return { ok: true, result: await this.#chain(caller, run) }
      }
      const receiptKey = `${caller.id}:${method}:${params.idempotencyKey}`
      const fingerprint = JSON.stringify(params)
      const previous = this.#receipts.get(receiptKey)
      if (previous) {
        if (previous.fingerprint !== fingerprint)
          throw new ControlFailure(
            'invalid_request',
            'Idempotency key already used with different parameters.',
          )
        return { ok: true, result: await this.#freshReceiptResult(method, await previous.result) }
      }
      if (this.#receipts.size >= 10_000)
        throw new ControlFailure(
          'delegation_limit',
          'Control operation limit reached for this runtime.',
        )
      const raced = this.#receipts.get(receiptKey)
      if (raced) {
        if (raced.fingerprint !== fingerprint)
          throw new ControlFailure(
            'invalid_request',
            'Idempotency key already used with different parameters.',
          )
        return { ok: true, result: await this.#freshReceiptResult(method, await raced.result) }
      }
      const result = this.#chain(caller, () =>
        this.#durable(caller.id, receiptKey, method, fingerprint, params, run),
      )
      this.#receipts.set(receiptKey, { fingerprint, result })
      try {
        return { ok: true, result: await this.#freshReceiptResult(method, await result) }
      } catch (error) {
        if (this.#receipts.get(receiptKey)?.result === result) this.#receipts.delete(receiptKey)
        throw error
      }
    } catch (error) {
      if (error instanceof ControlFailure)
        return {
          ok: false,
          error: { code: error.code, message: error.message, details: error.details },
        }
      log.error('control operation failed', { method })
      return { ok: false, error: { code: 'internal_error', message: 'Control operation failed.' } }
    }
  }

  /** Mutation receipts retain identity; current inbox state decides message delivery status. */
  async #freshReceiptResult(method: ControlMethod, result: unknown): Promise<unknown> {
    if (
      method !== 'session.message' ||
      !result ||
      typeof result !== 'object' ||
      !('messageId' in result) ||
      !('recipientSessionId' in result) ||
      typeof result.messageId !== 'string' ||
      typeof result.recipientSessionId !== 'string'
    )
      return result
    const accepted = (await this.host.store.loadExisting(result.recipientSessionId))?.inbox?.[
      result.messageId
    ]
    return accepted ? this.#coordinationState(accepted) : result
  }

  /** Journal barriers surround effects whose repetition could submit or integrate twice. */
  async #durable(
    callerId: string,
    key: string,
    method: ControlMethod,
    fingerprint: string,
    params: unknown,
    run: () => Promise<unknown>,
  ): Promise<unknown> {
    const operationId = `control_${createHash('sha256').update(key).digest('hex').slice(0, 32)}`
    const previous = (await this.host.store.load(callerId)).orchestration?.operations[operationId]
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        throw new ControlFailure(
          'invalid_request',
          'Idempotency key already used with different parameters.',
        )
      if (previous.status !== 'completed' && method === 'session.ack') {
        const p = params as ControlParams<'session.ack'>
        const inbox = (await this.host.store.load(callerId)).inbox ?? {}
        if (p.messageIds.every((id) => inbox[id]?.status === 'consumed')) {
          const result = { acknowledged: p.messageIds }
          await this.host.record(callerId, {
            type: 'orchestration.operation.updated',
            operation: {
              ...previous,
              status: 'completed',
              completedAt: Date.now(),
              result: { ok: true, result },
            },
          })
          return result
        }
      }
      if (previous.status !== 'completed' && method === 'session.message') {
        // Recipient acceptance is the authoritative durable effect, even if the sender receipt was lost.
        const p = params as ControlParams<'session.message'>
        const caller = await this.#get(callerId)
        const target = await this.#messageTarget(caller, p.targetSessionId)
        const accepted = (await this.host.store.load(target.id)).inbox?.[
          this.#messageId(callerId, p.idempotencyKey)
        ]
        if (accepted) {
          const result = await this.#coordinationState(accepted)
          await this.host.record(callerId, {
            type: 'orchestration.operation.updated',
            operation: {
              ...previous,
              status: 'completed',
              completedAt: Date.now(),
              result: { ok: true, result },
            },
          })
          return result
        }
      }
      if (previous.status !== 'completed') {
        if (previous.status === 'started')
          await this.host.record(callerId, {
            type: 'orchestration.operation.updated',
            operation: {
              ...previous,
              status: 'uncertain',
              detail:
                'Process ended before the operation outcome was persisted. Inspect state before recovery.',
            },
          })
        throw new ControlFailure(
          'uncertain_outcome',
          'The previous operation may have completed. It will not be repeated automatically.',
          { operationId },
        )
      }
      const outcome = previous.result as ControlResult
      if (outcome.ok) return outcome.result
      // A known validation/policy refusal did not perform the effect. A new
      // caller may retry after its outstanding approval or condition changes.
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
    await this.host.record(callerId, {
      type: 'orchestration.operation.updated',
      operation: receipt,
    })
    try {
      const result = await run()
      await this.host.record(callerId, {
        type: 'orchestration.operation.updated',
        operation: {
          ...receipt,
          status: 'completed',
          completedAt: Date.now(),
          result: { ok: true, result },
        },
      })
      return result
    } catch (error) {
      const progress = (await this.host.store.load(callerId)).orchestration?.operations[operationId]
        ?.result
      const known =
        error instanceof ControlFailure &&
        !['internal_error', 'uncertain_outcome'].includes(error.code)
      await this.host.record(callerId, {
        type: 'orchestration.operation.updated',
        operation: {
          ...receipt,
          status: known ? 'completed' : 'uncertain',
          completedAt: known ? Date.now() : null,
          result: known
            ? { ok: false, error: { code: error.code, message: error.message } }
            : progress,
          detail: known
            ? error.message
            : 'The effect may have completed before the durable outcome. Inspect state before recovery.',
        },
      })
      throw error
    }
  }

  async #chain(caller: Session, run: () => Promise<unknown>): Promise<unknown> {
    const root = (await this.#lineage(caller)).at(-1) as Session
    // Aria topics share project sessions and one concurrency cap.
    const key = isHelmSession(caller) ? HELM_PROJECT_ID : root.id
    const next = (this.#roots.get(key) ?? Promise.resolve()).catch(() => undefined).then(run)
    this.#roots.set(key, next)
    void next
      .finally(() => {
        if (this.#roots.get(key) === next) this.#roots.delete(key)
      })
      .catch(() => undefined)
    return next
  }

  #watchGone(id: string, listener: () => void): () => void {
    const set = this.#gone.get(id) ?? new Set<() => void>()
    set.add(listener)
    this.#gone.set(id, set)
    return () => {
      set.delete(listener)
      if (set.size === 0) this.#gone.delete(id)
    }
  }

  #notifyGone(id: string): void {
    for (const listener of this.#gone.get(id) ?? []) listener()
    this.#gone.delete(id)
  }

  async #run(
    caller: Session,
    method: ControlMethod,
    raw: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    caller = await this.#get(caller.id)
    if (method.startsWith('orchestration.')) {
      if (!this.host.orchestration)
        throw new ControlFailure('unsupported', 'Orchestration is unavailable in this runtime.')
      return this.host.orchestration(caller.id, method, raw, signal)
    }
    switch (method) {
      case 'runtime.info': {
        const chain = await this.#lineage(caller)
        const root = chain.at(-1) as Session
        const policy = this.host.policy()
        const spend = this.host.treeSpend ? await this.host.treeSpend(root.id) : null
        return {
          protocolVersion: AGENT_CONTROL_VERSION,
          ariVersion: this.host.version,
          caller: {
            sessionId: caller.id,
            projectId: caller.projectId,
            driverKind: caller.driverKind,
            modelId: caller.modelId,
            effort: caller.effort ?? null,
            permissionMode: caller.permissionMode,
            aria: isHelmSession(caller),
            parentSessionId: caller.parentSessionId ?? null,
            rootSessionId: root.id,
            depth: chain.length - 1,
          },
          limits: {
            ...policy,
            delegationEnabled: policy.enabled,
            remainingConcurrentSlots: Math.max(
              0,
              policy.maxConcurrentChildren - (await this.#active(root.id)),
            ),
            ...(spend === null ? {} : { spend }),
          },
          capabilities: {
            isolatedWorktrees: true,
            sharedWorkspace: policy.allowSharedWorkspace,
            integration: true,
            recursiveDelegation: policy.recursiveDelegation,
            crossProject: isHelmSession(caller),
          },
        }
      }
      case 'providers.list':
        return this.host.providers()
      case 'projects.list':
        return { projects: await this.projects(caller) }
      case 'projects.create': {
        if (!isHelmSession(caller))
          throw new ControlFailure('scope_denied', 'Only Aria creates projects.')
        if (!this.host.createProject)
          throw new ControlFailure(
            'unsupported',
            'Project creation is unavailable in this runtime.',
          )
        const p = raw as ControlParams<'projects.create'>
        return this.host.createProject({
          name: p.name,
          ...(p.path === undefined ? {} : { path: p.path }),
        })
      }
      case 'projects.setDefault': {
        const p = raw as ControlParams<'projects.setDefault'>
        const project = (await this.#helmProjects(caller)).find(
          (entry) => entry.projectId === p.projectId,
        )
        if (!project) throw new ControlFailure('project_not_found', 'Project not found.')
        if (!this.host.setProjectDefault)
          throw new ControlFailure(
            'unsupported',
            'Project defaults are unavailable in this runtime.',
          )
        const agent = {
          driverKind: p.driverKind,
          modelId: p.modelId,
          effort: p.effort === 'auto' ? null : (p.effort ?? null),
          permissionMode: p.permissionMode ?? caller.permissionMode,
        }
        if (exceedsPermission(agent.permissionMode, caller.permissionMode))
          throw new ControlFailure(
            'scope_denied',
            'Project default permissions cannot exceed Aria permissions. Ask the user to raise Aria permissions.',
          )
        const resolved = await this.#projectAgent({ ...project, defaultAgent: agent }, caller, p)
        if (!resolved) throw new ControlFailure('model_unavailable', PROJECT_MODEL_REQUIRED)
        if (p.effort !== undefined && p.effort !== 'auto') await this.#effort(resolved, p.effort)
        // Discovery can outlast a permission or archive change. Authorize the write
        // against the current caller, without another discovery await in between.
        const currentCaller = await this.#get(caller.id)
        if (currentCaller.archived)
          throw new ControlFailure('scope_denied', 'Restore Aria before saving a project default.')
        if (exceedsPermission(agent.permissionMode, currentCaller.permissionMode))
          throw new ControlFailure(
            'scope_denied',
            'Aria permissions changed while resolving the project default. The default was not saved.',
          )
        if (!(await this.host.setProjectDefault(project.projectId, agent)))
          throw new ControlFailure('project_not_found', 'Project not found.')
        return {
          projectId: project.projectId,
          defaultAgent: agent,
          agent: await this.#projectAgent(
            { ...project, defaultAgent: agent },
            await this.#get(caller.id),
          ),
        }
      }
      case 'projects.ask':
        return this.#askProject(caller, raw as ControlParams<'projects.ask'>, signal)
      case 'projects.lead':
        return this.#changeProjectLead(caller, raw as ControlParams<'projects.lead'>)
      case 'sessions.find': {
        const p = raw as ControlParams<'sessions.find'>
        const projects = await this.#helmProjects(caller)
        const view = this.#helmView(await this.host.store.listSessions(), projects)
        return { sessions: await findSessions(view, p) }
      }
      case 'session.get':
        return this.#reach(caller, (raw as ControlParams<'session.get'>).targetSessionId, true)
      case 'session.children': {
        const p = raw as ControlParams<'session.children'>
        const parent = await this.#reach(caller, p.targetSessionId)
        const children = []
        for (const row of await this.host.store.listSessions()) {
          if (row.parentSessionId === parent.id) children.push(row)
          else if (
            p.recursive &&
            row.parentSessionId &&
            row.projectId === parent.projectId &&
            (await this.#lineage(await this.#get(row.id))).some((s) => s.id === parent.id)
          )
            children.push(row)
        }
        return { children }
      }
      case 'session.spawn':
        return this.#spawn(caller, raw as ControlParams<'session.spawn'>, signal)
      case 'session.switch': {
        const p = raw as ControlParams<'session.switch'>
        const target = await this.#get(p.targetSessionId === 'self' ? caller.id : p.targetSessionId)
        return this.#switchProjectSession(caller, target, p)
      }
      case 'session.prompt': {
        const p = raw as ControlParams<'session.prompt'>
        let target = await this.#reach(caller, p.targetSessionId, false, true)
        const owned =
          (isHelmSession(caller) && isHelmProjectSession(target)) ||
          target.parentSessionId === caller.id
        if (!owned) {
          if (p.effort !== undefined)
            throw new ControlFailure(
              'scope_denied',
              'Reasoning changes are limited to sessions you launched or direct workers.',
            )
          return this.#prompt(caller, target, p.text)
        }
        if (caller.archived || target.archived)
          throw new ControlFailure('scope_denied', 'Restore the session before assigning work.')
        if (!this.host.policy().enabled)
          throw new ControlFailure('delegation_disabled', 'Delegation is disabled.')
        const effortSelection = await this.#effort(
          { ...target, effort: target.effort ?? null },
          p.effort,
          p.text,
          'inherited',
        )
        const current = await this.#get(caller.id)
        const fresh = await this.#reach(current, target.id, false, true)
        if (current.archived || fresh.archived)
          throw new ControlFailure('scope_denied', 'Restore the session before assigning work.')
        if (fresh.driverKind !== target.driverKind || fresh.modelId !== target.modelId)
          throw new ControlFailure(
            'model_unavailable',
            'The target model changed during effort discovery. Retry the assignment.',
          )
        if (isHelmSession(current) && !fresh.parentSessionId)
          await this.#checkProjectCode(fresh.projectId, fresh.id)
        if ((fresh.effort ?? null) !== effortSelection.resolved) {
          const updated = await this.host.dispatch({
            type: 'session.update',
            sessionId: fresh.id,
            effort: effortSelection.resolved,
          })
          if (!updated.accepted)
            throw new ControlFailure('turn_refused', updated.reason ?? 'Reasoning update refused.')
        }
        target = await this.#get(fresh.id)
        const prompted = await this.#prompt(current, target, p.text)
        return { ...prompted, agent: { ...leadAgent(target), effortSelection } }
      }
      case 'session.message': {
        const p = raw as ControlParams<'session.message'>
        const target = await this.#messageTarget(caller, p.targetSessionId)
        this.#checkReachPermission(caller, target)
        return this.#coordinate(caller, target, p)
      }
      case 'session.delivery': {
        const p = raw as ControlParams<'session.delivery'>
        const target = await this.#messageTarget(caller, p.targetSessionId)
        const message = (await this.host.store.load(target.id)).inbox?.[p.messageId]
        if (!message || message.senderSessionId !== caller.id)
          throw new ControlFailure(
            'scope_denied',
            'Delivery state belongs to the sender of this scoped message.',
          )
        return this.#coordinationState(message)
      }
      case 'session.inbox': {
        const p = raw as ControlParams<'session.inbox'>
        const entries = Object.values((await this.host.store.load(caller.id)).inbox ?? {})
        return {
          sessionId: caller.id,
          messages: await Promise.all(
            entries
              .filter((entry) => p.includeConsumed || entry.status !== 'consumed')
              .map((entry) => this.#coordinationState(entry)),
          ),
        }
      }
      case 'session.ack': {
        const p = raw as ControlParams<'session.ack'>
        const inbox = (await this.host.store.load(caller.id)).inbox ?? {}
        if (p.messageIds.some((id) => !inbox[id]))
          throw new ControlFailure(
            'scope_denied',
            'Acknowledgements belong to the recipient inbox.',
          )
        for (const id of new Set(p.messageIds)) {
          const message = inbox[id]!
          if (message.status !== 'consumed')
            await this.host.record(caller.id, {
              type: 'coordination.updated',
              message: { ...message, status: 'consumed', consumedAt: Date.now() },
            })
        }
        return { acknowledged: p.messageIds }
      }
      case 'session.answer': {
        const p = raw as ControlParams<'session.answer'>
        const child = await this.#reach(caller, p.targetSessionId, false, true)
        // Aria answers questions on turns it started; the check below holds it to those.
        if (child.parentSessionId !== caller.id && !isHelmSession(caller))
          throw new ControlFailure(
            'scope_denied',
            'Only the direct parent can answer a child question.',
          )
        const model = await this.host.store.load(child.id)
        if ((await questionOwnerSessionId(this.host.store, model)) !== caller.id)
          throw new ControlFailure(
            'scope_denied',
            'This question belongs to the human, not the lead.',
          )
        if (model.pendingApprovals.some((approval) => approval.approvalId === p.inputId))
          throw new ControlFailure(
            'invalid_request',
            'Approvals are answered by the user, not by the lead.',
          )
        if (!model.pendingInputs.some((input) => input.inputId === p.inputId))
          throw new ControlFailure('invalid_request', 'That question is no longer pending.')
        const outcome = await this.host.dispatch(
          {
            type: 'input.respond',
            sessionId: child.id,
            inputId: p.inputId,
            value: p.value,
            expectedTurnId: model.activeTurnId!,
          },
          { kind: 'session', sessionId: caller.id },
        )
        if (!outcome.accepted)
          throw new ControlFailure('invalid_request', outcome.reason ?? 'The answer was refused.')
        return { inputId: p.inputId, answered: true }
      }
      case 'session.read':
        return this.#read(
          caller,
          await this.#reach(caller, (raw as ControlParams<'session.read'>).targetSessionId),
          raw as ControlParams<'session.read'>,
        )
      case 'session.wait':
        return this.#wait(caller, raw as ControlParams<'session.wait'>, signal)
      case 'session.status':
        return this.#status(caller, raw as ControlParams<'session.status'>)
      case 'session.stop': {
        const target = await this.#reach(
          caller,
          (raw as ControlParams<'session.stop'>).targetSessionId,
        )
        const state = await this.host.store.load(target.id)
        // The caller knows it stopped this turn; it needs no wake-up about it.
        if (
          state.activeTurnId &&
          (target.parentSessionId === caller.id ||
            turnRequester(state, state.activeTurnId) === caller.id)
        )
          await this.#acknowledge(caller.id, target.id, state.activeTurnId, 'disposed')
        if (state.activeTurnId)
          await this.host.dispatch({ type: 'turn.interrupt', sessionId: target.id })
        // Stopping a child cancels its delegated work too: a held message must
        // not start after the turn it was waiting behind is interrupted.
        for (const queued of state.queuedMessages.filter((message) => message.held === true)) {
          await this.host.dispatch({
            type: 'message.dequeue',
            sessionId: target.id,
            text: queued.text,
            attachments: queued.attachments,
          })
        }
        if (target.id !== caller.id && state.activeTurnId)
          await this.host.record(caller.id, {
            type: 'child.session.stopped',
            childSessionId: target.id,
          })
        return { sessionId: target.id, stopped: state.activeTurnId !== null }
      }
      case 'session.destroy': {
        const id = (raw as ControlParams<'session.destroy'>).targetSessionId
        const candidate =
          isHelmSession(caller) && id !== 'self' && id !== 'parent'
            ? await this.#get(id)
            : await this.#target(caller, id)
        const target =
          isHelmSession(caller) && isHelmProjectSession(candidate)
            ? candidate
            : await this.#target(caller, id)
        return this.#destroy(caller, target)
      }
      case 'session.diff':
      case 'session.integrate': {
        const p = raw as ControlParams<'session.integrate'> & ControlParams<'session.diff'>
        const child = await this.#target(caller, p.targetSessionId)
        if (child.parentSessionId !== caller.id)
          throw new ControlFailure(
            'scope_denied',
            'Only direct child changes may be inspected or integrated.',
          )
        if ((await this.host.store.load(child.id)).activeTurnId || this.host.isRunning?.(child.id))
          throw new ControlFailure(
            'invalid_request',
            'Wait for the child to settle before inspecting its snapshot.',
          )
        return method === 'session.diff'
          ? this.host.diff(child, p.patch)
          : this.host.integrate(caller, child, p.snapshotCommit, { allowStale: p.allowStale })
      }
      case 'routine.add': {
        const p = raw as ControlParams<'routine.add'>
        const routines = this.host.routines
        if (!routines)
          throw new ControlFailure('routines_unavailable', 'Scheduled prompts are unavailable.')
        const target = await this.#target(caller, p.targetSessionId)
        if (target.archived)
          throw new ControlFailure('scope_denied', 'Restore the session before scheduling it.')
        return routines.add({
          sessionId: target.id,
          prompt: p.prompt,
          at: p.at,
          ...(p.everyMs == null ? {} : { everyMs: p.everyMs }),
        })
      }
      case 'routine.list': {
        const p = raw as ControlParams<'routine.list'>
        const routines = this.host.routines
        if (!routines)
          throw new ControlFailure('routines_unavailable', 'Scheduled prompts are unavailable.')
        const parent = await this.#target(caller, p.targetSessionId)
        const allowed = new Set([
          parent.id,
          ...(p.recursive ? descendantIds(await this.host.store.listSessions(), parent.id) : []),
        ])
        return { routines: routines.list().filter((entry) => allowed.has(entry.sessionId)) }
      }
      case 'routine.remove': {
        const p = raw as ControlParams<'routine.remove'>
        const routines = this.host.routines
        if (!routines)
          throw new ControlFailure('routines_unavailable', 'Scheduled prompts are unavailable.')
        const entry = routines.list().find((other) => other.id === p.routineId)
        if (!entry) throw new ControlFailure('routine_not_found', 'Scheduled prompt not found.')
        await this.#target(caller, entry.sessionId)
        return { routineId: entry.id, removed: await routines.remove(entry.id) }
      }
    }
    throw new ControlFailure('unsupported', 'Unsupported control operation.')
  }

  async #active(rootId: string): Promise<number> {
    let active = 0
    for (const row of await this.host.store.listSessions()) {
      if (
        row.id !== rootId &&
        row.rootSessionId === rootId &&
        ((await this.host.store.load(row.id)).activeTurnId || this.host.isRunning?.(row.id))
      )
        active++
    }
    return active
  }

  async #existingSpawn(caller: Session, key: string): Promise<unknown> {
    const spawned = (await this.host.store.load(caller.id)).childEvents?.find(
      (event) => event.type === 'child.session.spawned' && event.idempotencyKey === key,
    )
    if (!spawned || spawned.type !== 'child.session.spawned') return null
    try {
      const child = await this.#get(spawned.childSessionId)
      return {
        child,
        agent: leadAgent(child),
        workspace: { ...child.workspace, path: await this.host.workspace(child) },
        initialTurn: null,
      }
    } catch {
      return null
    }
  }

  async #requestApproval(root: Session, signal?: AbortSignal): Promise<boolean> {
    let pending = this.#approving.get(root.id)
    if (!pending) {
      const request = this.host.approve(root)
      this.#approving.set(root.id, request)
      // The entry lives until the shared card settles so every overlapping
      // spawn joins the same approval instead of opening its own card. A
      // granted approval outlives any single waiter, so a caller that went
      // away mid-wait still leaves its retry covered without a second card.
      const cleanup = (): void => {
        if (this.#approving.get(root.id) === request) this.#approving.delete(root.id)
      }
      void request.then((allowed) => {
        if (allowed) this.#approved.add(root.id)
        cleanup()
      }, cleanup)
      pending = request
    }
    return raceApproval(pending, signal)
  }

  async #spawnProgress(
    callerId: string,
    key: string,
    recovery: unknown,
    method: 'session.spawn' | 'projects.ask' = 'session.spawn',
  ): Promise<void> {
    const operationId = `control_${createHash('sha256').update(`${callerId}:${method}:${key}`).digest('hex').slice(0, 32)}`
    const operation = (await this.host.store.load(callerId)).orchestration?.operations[operationId]
    if (operation?.status === 'started')
      await this.host.record(callerId, {
        type: 'orchestration.operation.updated',
        operation: { ...operation, result: { recovery } },
      })
  }

  async #spawn(
    caller: Session,
    p: ControlParams<'session.spawn'>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const existing = await this.#existingSpawn(caller, p.idempotencyKey)
    if (existing) return existing
    if (isHelmSession(caller)) return this.#launch(caller, p, signal)
    if (p.projectId !== undefined && p.projectId !== caller.projectId)
      throw new ControlFailure('scope_denied', 'Only Aria starts sessions in other projects.')
    const chain = await this.#lineage(caller)
    const root = chain.at(-1) as Session
    const policy = this.host.policy()
    const rows = await this.host.store.listSessions()
    if (caller.archived)
      throw new ControlFailure('scope_denied', 'Restore the parent before delegating.')
    checkDelegation(
      policy,
      chain.length - 1,
      rows.filter((s) => s.parentSessionId === caller.id).length,
      this.host.treeSpend ? await this.host.treeSpend(root.id) : undefined,
    )
    if (!p.driverKind)
      throw new ControlFailure('invalid_request', 'Child sessions require --agent.')
    const provider = (await this.host.providers()).find(
      (v) => v.driverKind === p.driverKind && v.available,
    )
    if (!provider)
      throw new ControlFailure('provider_unavailable', 'Requested provider is unavailable.')
    if (
      p.modelId &&
      !provider.models.some((m) => m.id === p.modelId || m.aliases?.includes(p.modelId!))
    )
      throw new ControlFailure('model_unavailable', 'Requested model is unavailable.')
    const permissionMode = p.permissionMode ?? caller.permissionMode
    if (exceedsPermission(permissionMode, caller.permissionMode))
      throw new ControlFailure(
        'scope_denied',
        'Child permissions cannot exceed parent permissions.',
      )
    const selectedModel = provider.models.find(
      (model) =>
        model.id === p.modelId || (p.modelId != null && model.aliases?.includes(p.modelId)),
    )
    const sameModel =
      caller.driverKind === p.driverKind &&
      (caller.modelId === (selectedModel?.id ?? p.modelId ?? null) ||
        (caller.modelId != null && selectedModel?.aliases?.includes(caller.modelId)))
    const effortSelection = await this.#effort(
      {
        driverKind: p.driverKind,
        modelId: selectedModel?.id ?? p.modelId ?? null,
        effort: sameModel ? (caller.effort ?? null) : null,
      },
      p.effort,
      p.prompt ?? p.title,
      'inherited',
    )
    const mode = p.workspaceMode ?? policy.defaultWorkspaceMode
    if (mode === 'shared' && !policy.allowSharedWorkspace)
      throw new ControlFailure('scope_denied', 'Shared workspaces are disabled.')
    await this.#approveDelegation(root, policy, signal)
    // User policy and parent permissions can change while the approval is open.
    // Revalidate them before preparing any workspace or creating a session.
    const currentCaller = await this.#get(caller.id)
    const currentPolicy = this.host.policy()
    checkDelegation(
      currentPolicy,
      chain.length - 1,
      (await this.host.store.listSessions()).filter((row) => row.parentSessionId === caller.id)
        .length,
      this.host.treeSpend ? await this.host.treeSpend(root.id) : undefined,
    )
    if (currentCaller.archived || exceedsPermission(permissionMode, currentCaller.permissionMode))
      throw new ControlFailure(
        'scope_denied',
        'Parent permissions changed while delegation was pending.',
      )
    if (mode === 'shared' && !currentPolicy.allowSharedWorkspace)
      throw new ControlFailure('scope_denied', 'Shared workspaces are disabled.')
    const id = newTypedId('sess')
    let child: Session | undefined
    let isolated = false
    await this.#spawnProgress(caller.id, p.idempotencyKey, {
      childSessionId: id,
      stage: 'workspace_preparing',
    })
    try {
      const workspace =
        mode === 'isolated'
          ? await this.host.isolate(caller, id, p.title, p.baseSnapshotCommit)
          : { kind: 'project' as const }
      isolated = mode === 'isolated'
      await this.#spawnProgress(caller.id, p.idempotencyKey, {
        childSessionId: id,
        workspace,
        stage: 'workspace_prepared',
      })
      // Preparing a worktree can outlast the caller. Whoever asked is no
      // longer there to receive the id, so no child is minted for it.
      if (signal?.aborted)
        throw new ControlFailure('request_cancelled', 'The caller disconnected before the spawn.')
      const launchCaller = await this.#get(caller.id)
      if (launchCaller.archived || exceedsPermission(permissionMode, launchCaller.permissionMode))
        throw new ControlFailure(
          'scope_denied',
          'Parent permissions changed while preparing the worker workspace.',
        )
      child = {
        id,
        projectId: caller.projectId,
        parentSessionId: caller.id,
        rootSessionId: root.id,
        createdBy: { kind: 'session', sessionId: caller.id },
        ...(p.role ? { role: p.role } : {}),
        workspace,
        title: p.title,
        driverKind: p.driverKind,
        modelId: selectedModel?.id ?? p.modelId ?? null,
        effort: effortSelection.resolved,
        permissionMode,
        status: 'idle',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }
      await this.host.create(child)
      await this.#spawnProgress(caller.id, p.idempotencyKey, {
        childSessionId: id,
        workspace,
        stage: 'session_created',
      })
      await this.host.record(caller.id, {
        type: 'child.session.spawned',
        childSessionId: id,
        title: child.title,
        driverKind: child.driverKind,
        modelId: child.modelId,
        workspaceKind: workspace.kind,
        branch: workspace.kind === 'managed-worktree' ? workspace.branch : null,
        ...(p.role ? { role: p.role } : {}),
        idempotencyKey: p.idempotencyKey,
      })
      const initialTurn = p.prompt ? await this.#prompt(caller, child, p.prompt) : null
      return {
        child,
        agent: { ...leadAgent(child), source: 'arguments', effortSelection },
        workspace: { ...workspace, path: await this.host.workspace(child) },
        initialTurn,
      }
    } catch (error) {
      // Once session creation is attempted, preserve the worktree and journal
      // for explicit inspection. Provider submission may already have happened.
      if (
        !child &&
        isolated &&
        error instanceof ControlFailure &&
        (error.code === 'request_cancelled' || error.code === 'scope_denied')
      )
        await this.host.release({ ...caller, id }).catch(() => undefined)
      if (child && error instanceof ControlFailure)
        throw new ControlFailure(
          'uncertain_outcome',
          'Worker creation was attempted before a later refusal. Inspect the preserved session before recovery.',
          { childSessionId: id },
        )
      throw error
    }
  }

  /** The delegation approval card, shown once per root unless policy says always. */
  async #approveDelegation(
    root: Session,
    policy: DelegationSettings,
    signal?: AbortSignal,
  ): Promise<void> {
    if (policy.approvalMode === 'never') return
    const prior =
      this.#approved.has(root.id) ||
      ((await this.host.store.load(root.id)).childEvents ?? []).some(
        (event) => event.type === 'child.session.spawned',
      )
    if (policy.approvalMode === 'always' || !prior) {
      if (!(await this.#requestApproval(root, signal)))
        throw new ControlFailure('delegation_approval_required', 'Delegation was not approved.')
      // A caller that went away mid-wait must not mint an orphan child: its
      // retry (same idempotency key) creates the one child.
      if (signal?.aborted)
        throw new ControlFailure('delegation_approval_pending', APPROVAL_PENDING_MESSAGE)
    }
    this.#approved.add(root.id)
  }

  /**
   * Aria starts a top-level session in one of the user's projects. It works in
   * the project folder, as a chat the user opened there would, and may split
   * its work across isolated children of its own. Its reports come back to
   * Aria because Aria started its turns.
   */
  async #launch(
    caller: Session,
    p: ControlParams<'session.spawn'>,
    signal?: AbortSignal,
    lead = false,
    resolvedAgent?: ResolvedProjectAgent,
  ): Promise<unknown> {
    if (p.projectId === undefined)
      throw new ControlFailure(
        'invalid_request',
        'Aria starts work inside a project. Pass --project with an id from `ari projects`.',
      )
    if (p.workspaceMode === 'isolated' || p.baseSnapshotCommit !== undefined)
      throw new ControlFailure(
        'invalid_request',
        'Sessions Aria starts work in the project folder. Ask that session to split the work across isolated children.',
      )
    if (caller.archived) throw new ControlFailure('scope_denied', 'Restore Aria before delegating.')
    const project = (await this.#helmProjects(caller)).find(
      (entry) => entry.projectId === p.projectId,
    )
    if (!project) throw new ControlFailure('project_not_found', 'Project not found.')
    if (!project.available)
      throw new ControlFailure('project_unavailable', 'That project folder is missing.')
    const policy = this.host.policy()
    checkDelegation(policy, 0, 0)
    if (p.permissionMode && exceedsPermission(p.permissionMode, caller.permissionMode))
      throw new ControlFailure(
        'scope_denied',
        'Session permissions cannot exceed Aria permissions.',
      )
    const selected = resolvedAgent ?? (await this.#projectAgent(project, caller, p))
    if (!selected) throw new ControlFailure('model_unavailable', PROJECT_MODEL_REQUIRED)
    const effortSelection =
      selected.effortSelection ?? (await this.#effort(selected, p.effort, p.prompt ?? p.title))
    const agent = { ...selected, effort: effortSelection.resolved, effortSelection }
    const { permissionMode } = agent
    const launch = {
      ...agent,
      projectId: project.projectId,
    }
    await this.#checkLaunch(caller, launch)
    await this.#approveDelegation(caller, policy, signal)
    const current = await this.#get(caller.id)
    if (current.archived || exceedsPermission(permissionMode, current.permissionMode))
      throw new ControlFailure(
        'scope_denied',
        'Aria permissions changed while delegation was pending.',
      )
    checkDelegation(this.host.policy(), 0, 0)
    await this.#checkLaunch(current, launch)
    const id = newTypedId('sess')
    const workspace = { kind: 'project' as const }
    const session: Session = {
      id,
      projectId: project.projectId,
      createdBy: { kind: 'session', sessionId: caller.id },
      ...(lead ? { lead: true } : {}),
      ...(p.role ? { role: p.role } : {}),
      workspace,
      title: p.title,
      driverKind: agent.driverKind,
      modelId: agent.modelId,
      effort: agent.effort,
      permissionMode,
      status: 'idle',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    await this.#spawnProgress(
      caller.id,
      p.idempotencyKey,
      {
        childSessionId: id,
        workspace,
        stage: 'session_creating',
      },
      lead ? 'projects.ask' : 'session.spawn',
    )
    let created = false
    try {
      await this.host.create(session)
      created = true
      await this.host.record(caller.id, {
        type: 'child.session.spawned',
        childSessionId: id,
        title: session.title,
        driverKind: session.driverKind,
        modelId: session.modelId,
        workspaceKind: 'project',
        branch: null,
        ...(p.role ? { role: p.role } : {}),
        idempotencyKey: lead
          ? `project-ask_${createHash('sha256').update(p.idempotencyKey).digest('hex').slice(0, 32)}`
          : p.idempotencyKey,
      })
      const initialTurn = p.prompt ? await this.#prompt(caller, session, p.prompt) : null
      return {
        child: session,
        agent,
        workspace: { ...workspace, path: await this.host.workspace(session) },
        initialTurn,
      }
    } catch (error) {
      if (created && error instanceof ControlFailure)
        throw new ControlFailure(
          'uncertain_outcome',
          'Session creation was attempted before a later refusal. Inspect it before recovery.',
          { childSessionId: id },
        )
      throw error
    }
  }

  async #destroy(
    caller: Session,
    target: Session,
  ): Promise<{ sessionId: string; destroyed: boolean; count: number }> {
    if (isHelmSession(caller)) {
      const current = await this.#get(caller.id)
      if (current.archived)
        throw new ControlFailure('scope_denied', 'Restore Aria before destroying a session.')
      this.#checkReachPermission(current, await this.#get(target.id))
    }
    if (target.id === caller.id)
      throw new ControlFailure('scope_denied', 'A session cannot destroy itself.')
    const rows = await this.host.store.listSessions()
    const ids = [...descendantIds(rows, target.id), target.id]
    for (const id of ids) {
      const state = await this.host.store.load(id).catch(() => null)
      try {
        if (state?.activeTurnId || this.host.isRunning?.(id)) {
          await this.host.dispatch({ type: 'turn.interrupt', sessionId: id })
          await this.host.quiesce?.(id)
        }
      } catch (error) {
        log.warn('session interrupt before deletion failed', {
          sessionId: id,
          error: String(error),
        })
      }
      try {
        await this.host.revoke?.(id)
      } catch (error) {
        log.warn('session pre-delete cleanup failed', { sessionId: id, error: String(error) })
      }
      try {
        await this.host.store.destroy(id)
      } catch (error) {
        if (!(
          error &&
          typeof error === 'object' &&
          'code' in error &&
          error.code === 'session_not_found'
        ))
          throw error
      }
      await this.host.release(state?.session ?? { ...target, id }).catch((error: unknown) =>
        log.warn('destroyed session workspace cleanup deferred', {
          sessionId: id,
          error: String(error),
        }),
      )
      this.#notifyGone(id)
    }
    await this.host.record(caller.id, {
      type: 'child.session.destroyed',
      childSessionId: target.id,
    })
    return { sessionId: target.id, destroyed: true, count: ids.length }
  }

  /** Aria's mutation chain keeps fresh chats on one live project lead. */
  async #askProject(
    caller: Session,
    p: ControlParams<'projects.ask'>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const [rows, providers] = await Promise.all([
      this.host.store.listSessions(),
      this.host.providers(),
    ])
    const project = (await this.#helmProjects(caller, rows)).find(
      (entry) => entry.projectId === p.projectId,
    )
    if (!project) throw new ControlFailure('project_not_found', 'Project not found.')
    if (!project.available)
      throw new ControlFailure('project_unavailable', 'That project folder is missing.')
    if (caller.archived) throw new ControlFailure('scope_denied', 'Restore Aria before delegating.')
    if (p.permissionMode && exceedsPermission(p.permissionMode, caller.permissionMode))
      throw new ControlFailure(
        'scope_denied',
        'Session permissions cannot exceed Aria permissions.',
      )
    for (const lead of await this.#projectLeads(rows, p.projectId)) {
      // Only Aria creates top-level sessions with a session creator. Its chat
      // may have been deleted; the project's lead keeps its context.
      const changingModel = p.driverKind !== undefined || p.modelId !== undefined
      if (!changingModel && leadUsable(lead, providers) !== true) continue
      this.#checkReachPermission(caller, lead)
      const driverKind = p.driverKind ?? lead.driverKind
      const modelId = p.modelId ?? (driverKind === lead.driverKind ? lead.modelId : null)
      if (!modelId)
        throw new ControlFailure('model_unavailable', 'Changing a lead provider requires --model.')
      const proposed = {
        ...lead,
        driverKind,
        modelId,
        permissionMode: p.permissionMode ?? lead.permissionMode,
      }
      await this.#checkLaunch(caller, proposed, true, providers)
      const selection = await this.#effort(
        { driverKind, modelId, effort: lead.effort ?? null },
        p.effort,
        p.text,
        'lead',
        providers,
      )
      await this.#approveDelegation(caller, this.host.policy(), signal)
      const current = await this.#get(caller.id)
      if (current.archived)
        throw new ControlFailure('scope_denied', 'Restore Aria before delegating.')
      let currentLead = await this.#get(lead.id)
      this.#checkReachPermission(current, currentLead)
      await this.#checkLaunch(current, proposed, true)
      if (
        currentLead.driverKind !== driverKind ||
        currentLead.modelId !== modelId ||
        (currentLead.effort ?? null) !== selection.resolved
      ) {
        await this.#switchProjectSession(current, currentLead, {
          driverKind,
          modelId,
          effort: selection.resolved,
        })
      }
      if (p.permissionMode !== undefined && p.permissionMode !== currentLead.permissionMode) {
        const updated = await this.host.dispatch({
          type: 'session.update',
          sessionId: lead.id,
          permissionMode: p.permissionMode,
        })
        if (!updated.accepted)
          throw new ControlFailure('turn_refused', updated.reason ?? 'Permission update refused.')
      }
      currentLead = await this.#get(lead.id)
      const prompted = await this.#prompt(current, currentLead, p.text)
      return {
        ...prompted,
        reused: true,
        lead: currentLead,
        agent: { ...leadAgent(currentLead), effortSelection: selection },
      }
    }
    if (p.permissionMode && exceedsPermission(p.permissionMode, caller.permissionMode))
      throw new ControlFailure(
        'scope_denied',
        'Session permissions cannot exceed Aria permissions.',
      )
    const selected = await this.#projectAgent(project, caller, p, providers)
    if (!selected) throw new ControlFailure('model_unavailable', PROJECT_MODEL_REQUIRED)
    const effortSelection = await this.#effort(selected, p.effort, p.text, 'project', providers)
    const agent = { ...selected, effort: effortSelection.resolved, effortSelection }
    const launched = (await this.#launch(
      caller,
      {
        ...agent,
        title: p.title ?? `${project.name} lead`.slice(0, 120),
        projectId: p.projectId,
        prompt: p.text,
        idempotencyKey: p.idempotencyKey,
      },
      signal,
      true,
      agent,
    )) as { child: Session; initialTurn: object }
    return {
      ...launched.initialTurn,
      sessionId: launched.child.id,
      reused: false,
      lead: launched.child,
      agent,
    }
  }

  async #changeProjectLead(caller: Session, p: ControlParams<'projects.lead'>): Promise<unknown> {
    const rows = await this.host.store.listSessions()
    const project = (await this.#helmProjects(caller, rows)).find(
      (entry) => entry.projectId === p.projectId,
    )
    if (!project) throw new ControlFailure('project_not_found', 'Project not found.')
    const leads = await this.#projectLeads(rows, p.projectId)
    const lead = leads[0]
    if (!lead) throw new ControlFailure('session_not_found', 'This project has no live Aria lead.')
    if (p.reset) {
      const current = await this.#get(caller.id)
      if (current.archived)
        throw new ControlFailure('scope_denied', 'Restore Aria before resetting project leads.')
      // Check every lead before deleting any, so a ceiling refusal leaves the project intact.
      for (const session of leads) this.#checkReachPermission(current, session)
      let count = 0
      for (const session of leads) count += (await this.#destroy(current, session)).count
      return {
        projectId: p.projectId,
        sessionId: lead.id,
        sessionIds: leads.map((session) => session.id),
        destroyed: true,
        count,
      }
    }
    const switched = await this.#switchProjectSession(caller, lead, p)
    return { ...switched, projectId: p.projectId, lead: switched.session }
  }

  async #projectLeads(rows: readonly SessionListEntry[], projectId: string): Promise<Session[]> {
    const leads: Session[] = []
    for (const row of rows) {
      if (row.projectId !== projectId || !isHelmProjectLead(row) || row.archived) continue
      const session = (await this.host.store.loadExisting(row.id))?.session
      if (session && !session.archived && isHelmProjectLead(session)) leads.push(session)
    }
    if (leads.length < 2) return leads
    const lastAsked = new Map<string, number>()
    for (const lead of leads) {
      let at = 0
      // Queue timestamps are journaled, while provider activity and title changes
      // also update the listing. Only assignments identify the current lead.
      for await (const chunk of (await this.host.store.openJournal(lead.id)).readByChunk()) {
        for (const entry of chunk) {
          if (entry.kind !== 'value') continue
          const parsed = journalEventSchema.safeParse(entry.value)
          if (!parsed.success) continue
          const event = parsed.data
          if (
            (event.type === 'message.enqueued' && event.origin?.kind === 'session') ||
            (event.type === 'user.message.added' && event.message.origin?.kind === 'session')
          )
            at = Math.max(at, event.at)
        }
      }
      lastAsked.set(lead.id, at)
    }
    return leads.sort(
      (a, b) =>
        (lastAsked.get(b.id) ?? 0) - (lastAsked.get(a.id) ?? 0) || b.createdAt - a.createdAt,
    )
  }

  async #switchProjectSession(
    caller: Session,
    target: Session,
    p: { driverKind?: Session['driverKind']; modelId?: string | null; effort?: string | null },
  ) {
    const self = caller.id === target.id && isHelmSession(target)
    if (!isHelmSession(caller) || (!self && !isHelmProjectSession(target)))
      throw new ControlFailure(
        'scope_denied',
        'Aria can switch only itself or the project sessions it launched.',
      )
    if (caller.archived)
      throw new ControlFailure('scope_denied', 'Restore Aria before switching a session.')
    if (target.archived)
      throw new ControlFailure('scope_denied', 'Restore the target session before switching it.')
    this.#checkReachPermission(caller, target)
    if (self) await this.#checkCurrentAria(caller.id)
    if (!p.driverKind)
      throw new ControlFailure('invalid_request', 'Select a provider for the session.')
    if (!p.modelId)
      throw new ControlFailure(
        'invalid_request',
        'Switching requires --model. Ask the user which model to use.',
      )
    const providers = await this.host.providers()
    const provider = providers.find((entry) => entry.driverKind === p.driverKind && entry.available)
    if (!provider)
      throw new ControlFailure('provider_unavailable', 'Requested provider is unavailable.')
    const selected = p.modelId
    const model = provider.models.find(
      (entry) => entry.id === selected || entry.aliases?.includes(selected),
    )
    if (!model) throw new ControlFailure('model_unavailable', 'Requested model is unavailable.')
    const beforeDiscovery = await this.#get(target.id)
    const effortSelection = await this.#effort(
      { driverKind: p.driverKind, modelId: model.id, effort: beforeDiscovery.effort ?? null },
      p.effort,
      undefined,
      'lead',
      providers,
    )
    const current = await this.#get(caller.id)
    const currentTarget = await this.#get(target.id)
    if (current.archived)
      throw new ControlFailure('scope_denied', 'Restore Aria before switching a session.')
    if (currentTarget.archived)
      throw new ControlFailure('scope_denied', 'Restore the target session before switching it.')
    this.#checkReachPermission(current, currentTarget)
    if (self) await this.#checkCurrentAria(current.id)
    const agent: ResolvedProjectAgent = {
      driverKind: p.driverKind,
      modelId: model.id,
      effort: effortSelection.resolved,
      effortSelection,
      permissionMode: currentTarget.permissionMode,
      source: 'arguments',
    }
    const outcome = await this.host.dispatch({
      type: 'session.provider.switch',
      sessionId: target.id,
      driverKind: agent.driverKind,
      modelId: agent.modelId,
      effort: agent.effort,
    })
    if (!outcome.accepted)
      throw new ControlFailure('turn_refused', outcome.reason ?? 'Switch refused.')
    return {
      sessionId: target.id,
      switched: true,
      ...outcome.switchTiming,
      session: await this.#get(target.id),
      agent,
    }
  }

  async #checkCurrentAria(sessionId: string): Promise<void> {
    // A cold store may have loaded only the old caller. Refresh persisted topic
    // metadata before consulting the same current-Aria identity used for routing.
    await this.host.store.listSessions()
    if ((await this.host.store.currentHelmSession()) !== sessionId)
      throw new ControlFailure('scope_denied', 'Aria can switch only its current chat.')
  }

  async #checkLaunch(
    caller: Session,
    session: Pick<Session, 'driverKind' | 'modelId' | 'permissionMode'> &
      Partial<Pick<Session, 'id' | 'projectId'>>,
    existing = false,
    providers?: readonly ProjectAgentProvider[],
  ): Promise<void> {
    const policy = this.host.policy()
    checkDelegation(policy, 0, 0)
    const usable = leadUsable(session, providers ?? (await this.host.providers()))
    if (usable !== true)
      throw new ControlFailure(
        usable,
        usable === 'provider_unavailable'
          ? 'Requested provider is unavailable.'
          : 'Requested model is unavailable.',
      )
    if (exceedsPermission(session.permissionMode, caller.permissionMode))
      throw new ControlFailure(
        'scope_denied',
        existing
          ? 'This session has higher permissions than Aria. Ask the user to send the instruction or raise Aria permissions.'
          : 'Session permissions cannot exceed Aria permissions.',
      )
    const working = await this.#workingProjectSessions(session.id)
    if (session.projectId) this.#refuseConcurrentCode(session.projectId, working)
    const model = session.id ? await this.host.store.load(session.id) : null
    if (
      (!model || (model.activeTurnId === null && model.queuedMessages.length === 0)) &&
      working.filter(isHelmProjectSession).length >= policy.maxConcurrentChildren
    )
      throw new ControlFailure(
        'delegation_limit',
        'Maximum concurrent project sessions reached. Wait for a session to finish.',
      )
  }

  /** Only live turns occupy a project; stale journals and long human waits do not. */
  async #workingProjectSessions(excludeId?: string): Promise<Session[]> {
    const working: Session[] = []
    const rows = await this.host.store.listSessions()
    const now = Date.now()
    const excluded = new Set(excludeId ? [excludeId, ...descendantIds(rows, excludeId)] : [])
    for (const row of rows) {
      if (excluded.has(row.id) || row.projectId === HELM_PROJECT_ID) continue
      const model = await this.host.store.load(row.id)
      const session = model.session
      if (!session) continue
      if (!isHelmProjectSession(session)) {
        if (
          session.workspace?.kind !== 'managed-worktree' &&
          (await this.#projectTurnRunning(session.id, model, now))
        )
          working.push(session)
        continue
      }
      let live = await this.#projectTurnRunning(session.id, model, now)
      if (!live)
        for (const id of descendantIds(rows, row.id)) {
          const child = await this.host.store.load(id)
          if (await this.#projectTurnRunning(id, child, now)) {
            live = true
            break
          }
        }
      if (live) working.push(session)
    }
    return working
  }

  async #projectTurnRunning(id: string, model: SessionReadModel, now: number): Promise<boolean> {
    if (!model.activeTurnId || this.host.isRunning?.(id) !== true) return false
    if (model.pendingApprovals.length === 0 && model.pendingInputs.length === 0) return true
    const approvals = new Set(model.pendingApprovals.map((approval) => approval.approvalId))
    const inputs = new Set(model.pendingInputs.map((input) => input.inputId))
    let inTurn = false
    const requestedAt = new Map<string, number>()
    // Provider activity can continue while a tool waits for a human. Use the
    // pending request's journal time, rather than the last observed activity.
    for await (const chunk of (await this.host.store.openJournal(id)).readByChunk()) {
      for (const entry of chunk) {
        if (entry.kind !== 'value') continue
        const parsed = journalEventSchema.safeParse(entry.value)
        if (!parsed.success) continue
        const event = parsed.data
        if (event.type === 'turn.started') inTurn = event.turnId === model.activeTurnId
        if (!inTurn) continue
        if (event.type === 'approval.requested' && approvals.has(event.approvalId)) {
          const key = `approval:${event.approvalId}`
          if (!requestedAt.has(key)) requestedAt.set(key, event.at)
        } else if (event.type === 'input.requested' && inputs.has(event.inputId)) {
          const key = `input:${event.inputId}`
          if (!requestedAt.has(key)) requestedAt.set(key, event.at)
        } else if (event.type === 'approval.responded')
          requestedAt.delete(`approval:${event.approvalId}`)
        else if (event.type === 'input.responded') requestedAt.delete(`input:${event.inputId}`)
      }
    }
    const waitingSince = Math.min(...requestedAt.values())
    return Number.isFinite(waitingSince) && now - waitingSince < PROJECT_HUMAN_WAIT_MS
  }

  async #checkProjectCode(projectId: string, excludeId?: string): Promise<void> {
    const working = await this.#workingProjectSessions(excludeId)
    this.#refuseConcurrentCode(projectId, working)
  }

  #refuseConcurrentCode(projectId: string, working: readonly Session[]): void {
    const active = working.find((session) => session.projectId === projectId)
    if (active)
      throw new ControlFailure(
        'delegation_limit',
        `Project already has a working session: "${active.title}" (${active.id}). Send follow-ups with \`ari session prompt ${active.id} "<task>"\` or wait for it to finish. Do research inside that session or after it.`,
      )
  }

  #messageId(sender: string, key: string): string {
    return `inbox_${createHash('sha256').update(`${sender}:${key}`).digest('hex').slice(0, 32)}`
  }

  async #messageTarget(caller: Session, id: string): Promise<Session> {
    await this.#lineage(caller)
    // Whoever asked for the running turn hears its questions. For a session
    // Aria started, Aria also stands in for the parent it does not have.
    const model = await this.host.store.load(caller.id)
    const asker = model.activeTurnId ? turnRequester(model, model.activeTurnId) : null
    const launcher =
      !caller.parentSessionId && caller.createdBy?.kind === 'session'
        ? caller.createdBy.sessionId
        : null
    const aria =
      model.activeTurnId || model.lastTurn
        ? await helmReportRecipient(
            this.host.store,
            model,
            model.activeTurnId ?? model.lastTurn!.turnId,
          )
        : null
    const target = await this.#get(
      id === 'self'
        ? caller.id
        : id === 'parent'
          ? (aria ?? asker ?? caller.parentSessionId ?? launcher ?? '')
          : id,
    )
    if (isHelmSession(caller) && !isHelmSession(target)) return target
    if (
      (target.id === launcher || target.id === asker || target.id === aria) &&
      isHelmSession(target)
    )
      return target
    if (target.projectId !== caller.projectId)
      throw new ControlFailure('scope_denied', 'Cross-project coordination is denied.')
    const directParent = target.id === caller.parentSessionId
    const sibling = Boolean(
      caller.parentSessionId && target.parentSessionId === caller.parentSessionId,
    )
    const descendant = (await this.#lineage(target)).some((entry) => entry.id === caller.id)
    if (!directParent && !sibling && !descendant)
      throw new ControlFailure(
        'scope_denied',
        'Coordination is limited to this subtree, direct parent and siblings.',
      )
    return target
  }

  async #coordinationState(message: CoordinationMessage): Promise<CoordinationMessage> {
    if (message.status !== 'delivering' || this.#activeDeliveries.has(message.messageId))
      return message
    const recipient = await this.host.store.loadExisting(message.recipientSessionId)
    if (
      recipient?.activeTurnId === message.turnId &&
      this.host.isRunning?.(message.recipientSessionId) !== false &&
      recipient.messages.some(
        (entry) =>
          entry.turnId === message.turnId &&
          entry.origin?.kind === 'coordination' &&
          entry.origin.messageIds.includes(message.messageId),
      )
    )
      return message
    const uncertain = { ...message, status: 'uncertain' as const }
    await this.host.record(message.recipientSessionId, {
      type: 'coordination.updated',
      message: uncertain,
    })
    return uncertain
  }

  async #coordinate(
    caller: Session,
    target: Session,
    p: ControlParams<'session.message'>,
    request?: NonNullable<CoordinationMessage['request']>,
  ): Promise<CoordinationMessage> {
    if (target.archived)
      throw new ControlFailure('scope_denied', 'Restore the recipient before messaging it.')
    if (!this.host.policy().enabled)
      throw new ControlFailure('delegation_disabled', 'Delegation is disabled.')
    const messageId = this.#messageId(caller.id, p.idempotencyKey)
    const inbox = (await this.host.store.load(target.id)).inbox ?? {}
    const previous = inbox[messageId]
    if (previous) {
      if ((!request && previous.text !== p.text) || previous.senderSessionId !== caller.id)
        throw new ControlFailure(
          'invalid_request',
          'Message identity was already used with different input.',
        )
      return this.#coordinationState(previous)
    }
    const rate = this.#rates.get(caller.id)
    const bucket = rate && Date.now() - rate.at < 60_000 ? rate : { at: Date.now(), count: 0 }
    if (!request && ++bucket.count > 60)
      throw new ControlFailure('delegation_limit', 'Agent message rate limit reached.')
    this.#rates.set(caller.id, bucket)
    if (
      Object.values(inbox).filter(
        (entry) => entry.status !== 'consumed' && entry.request?.resolvedAt == null,
      ).length >= 100
    )
      throw new ControlFailure('delegation_limit', 'Recipient coordination inbox is full.')
    const message: CoordinationMessage = {
      messageId,
      senderSessionId: caller.id,
      recipientSessionId: target.id,
      text: p.text,
      createdAt: Date.now(),
      status: 'pending',
      turnId: null,
      consumedAt: null,
      ...(request ? { request } : {}),
    }
    await this.host.record(target.id, { type: 'coordination.updated', message })
    return this.#deliverInbox(message)
  }

  async #deliverInbox(accepted: CoordinationMessage): Promise<CoordinationMessage> {
    const messageId = accepted.messageId
    const targetId = accepted.recipientSessionId
    if (this.#activeDeliveries.has(messageId))
      return this.#coordinationState(
        (await this.host.store.load(targetId)).inbox?.[messageId] ?? accepted,
      )
    this.#activeDeliveries.add(messageId)
    try {
      let message = (await this.host.store.load(targetId)).inbox?.[messageId] ?? accepted
      if (message.status !== 'pending') return this.#coordinationState(message)
      // Pure inbox delivery works while either agent is blocked in a cooperative wait.
      // Only an actually live transport may bypass it; ACP follow-up steering is not live delivery.
      if (this.host.canDeliverCoordination?.(targetId) && this.host.deliverCoordination) {
        message = {
          ...message,
          status: 'delivering',
          turnId: (await this.host.store.load(targetId)).activeTurnId,
        }
        try {
          await this.host.record(targetId, { type: 'coordination.updated', message })
          const delivered = await this.host.deliverCoordination(message)
          message = { ...message, status: delivered ? 'delivered' : 'pending' }
        } catch {
          message = { ...message, status: 'uncertain' }
        }
        await this.host.record(targetId, { type: 'coordination.updated', message })
      }
      return (await this.host.store.load(targetId)).inbox?.[messageId] ?? message
    } finally {
      this.#activeDeliveries.delete(messageId)
    }
  }

  async #prompt(caller: Session, target: Session, text: string): Promise<SessionPromptReceipt> {
    if (isHelmSession(caller) && caller.archived)
      throw new ControlFailure('scope_denied', 'Restore Aria before prompting a session.')
    if (target.archived)
      throw new ControlFailure('scope_denied', 'Restore the target session before prompting it.')
    if (!this.host.policy().enabled)
      throw new ControlFailure('delegation_disabled', 'Delegation is disabled.')
    const rate = this.#rates.get(caller.id)
    const bucket = rate && Date.now() - rate.at < 60_000 ? rate : { at: Date.now(), count: 0 }
    if (++bucket.count > 60)
      throw new ControlFailure('delegation_limit', 'Agent message rate limit reached.')
    this.#rates.set(caller.id, bucket)
    if (
      isHelmSession(caller) &&
      !target.parentSessionId &&
      target.workspace?.kind !== 'managed-worktree'
    )
      await this.#checkProjectCode(target.projectId, target.id)
    const state = await this.host.store.load(target.id)
    if (state.queuedMessages.length >= 32)
      throw new ControlFailure('delegation_limit', 'Target message queue is full.')
    // Even an idle child takes the held queue: the root's gate decides when a
    // slot is free, and the same path survives a restart.
    const outcome = await this.host.dispatch(
      { type: 'message.enqueue', sessionId: target.id, text, attachments: [], hold: true },
      { kind: 'session', sessionId: caller.id },
    )
    if (!outcome.accepted)
      throw new ControlFailure('invalid_request', outcome.reason ?? 'Input rejected.')
    const observedActiveTurnId = (await this.host.store.load(target.id)).activeTurnId
    return {
      sessionId: target.id,
      turnId: observedActiveTurnId,
      observedActiveTurnId,
      queued: true,
      execution: 'future_turn',
    }
  }

  async #read(
    caller: Session,
    target: Session,
    p: ControlParams<'session.read'>,
  ): Promise<unknown> {
    const state = await this.host.store.load(target.id)
    // FIFO assignments get the same item/text budget as transcript rows. A
    // queue must not quietly double a bounded read's size or claim a turn ID.
    let remaining = p.maxChars
    const queuedMessages = state.queuedMessages.slice(0, p.tailMessages).map((message) => {
      const text = message.text.slice(0, remaining)
      remaining -= text.length
      return {
        text,
        origin: message.origin,
        held: message.held === true,
        truncated: text.length < message.text.length,
      }
    })
    const queue: SessionReadQueue = {
      queuedMessages,
      queuedMessageCount: state.queuedMessages.length,
      queuedMessagesTruncated:
        queuedMessages.length < state.queuedMessages.length ||
        queuedMessages.some((message) => message.truncated),
    }
    const turns = p.tailTurns
      ? new Set(
          [...new Set(state.messages.map((m) => m.turnId).filter(Boolean))].slice(-p.tailTurns),
        )
      : null
    const messageLimit = p.tailMessages - queuedMessages.length
    const selected =
      messageLimit > 0
        ? state.messages.filter((m) => !turns || turns.has(m.turnId)).slice(-messageLimit)
        : []
    const messages = [...selected]
      .reverse()
      .map((message) => {
        const text = messageText(message, p.includeToolSummaries)
        const clipped = text.slice(0, remaining)
        remaining -= clipped.length
        return {
          id: message.id,
          role: message.role,
          origin: message.origin,
          turnId: message.turnId,
          text: clipped,
        }
      })
      .reverse()
    const report = finalAssistantText(state, state.lastTurn?.turnId)
    // Reading a settled child's whole report is as good as being told about it.
    const reportsHere =
      target.parentSessionId === caller.id ||
      (isHelmSession(caller) &&
        (await this.host.store.load(caller.id)).childCompletions?.[target.id] !== undefined)
    if (reportsHere && state.activeTurnId === null && state.lastTurn && !report.truncated)
      await this.#acknowledge(caller.id, target.id, state.lastTurn.turnId, 'read')
    return {
      session: target,
      activeTurnId: state.activeTurnId,
      latestTurn: state.lastTurn ?? null,
      lastSeq: state.lastSeq,
      pendingInputs: state.pendingInputs,
      pendingApprovals: state.pendingApprovals,
      questionOwnerSessionId: await questionOwnerSessionId(this.host.store, state),
      messages,
      ...queue,
      renderedText: messages
        .map((message) => `${message.role}: ${message.text}`)
        .join('\n\n')
        .slice(0, p.maxChars),
      latestAssistantText: report.text,
      truncated:
        remaining === 0 || selected.length < state.messages.length || queue.queuedMessagesTruncated,
    }
  }

  async #wait(
    caller: Session,
    p: ControlParams<'session.wait'>,
    signal?: AbortSignal,
  ): Promise<WaitOutcome[]> {
    const targets = await Promise.all(
      p.targetSessionIds.map((id) => this.#messageTarget(caller, id)),
    )
    const controller = new AbortController()
    // Aborted only in `any` mode, once one target has an outcome.
    const race = new AbortController()
    const abort = (): void => controller.abort()
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) controller.abort()
    let wake!: (outcomes: WaitOutcome[]) => void
    const incoming = new Promise<WaitOutcome[]>((resolve) => {
      wake = resolve
    })
    const inspectIncoming = async () => {
      const model = await this.host.store.load(caller.id)
      const messages = Object.values(model.inbox ?? {}).filter(
        (entry) => entry.status !== 'consumed',
      )
      if (messages.length) {
        wake([{ status: 'coordination', sessionId: caller.id, messages }])
        race.abort()
        return
      }
      for (const target of targets) {
        const state = await this.host.store.load(target.id)
        if (
          (target.parentSessionId === caller.id || isHelmSession(caller)) &&
          (await questionOwnerSessionId(this.host.store, state)) === caller.id &&
          state.pendingInputs.length
        ) {
          wake([{ status: 'question', sessionId: target.id, questions: state.pendingInputs }])
          race.abort()
          return
        }
      }
    }
    const unsubscribeIncoming = this.host.subscribe((event) => {
      if (
        (event.sessionId === caller.id && event.type === 'coordination.updated') ||
        (event.type === 'input.requested' &&
          targets.some((target) => target.id === event.sessionId))
      )
        void inspectIncoming().catch(() => undefined)
    })
    // Aria hears back from every session whose turns it starts.
    const own = targets.filter(
      (target) => target.parentSessionId === caller.id || isHelmSession(caller),
    )
    for (const target of own) this.#trackWait(caller.id, target.id, 1)
    try {
      await inspectIncoming()
      const waiting = Promise.all(
        targets.map(async (target): Promise<WaitOutcome> => {
          try {
            const outcome = await waitForTurn(
              {
                load: (id) => this.host.store.load(id),
                subscribe: (listener) => this.host.subscribe(listener),
                onGone: (id, listener) => this.#watchGone(id, listener),
              },
              target.id,
              p.timeoutMs,
              AbortSignal.any([controller.signal, race.signal]),
            )
            if (p.mode === 'any') race.abort()
            return outcome
          } catch (error) {
            if (!(error instanceof ControlFailure)) throw error
            if (error.code === 'wait_timeout') return { status: 'timeout', sessionId: target.id }
            if (error.code === 'session_not_found')
              return { status: 'destroyed', sessionId: target.id }
            if (error.code === 'wait_cancelled' && !controller.signal.aborted)
              return { status: 'pending', sessionId: target.id }
            throw error
          }
        }),
      )
      const outcomes = await Promise.race([waiting, incoming])
      // A caller that went away never received these, so they stay pending.
      if (!controller.signal.aborted)
        for (const outcome of outcomes) {
          const seen = outcome.status === 'settled' || outcome.status === 'idle'
          if (seen && outcome.turnId && own.some((target) => target.id === outcome.sessionId))
            await this.#acknowledge(caller.id, outcome.sessionId, outcome.turnId, 'wait')
        }
      return outcomes
    } finally {
      unsubscribeIncoming()
      race.abort()
      signal?.removeEventListener('abort', abort)
      for (const target of own) this.#trackWait(caller.id, target.id, -1)
      this.host.waitEnded?.(caller.id)
    }
  }

  /** One row per delegated child, for the agent that owns them. Acknowledges what it shows. */
  async #status(caller: Session, p: ControlParams<'session.status'>): Promise<unknown> {
    const parent = await this.#reach(caller, p.targetSessionId)
    const tasks = await this.tasks(parent.id, p.recursive)
    if (parent.id === caller.id)
      for (const task of tasks)
        if (
          task.delivered !== null &&
          task.workState === 'result_available' &&
          task.latestTurn &&
          !task.reportTruncated
        )
          await this.#acknowledge(caller.id, task.sessionId, task.latestTurn.turnId, 'read')
    const count = (state: string): number => tasks.filter((task) => task.workState === state).length
    return {
      sessionId: parent.id,
      tasks,
      summary: {
        total: tasks.length,
        working: count('working'),
        blockedOnUser: count('blocked_on_user'),
        blockedOnParent: count('blocked_on_parent'),
        waitingForChildren: count('waiting_for_children'),
        resultAvailable: count('result_available'),
        notStarted: count('not_started'),
        queued: count('queued'),
      },
    }
  }

  /**
   * Where each delegated child of `parentId` stands and what it last reported.
   * A plain read: the desktop UI shows these without marking anything as seen
   * by the parent agent.
   */
  async tasks(parentId: string, recursive = false): Promise<ChildTask[]> {
    const rows = await this.host.store.listSessions()
    const parentModel = await this.host.store.loadExisting(parentId)
    if (!parentModel?.session) return []
    // Sessions Aria started are roots in their own projects, not children, but
    // they are still the work this session handed out.
    const launched = new Set(
      (parentModel.childEvents ?? []).flatMap((event) =>
        event.type === 'child.session.spawned' ? [event.childSessionId] : [],
      ),
    )
    const roots: string[] = []
    const aria = isHelmSession(parentModel.session)
    for (const row of rows) {
      if (row.archived || row.parentSessionId) continue
      if (!launched.has(row.id) && !(aria && isHelmProjectSession(row))) continue
      const model = await this.host.store.loadExisting(row.id)
      if (!model?.session) continue
      if (
        aria &&
        isHelmProjectSession(model.session) &&
        !launched.has(row.id) &&
        !(
          model.session.createdBy?.kind === 'session' &&
          model.session.createdBy.sessionId === parentId
        ) &&
        (await helmTaskRecipient(this.host.store, model, rows)) !== parentId
      )
        continue
      if (launched.has(row.id) || (aria && isHelmProjectSession(model.session))) roots.push(row.id)
    }
    const below = [
      ...descendantIds(rows, parentId),
      ...roots.flatMap((id) => descendantIds(rows, id)),
    ]
    const ids = recursive
      ? [...new Set([...below.reverse(), ...roots])]
      : [...rows.filter((row) => row.parentSessionId === parentId).map((row) => row.id), ...roots]
    // Read from the journal alone. A provider that is still shutting down
    // after its turn settled is not work, and saying so would keep a finished
    // child's card on "working".
    const live = new Set<string>()
    for (const id of [...below, ...roots]) {
      const model = await this.host.store.loadExisting(id)
      if (model?.activeTurnId || model?.queuedMessages.length) live.add(id)
    }
    const completions = parentModel.childCompletions ?? {}
    const tasks: ChildTask[] = []
    for (const id of ids) {
      const model = await this.host.store.loadExisting(id)
      if (!model) continue
      const session = model.session
      if (!session) continue
      const questionOwner = await questionOwnerSessionId(this.host.store, model)
      const workState = childWorkState(
        model,
        descendantIds(rows, id).filter((nested) => live.has(nested)).length,
        questionOwner !== null,
      )
      const settled = workState === 'result_available' || workState === 'waiting_for_children'
      const report =
        settled && model.lastTurn ? finalAssistantText(model, model.lastTurn.turnId, 2_000) : null
      const direct = session.parentSessionId === parentId || roots.includes(id)
      tasks.push({
        sessionId: id,
        parentSessionId: session.parentSessionId ?? null,
        title: session.title,
        role: session.role ?? null,
        driverKind: session.driverKind,
        modelId: session.modelId,
        workState,
        lastSeq: model.lastSeq,
        questionOwnerSessionId: questionOwner,
        pendingInputs: model.pendingInputs,
        pendingApprovals: model.pendingApprovals,
        blockedOn:
          workState !== 'blocked_on_user' && workState !== 'blocked_on_parent'
            ? null
            : model.pendingApprovals.length > 0
              ? 'approval'
              : 'input',
        queuedMessages: model.queuedMessages.length,
        latestTurn: model.lastTurn ?? null,
        report: report?.text ?? null,
        reportTruncated: report?.truncated ?? false,
        delivered: direct ? (completions[id]?.acknowledged ?? false) : null,
        usage: model.usage,
        workspaceKind: session.workspace?.kind ?? 'project',
        branch: session.workspace?.kind === 'managed-worktree' ? session.workspace.branch : null,
      })
    }
    return tasks
  }
}

function leadUsable(
  lead: Pick<Session, 'driverKind' | 'modelId'>,
  providers: readonly ProjectAgentProvider[],
): true | 'provider_unavailable' | 'model_unavailable' {
  const provider = providers.find(
    (provider) => provider.available && provider.driverKind === lead.driverKind,
  )
  if (!provider) return 'provider_unavailable'
  if (
    lead.modelId &&
    !provider.models.some(
      (model) => model.id === lead.modelId || model.aliases?.includes(lead.modelId!),
    )
  )
    return 'model_unavailable'
  return true
}

/** Streamed text deltas are separate parts; rejoin each run before separating runs. */
function messageText(message: Message, includeToolSummaries: boolean): string {
  const chunks: string[] = []
  let run = ''
  const flush = (): void => {
    if (run.length > 0) chunks.push(run)
    run = ''
  }
  for (const part of message.parts) {
    if (part.type === 'text') {
      run += part.text
      continue
    }
    flush()
    if (!includeToolSummaries) continue
    if (part.type === 'tool-call') chunks.push(`[Tool: ${part.name}]`)
    else if (part.type === 'tool-result') chunks.push(`[Result: ${part.resultJson.slice(0, 500)}]`)
  }
  flush()
  return chunks.join('\n')
}

export function descendantIds(
  sessions: readonly { id: string; parentSessionId?: string | null }[],
  rootId: string,
): string[] {
  const children = new Map<string, string[]>()
  for (const session of sessions) {
    const parent = session.parentSessionId
    if (!parent) continue
    const nested = children.get(parent) ?? []
    nested.push(session.id)
    children.set(parent, nested)
  }
  const ids: string[] = []
  const visit = (id: string): void => {
    for (const child of children.get(id) ?? []) {
      visit(child)
      ids.push(child)
    }
  }
  visit(rootId)
  return ids
}

function leadAgent(lead: Session): ResolvedProjectAgent {
  return {
    driverKind: lead.driverKind,
    modelId: lead.modelId,
    effort: lead.effort ?? null,
    permissionMode: lead.permissionMode,
    source: 'lead',
  }
}
