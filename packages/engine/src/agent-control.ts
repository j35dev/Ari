import type { CoordinationMessage } from '@ari/contracts/coordination'
import { newTypedId } from '@ari/shared/ids'
import { createHash } from 'node:crypto'
import type { OperationReceipt } from '@ari/contracts/orchestration'
import { createLogger } from '@ari/shared/logger'
import {
  AGENT_CONTROL_VERSION,
  ControlFailure,
  controlParams,
  type ChildTask,
  type ControlMethod,
  type ControlParams,
  type ControlResult,
  type DelegationSettings,
  type HelmProject,
  type ScheduledRoutine,
} from '@ari/contracts/agent-control'
import { HELM_PROJECT_ID, isHelmSession } from '@ari/contracts/helm'
import type { Session, SessionWorkspace } from '@ari/contracts/session'
import type { Message } from '@ari/contracts/message'
import type { Command } from '@ari/contracts/commands'
import type { JournalEvent } from '@ari/contracts/events'
import type { SessionStore } from './session-store'
import type { UnstampedEvent } from './projection'
import { checkDelegation, sessionLineage } from './control-policy'
import { waitForTurn, type WaitOutcome } from './control-wait'
import { childWorkState, finalAssistantText, pendingCompletions } from './delegation-state'
import type { TreeSpend } from './tree-budget'
import { findSessions, turnRequester, type HelmView } from './helm'
import {
  resolveProjectAgent,
  type ProjectAgentDefaults,
  type ProjectAgentProvider,
} from './projects'
import type { ProjectAgent, ResolvedProjectAgent } from '@ari/contracts/project'

const log = createLogger('engine:control')

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
  ): Promise<{ accepted: boolean; reason?: string }>
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
  projects?(): Promise<HelmProject[]>
  projectAgentDefaults?(): ProjectAgentDefaults
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
    const { session } = await this.host.store.load(id)
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
   * it may look at, prompt, message, wait on and stop them. Deleting,
   * integrating and answering approvals stay with the subtree or the user.
   */
  async #reach(caller: Session, id: string, ancestors = false): Promise<Session> {
    if (!isHelmSession(caller) || id === 'self' || id === caller.id || id === 'parent')
      return this.#target(caller, id, ancestors)
    const target = await this.#get(id)
    if (isHelmSession(target)) return this.#target(caller, id, ancestors)
    return target
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

  async #helmProjects(caller: Session): Promise<HelmProject[]> {
    if (!isHelmSession(caller))
      throw new ControlFailure('scope_denied', 'Only Aria works across projects.')
    if (!this.host.projects)
      throw new ControlFailure('unsupported', 'Projects are unavailable in this runtime.')
    return (await this.host.projects()).filter((project) => project.projectId !== HELM_PROJECT_ID)
  }

  async #projectAgent(
    project: HelmProject,
    args?: Partial<ProjectAgent>,
  ): Promise<ResolvedProjectAgent | null> {
    const [rows, providers] = await Promise.all([
      this.host.store.listSessions(),
      this.host.providers(),
    ])
    const sessions: Session[] = []
    for (const row of rows) {
      if (row.projectId !== project.projectId) continue
      const session = (await this.host.store.load(row.id)).session
      if (session) sessions.push(session)
    }
    return resolveProjectAgent({
      project,
      ...(args === undefined ? {} : { arguments: args }),
      sessions,
      providers,
      app: this.host.projectAgentDefaults?.() ?? { driverKind: null, permissionMode: 'ask' },
    })
  }

  /** Shared with the live snapshot so it names the same agent as a launch. */
  async projects(caller: Session): Promise<HelmProject[]> {
    const projects = await this.#helmProjects(caller)
    return Promise.all(
      projects.map(async (project) => ({
        ...project,
        agent: await this.#projectAgent(project),
      })),
    )
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
        throw new ControlFailure('invalid_request', 'Invalid command parameters.')
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
        return { ok: true, result: await previous.result }
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
        return { ok: true, result: await raced.result }
      }
      const result = this.#chain(caller, () =>
        this.#durable(caller.id, receiptKey, method, fingerprint, params, run),
      )
      this.#receipts.set(receiptKey, { fingerprint, result })
      try {
        return { ok: true, result: await result }
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
    // Aria topics share project leads and one concurrency cap.
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
          modelId: p.modelId ?? null,
          effort: p.effort ?? null,
          permissionMode: p.permissionMode ?? 'ask',
        }
        if (!(await this.host.setProjectDefault(project.projectId, agent)))
          throw new ControlFailure('project_not_found', 'Project not found.')
        return {
          projectId: project.projectId,
          defaultAgent: agent,
          agent: await this.#projectAgent({ ...project, defaultAgent: agent }),
        }
      }
      case 'projects.ask':
        return this.#askProject(caller, raw as ControlParams<'projects.ask'>, signal)
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
      case 'session.prompt': {
        const p = raw as ControlParams<'session.prompt'>
        return this.#prompt(caller, await this.#reach(caller, p.targetSessionId), p.text)
      }
      case 'session.message': {
        const p = raw as ControlParams<'session.message'>
        return this.#coordinate(caller, await this.#messageTarget(caller, p.targetSessionId), p)
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
        const child = await this.#reach(caller, p.targetSessionId)
        // Aria answers questions on turns it started; the check below holds it to those.
        if (child.parentSessionId !== caller.id && !isHelmSession(caller))
          throw new ControlFailure(
            'scope_denied',
            'Only the direct parent can answer a child question.',
          )
        const model = await this.host.store.load(child.id)
        const asked = model.messages.find(
          (message) => message.role === 'user' && message.turnId === model.activeTurnId,
        )
        if (asked?.origin?.kind !== 'session' || asked.origin.sessionId !== caller.id)
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
        const target = await this.#target(
          caller,
          (raw as ControlParams<'session.destroy'>).targetSessionId,
        )
        if (target.id === caller.id)
          throw new ControlFailure('scope_denied', 'A session cannot destroy itself.')
        const rows = await this.host.store.listSessions()
        const ids = [...descendantIds(rows, target.id), target.id]
        for (const id of ids) {
          const state = await this.host.store.load(id).catch(() => null)
          if (state?.activeTurnId || this.host.isRunning?.(id)) {
            await this.host.dispatch({ type: 'turn.interrupt', sessionId: id })
            await this.host.quiesce?.(id)
          }
          await this.host.revoke?.(id)
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
    const provider = (await this.host.providers()).find(
      (v) => v.driverKind === p.driverKind && v.available,
    )
    if (!provider)
      throw new ControlFailure('provider_unavailable', 'Requested provider is unavailable.')
    if (p.modelId && !provider.models.some((m) => m.id === p.modelId))
      throw new ControlFailure('model_unavailable', 'Requested model is unavailable.')
    const modes = ['ask', 'allow-edits', 'full']
    const permissionMode = p.permissionMode ?? caller.permissionMode
    if (modes.indexOf(permissionMode) > modes.indexOf(caller.permissionMode))
      throw new ControlFailure(
        'scope_denied',
        'Child permissions cannot exceed parent permissions.',
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
    if (
      currentCaller.archived ||
      modes.indexOf(permissionMode) > modes.indexOf(currentCaller.permissionMode)
    )
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
        modelId: p.modelId ?? null,
        effort: p.effort ?? null,
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
        error.code === 'request_cancelled'
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
    const modes = ['ask', 'allow-edits', 'full']
    const permissionMode = p.permissionMode ?? caller.permissionMode
    const agent = { driverKind: p.driverKind, modelId: p.modelId ?? null, permissionMode }
    await this.#checkLaunch(caller, agent)
    await this.#approveDelegation(caller, policy, signal)
    const current = await this.#get(caller.id)
    if (current.archived || modes.indexOf(permissionMode) > modes.indexOf(current.permissionMode))
      throw new ControlFailure(
        'scope_denied',
        'Aria permissions changed while delegation was pending.',
      )
    checkDelegation(this.host.policy(), 0, 0)
    await this.#checkLaunch(current, agent)
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
      driverKind: p.driverKind,
      modelId: p.modelId ?? null,
      effort: p.effort ?? null,
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

  /** Aria's mutation chain keeps fresh chats on one live project lead. */
  async #askProject(
    caller: Session,
    p: ControlParams<'projects.ask'>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const project = (await this.#helmProjects(caller)).find(
      (entry) => entry.projectId === p.projectId,
    )
    if (!project) throw new ControlFailure('project_not_found', 'Project not found.')
    if (!project.available)
      throw new ControlFailure('project_unavailable', 'That project folder is missing.')
    if (caller.archived) throw new ControlFailure('scope_denied', 'Restore Aria before delegating.')
    for (const row of await this.host.store.listSessions()) {
      if (row.projectId !== p.projectId || row.archived || row.parentSessionId) continue
      const lead = (await this.host.store.load(row.id)).session
      if (!lead?.lead || lead.createdBy?.kind !== 'session') continue
      // Only Aria creates top-level sessions with a session creator. Its chat
      // may have been deleted; the project's lead keeps its context.
      await this.#checkLaunch(caller, lead)
      await this.#approveDelegation(caller, this.host.policy(), signal)
      const current = await this.#get(caller.id)
      if (current.archived)
        throw new ControlFailure('scope_denied', 'Restore Aria before delegating.')
      const currentLead = await this.#get(lead.id)
      await this.#checkLaunch(current, currentLead)
      return this.#prompt(current, currentLead, p.text)
    }
    const agent = await this.#projectAgent(project, p)
    if (!agent)
      throw new ControlFailure(
        'model_unavailable',
        'No agent is configured for this project. Ask the user which agent to use, then run `ari project default <projectId> --agent <provider> --model <model>`.',
      )
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
    )) as { child: Session; initialTurn: object }
    return { ...launched.initialTurn, sessionId: launched.child.id, lead: launched.child }
  }

  async #checkLaunch(
    caller: Session,
    session: Pick<Session, 'driverKind' | 'modelId' | 'permissionMode'> & { id?: string },
  ): Promise<void> {
    const policy = this.host.policy()
    checkDelegation(policy, 0, 0)
    const provider = (await this.host.providers()).find(
      (p) => p.available && p.driverKind === session.driverKind,
    )
    if (!provider)
      throw new ControlFailure('provider_unavailable', 'Requested provider is unavailable.')
    if (
      session.modelId &&
      !provider.models.some(
        (m) => m.id === session.modelId || m.aliases?.includes(session.modelId!),
      )
    )
      throw new ControlFailure('model_unavailable', 'Requested model is unavailable.')
    const modes = ['ask', 'allow-edits', 'full']
    if (modes.indexOf(session.permissionMode) > modes.indexOf(caller.permissionMode))
      throw new ControlFailure(
        'scope_denied',
        'Session permissions cannot exceed Aria permissions.',
      )
    const model = session.id ? await this.host.store.load(session.id) : null
    if (
      (!model || (model.activeTurnId === null && model.queuedMessages.length === 0)) &&
      (await this.#launchedWorking(caller.id, session.id)) >= policy.maxConcurrentChildren
    )
      throw new ControlFailure(
        'delegation_limit',
        'Maximum concurrent project sessions reached. Wait for a lead to finish.',
      )
  }

  /** Sessions Aria started that are still working or have work queued. */
  async #launchedWorking(helmId: string, excludeId?: string): Promise<number> {
    let working = 0
    const rows = await this.host.store.listSessions()
    for (const row of rows) {
      if (
        row.id === excludeId ||
        row.parentSessionId ||
        row.archived ||
        row.projectId === HELM_PROJECT_ID
      )
        continue
      const model = await this.host.store.load(row.id)
      const creator = model.session?.createdBy
      if (creator?.kind !== 'session') continue
      if (creator.sessionId !== helmId && model.session?.lead !== true) continue
      let live =
        model.activeTurnId !== null ||
        model.queuedMessages.length > 0 ||
        pendingCompletions(model).some((entry) => entry.stopReason !== 'interrupted')
      if (!live)
        for (const id of descendantIds(rows, row.id)) {
          const child = await this.host.store.load(id)
          if (
            !child.session?.archived &&
            (child.activeTurnId !== null || child.queuedMessages.length > 0)
          ) {
            live = true
            break
          }
        }
      if (live) working++
    }
    return working
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
    const target = await this.#get(
      id === 'self'
        ? caller.id
        : id === 'parent'
          ? (asker ?? caller.parentSessionId ?? launcher ?? '')
          : id,
    )
    if (isHelmSession(caller) && !isHelmSession(target)) return target
    if ((target.id === launcher || target.id === asker) && isHelmSession(target)) return target
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
  ): Promise<CoordinationMessage> {
    if (target.archived)
      throw new ControlFailure('scope_denied', 'Restore the recipient before messaging it.')
    if (!this.host.policy().enabled)
      throw new ControlFailure('delegation_disabled', 'Delegation is disabled.')
    const messageId = this.#messageId(caller.id, p.idempotencyKey)
    const inbox = (await this.host.store.load(target.id)).inbox ?? {}
    const previous = inbox[messageId]
    if (previous) {
      if (previous.text !== p.text || previous.senderSessionId !== caller.id)
        throw new ControlFailure(
          'invalid_request',
          'Message identity was already used with different input.',
        )
      return this.#coordinationState(previous)
    }
    const rate = this.#rates.get(caller.id)
    const bucket = rate && Date.now() - rate.at < 60_000 ? rate : { at: Date.now(), count: 0 }
    if (++bucket.count > 60)
      throw new ControlFailure('delegation_limit', 'Agent message rate limit reached.')
    this.#rates.set(caller.id, bucket)
    if (Object.values(inbox).filter((entry) => entry.status !== 'consumed').length >= 100)
      throw new ControlFailure('delegation_limit', 'Recipient coordination inbox is full.')
    let message: CoordinationMessage = {
      messageId,
      senderSessionId: caller.id,
      recipientSessionId: target.id,
      text: p.text,
      createdAt: Date.now(),
      status: 'pending',
      turnId: null,
      consumedAt: null,
    }
    await this.host.record(target.id, { type: 'coordination.updated', message })
    // Pure inbox delivery works while either agent is blocked in a cooperative wait.
    // Only an actually live transport may bypass it; ACP follow-up steering is not live delivery.
    if (this.host.canDeliverCoordination?.(target.id) && this.host.deliverCoordination) {
      message = {
        ...message,
        status: 'delivering',
        turnId: (await this.host.store.load(target.id)).activeTurnId,
      }
      await this.host.record(target.id, { type: 'coordination.updated', message })
      this.#activeDeliveries.add(messageId)
      try {
        const delivered = await this.host.deliverCoordination(message)
        message = { ...message, status: delivered ? 'delivered' : 'pending' }
      } catch {
        message = { ...message, status: 'uncertain' }
      } finally {
        this.#activeDeliveries.delete(messageId)
      }
      await this.host.record(target.id, { type: 'coordination.updated', message })
    }
    return (await this.host.store.load(target.id)).inbox?.[messageId] ?? message
  }

  async #prompt(caller: Session, target: Session, text: string): Promise<unknown> {
    if (target.archived)
      throw new ControlFailure('scope_denied', 'Restore the target session before prompting it.')
    if (!this.host.policy().enabled)
      throw new ControlFailure('delegation_disabled', 'Delegation is disabled.')
    const rate = this.#rates.get(caller.id)
    const bucket = rate && Date.now() - rate.at < 60_000 ? rate : { at: Date.now(), count: 0 }
    if (++bucket.count > 60)
      throw new ControlFailure('delegation_limit', 'Agent message rate limit reached.')
    this.#rates.set(caller.id, bucket)
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
    return {
      sessionId: target.id,
      turnId: (await this.host.store.load(target.id)).activeTurnId,
      queued: true,
    }
  }

  async #read(
    caller: Session,
    target: Session,
    p: ControlParams<'session.read'>,
  ): Promise<unknown> {
    const state = await this.host.store.load(target.id)
    const turns = p.tailTurns
      ? new Set(
          [...new Set(state.messages.map((m) => m.turnId).filter(Boolean))].slice(-p.tailTurns),
        )
      : null
    const selected = state.messages
      .filter((m) => !turns || turns.has(m.turnId))
      .slice(-p.tailMessages)
    let remaining = p.maxChars
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
      messages,
      renderedText: messages
        .map((message) => `${message.role}: ${message.text}`)
        .join('\n\n')
        .slice(0, p.maxChars),
      latestAssistantText: report.text,
      truncated: remaining === 0 || selected.length < state.messages.length,
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
        const asked = state.messages.find(
          (entry) => entry.role === 'user' && entry.turnId === state.activeTurnId,
        )
        if (
          (target.parentSessionId === caller.id || isHelmSession(caller)) &&
          asked?.origin?.kind === 'session' &&
          asked.origin.sessionId === caller.id &&
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
    const parentModel = await this.host.store.load(parentId)
    // Sessions Aria started are roots in their own projects, not children, but
    // they are still the work this session handed out.
    const launched = new Set(
      (parentModel.childEvents ?? []).flatMap((event) =>
        event.type === 'child.session.spawned' ? [event.childSessionId] : [],
      ),
    )
    const roots = rows
      .filter((row) => !row.parentSessionId && launched.has(row.id))
      .map((row) => row.id)
    const below = [
      ...descendantIds(rows, parentId),
      ...roots.flatMap((id) => descendantIds(rows, id)),
    ]
    const ids = recursive
      ? [...descendantIds(rows, parentId).reverse(), ...roots]
      : [...rows.filter((row) => row.parentSessionId === parentId).map((row) => row.id), ...roots]
    // Read from the journal alone. A provider that is still shutting down
    // after its turn settled is not work, and saying so would keep a finished
    // child's card on "working".
    const live = new Set<string>()
    for (const id of [...below, ...roots])
      if ((await this.host.store.load(id)).activeTurnId) live.add(id)
    const completions = parentModel.childCompletions ?? {}
    const tasks: ChildTask[] = []
    for (const id of ids) {
      const model = await this.host.store.load(id)
      const session = model.session
      if (!session) continue
      const asked = model.messages.find(
        (message) => message.role === 'user' && message.turnId === model.activeTurnId,
      )
      const workState = childWorkState(
        model,
        descendantIds(rows, id).filter((nested) => live.has(nested)).length,
        asked?.origin?.kind === 'session',
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
        blockedOn:
          workState !== 'blocked_on_user'
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
