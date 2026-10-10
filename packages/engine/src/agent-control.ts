import { newTypedId } from '@ari/shared/ids'
import { createLogger } from '@ari/shared/logger'
import {
  AGENT_CONTROL_VERSION,
  ControlFailure,
  controlParams,
  type ControlMethod,
  type ControlParams,
  type ControlResult,
  type DelegationSettings,
} from '@ari/contracts/agent-control'
import type { Session, SessionWorkspace } from '@ari/contracts/session'
import type { Message } from '@ari/contracts/message'
import type { Command } from '@ari/contracts/commands'
import type { JournalEvent } from '@ari/contracts/events'
import type { SessionStore } from './session-store'
import type { UnstampedEvent } from './projection'
import { checkDelegation, sessionLineage } from './control-policy'
import { waitForTurn, type WaitOutcome } from './control-wait'
import { childWorkState, finalAssistantText, type ChildTask } from './delegation-state'

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
    return Promise.reject(new ControlFailure('delegation_approval_pending', APPROVAL_PENDING_MESSAGE))
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
  store: SessionStore
  version: string
  policy(): DelegationSettings
  providers(): Promise<
    { driverKind: string; available: boolean; models: { id: string; label: string }[] }[]
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
  isolate(parent: Session, childId: string): Promise<SessionWorkspace>
  diff(child: Session, patch: boolean): Promise<unknown>
  integrate(
    parent: Session,
    child: Session,
    snapshot: string,
    options?: { allowStale?: boolean },
  ): Promise<unknown>
  approve(root: Session): Promise<boolean>
  quiesce?(id: string): Promise<void>
  revoke?(id: string): void
  release(child: Session): Promise<void>
  /** A `session wait` by this caller ended; undelivered results may now be due. */
  waitEnded?(callerId: string): void
}

/** Scoped control primitives shared by the desktop host, local CLI and deterministic tests. */
export class AgentControlService {
  readonly #receipts = new Map<string, { fingerprint: string; result: Promise<unknown> }>()
  readonly #roots = new Map<string, Promise<unknown>>()
  readonly #approved = new Set<string>()
  readonly #approving = new Map<string, Promise<boolean>>()
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
      const result = this.#chain(caller, run)
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

  async #chain(caller: Session, run: () => Promise<unknown>): Promise<unknown> {
    const root = (await this.#lineage(caller)).at(-1) as Session
    const next = (this.#roots.get(root.id) ?? Promise.resolve())
      .catch(() => undefined)
      .then(run)
    this.#roots.set(root.id, next)
    void next
      .finally(() => {
        if (this.#roots.get(root.id) === next) this.#roots.delete(root.id)
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
    switch (method) {
      case 'runtime.info': {
        const chain = await this.#lineage(caller)
        const root = chain.at(-1) as Session
        const policy = this.host.policy()
        return {
          protocolVersion: AGENT_CONTROL_VERSION,
          ariVersion: this.host.version,
          caller: {
            sessionId: caller.id,
            projectId: caller.projectId,
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
          },
          capabilities: {
            isolatedWorktrees: true,
            sharedWorkspace: policy.allowSharedWorkspace,
            integration: true,
            recursiveDelegation: policy.recursiveDelegation,
          },
        }
      }
      case 'providers.list':
        return this.host.providers()
      case 'session.get':
        return this.#target(caller, (raw as ControlParams<'session.get'>).targetSessionId, true)
      case 'session.children': {
        const p = raw as ControlParams<'session.children'>
        const parent = await this.#target(caller, p.targetSessionId)
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
      case 'session.prompt':
      case 'session.message': {
        const p = raw as ControlParams<'session.prompt'>
        const target = await this.#target(caller, p.targetSessionId, method === 'session.message')
        if (
          method === 'session.message' &&
          target.id !== caller.parentSessionId &&
          !(await this.#lineage(target)).some((s) => s.id === caller.id)
        )
          throw new ControlFailure(
            'scope_denied',
            'Messages to ancestors are limited to the direct parent.',
          )
        return this.#prompt(caller, target, p.text)
      }
      case 'session.read':
        return this.#read(
          caller,
          await this.#target(caller, (raw as ControlParams<'session.read'>).targetSessionId),
          raw as ControlParams<'session.read'>,
        )
      case 'session.wait':
        return this.#wait(caller, raw as ControlParams<'session.wait'>, signal)
      case 'session.status':
        return this.#status(caller, raw as ControlParams<'session.status'>)
      case 'session.stop': {
        const target = await this.#target(
          caller,
          (raw as ControlParams<'session.stop'>).targetSessionId,
        )
        const state = await this.host.store.load(target.id)
        // The caller knows it stopped this turn; it needs no wake-up about it.
        if (state.activeTurnId && target.parentSessionId === caller.id)
          await this.#acknowledge(caller.id, target.id, state.activeTurnId, 'disposed')
        if (state.activeTurnId)
          await this.host.dispatch({ type: 'turn.interrupt', sessionId: target.id })
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
          try {
            await this.host.store.destroy(id)
          } catch (error) {
            if (
              !(
                error &&
                typeof error === 'object' &&
                'code' in error &&
                error.code === 'session_not_found'
              )
            )
              throw error
          }
          await this.host.release({ ...target, id }).catch(() => undefined)
          this.host.revoke?.(id)
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
    }
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
      void request.then(
        (allowed) => {
          if (allowed) this.#approved.add(root.id)
          cleanup()
        },
        cleanup,
      )
      pending = request
    }
    return raceApproval(pending, signal)
  }

  async #spawn(
    caller: Session,
    p: ControlParams<'session.spawn'>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const existing = await this.#existingSpawn(caller, p.idempotencyKey)
    if (existing) return existing
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
      await this.#active(root.id),
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
    if (policy.approvalMode !== 'never') {
      const prior =
        this.#approved.has(root.id) ||
        ((await this.host.store.load(root.id)).childEvents ?? []).some(
          (event) => event.type === 'child.session.spawned',
        )
      if (policy.approvalMode === 'always' || !prior) {
        if (!(await this.#requestApproval(root, signal)))
          throw new ControlFailure('delegation_approval_required', 'Delegation was not approved.')
        // A caller that went away mid-wait must not mint an orphan child:
        // its retry (same idempotency key) creates the one child.
        if (signal?.aborted)
          throw new ControlFailure('delegation_approval_pending', APPROVAL_PENDING_MESSAGE)
      }
      this.#approved.add(root.id)
    }
    const id = newTypedId('sess')
    let child: Session | undefined
    let isolated = false
    try {
      const workspace =
        mode === 'isolated' ? await this.host.isolate(caller, id) : { kind: 'project' as const }
      isolated = mode === 'isolated'
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
      if (child) {
        await this.host.store.destroy(id).catch(() => undefined)
        await this.host.release(child).catch(() => undefined)
      } else if (isolated) {
        await this.host.release({ ...caller, id }).catch(() => undefined)
      }
      this.host.revoke?.(id)
      throw error
    }
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
    if (!state.activeTurnId && target.parentSessionId) {
      const root = (await this.#lineage(target)).at(-1) as Session
      if ((await this.#active(root.id)) >= this.host.policy().maxConcurrentChildren)
        throw new ControlFailure('delegation_limit', 'Maximum concurrent children reached.')
    }
    const outcome = await this.host.dispatch(
      {
        type: state.activeTurnId ? 'message.enqueue' : 'turn.start',
        sessionId: target.id,
        text,
        attachments: [],
      },
      { kind: 'session', sessionId: caller.id },
    )
    if (!outcome.accepted)
      throw new ControlFailure('invalid_request', outcome.reason ?? 'Input rejected.')
    return {
      sessionId: target.id,
      turnId: (await this.host.store.load(target.id)).activeTurnId,
      queued: state.activeTurnId !== null,
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
    if (
      target.parentSessionId === caller.id &&
      state.activeTurnId === null &&
      state.lastTurn &&
      !report.truncated
    )
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
    const targets = await Promise.all(p.targetSessionIds.map((id) => this.#target(caller, id)))
    const controller = new AbortController()
    // Aborted only in `any` mode, once one target has an outcome.
    const race = new AbortController()
    const abort = (): void => controller.abort()
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) controller.abort()
    const own = targets.filter((target) => target.parentSessionId === caller.id)
    for (const target of own) this.#trackWait(caller.id, target.id, 1)
    try {
      const outcomes = await Promise.all(
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
      // A caller that went away never received these, so they stay pending.
      if (!controller.signal.aborted)
        for (const outcome of outcomes) {
          const seen = outcome.status === 'settled' || outcome.status === 'idle'
          if (seen && outcome.turnId && own.some((target) => target.id === outcome.sessionId))
            await this.#acknowledge(caller.id, outcome.sessionId, outcome.turnId, 'wait')
        }
      return outcomes
    } finally {
      signal?.removeEventListener('abort', abort)
      for (const target of own) this.#trackWait(caller.id, target.id, -1)
      this.host.waitEnded?.(caller.id)
    }
  }

  /** One row per delegated child: where it stands and what it last reported. */
  async #status(caller: Session, p: ControlParams<'session.status'>): Promise<unknown> {
    const parent = await this.#target(caller, p.targetSessionId)
    const rows = await this.host.store.listSessions()
    const ids = p.recursive
      ? descendantIds(rows, parent.id).reverse()
      : rows.filter((row) => row.parentSessionId === parent.id).map((row) => row.id)
    const live = new Set<string>()
    for (const id of descendantIds(rows, parent.id))
      if ((await this.host.store.load(id)).activeTurnId || this.host.isRunning?.(id)) live.add(id)
    const completions = (await this.host.store.load(parent.id)).childCompletions ?? {}
    const tasks: ChildTask[] = []
    for (const id of ids) {
      const model = await this.host.store.load(id)
      const session = model.session
      if (!session) continue
      const workState = childWorkState(
        model,
        descendantIds(rows, id).filter((nested) => live.has(nested)).length,
        this.host.isRunning?.(id),
      )
      const settled = workState === 'result_available' || workState === 'waiting_for_children'
      const report =
        settled && model.lastTurn ? finalAssistantText(model, model.lastTurn.turnId, 2_000) : null
      const direct = session.parentSessionId === parent.id
      if (
        direct &&
        parent.id === caller.id &&
        workState === 'result_available' &&
        model.lastTurn &&
        report &&
        !report.truncated
      )
        await this.#acknowledge(caller.id, id, model.lastTurn.turnId, 'read')
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
        workspaceKind: session.workspace?.kind ?? 'project',
        branch: session.workspace?.kind === 'managed-worktree' ? session.workspace.branch : null,
      })
    }
    const count = (state: string): number =>
      tasks.filter((task) => task.workState === state).length
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
      },
    }
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

function descendantIds(
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
