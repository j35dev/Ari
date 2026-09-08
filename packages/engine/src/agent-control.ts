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
import type { Command } from '@ari/contracts/commands'
import type { JournalEvent } from '@ari/contracts/events'
import type { SessionStore } from './session-store'
import type { UnstampedEvent } from './projection'
import { checkDelegation, sessionLineage } from './control-policy'
import { waitForTurn } from './control-wait'

const log = createLogger('engine:control')

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
}

/** Scoped control primitives shared by the desktop host, local CLI and deterministic tests. */
export class AgentControlService {
  readonly #receipts = new Map<string, { fingerprint: string; result: Promise<unknown> }>()
  readonly #roots = new Map<string, Promise<unknown>>()
  readonly #approved = new Set<string>()
  readonly #approving = new Map<string, Promise<boolean>>()
  readonly #rates = new Map<string, { at: number; count: number }>()
  readonly #gone = new Map<string, Set<() => void>>()
  constructor(readonly host: ControlHost) {}

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
        return this.#spawn(caller, raw as ControlParams<'session.spawn'>)
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
          await this.#target(caller, (raw as ControlParams<'session.read'>).targetSessionId),
          raw as ControlParams<'session.read'>,
        )
      case 'session.wait': {
        const p = raw as ControlParams<'session.wait'>
        const targets = await Promise.all(p.targetSessionIds.map((id) => this.#target(caller, id)))
        const controller = new AbortController()
        const abort = () => controller.abort()
        signal?.addEventListener('abort', abort, { once: true })
        if (signal?.aborted) controller.abort()
        try {
          return await Promise.all(
            targets.map(async (s) => {
              try {
                return await waitForTurn(
                  {
                    load: (id) => this.host.store.load(id),
                    subscribe: (listener) => this.host.subscribe(listener),
                    onGone: (id, listener) => this.#watchGone(id, listener),
                  },
                  s.id,
                  p.timeoutMs,
                  controller.signal,
                )
              } catch (error) {
                if (error instanceof ControlFailure && error.code === 'wait_timeout')
                  return { status: 'timeout' as const, sessionId: s.id }
                if (error instanceof ControlFailure && error.code === 'wait_cancelled')
                  throw error
                if (error instanceof ControlFailure && error.code === 'session_not_found')
                  return { status: 'destroyed' as const, sessionId: s.id }
                throw error
              }
            }),
          )
        } finally {
          signal?.removeEventListener('abort', abort)
        }
      }
      case 'session.stop': {
        const target = await this.#target(
          caller,
          (raw as ControlParams<'session.stop'>).targetSessionId,
        )
        const state = await this.host.store.load(target.id)
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

  async #requestApproval(root: Session): Promise<boolean> {
    const pending = this.#approving.get(root.id)
    if (pending) return pending
    const request = this.host.approve(root)
    this.#approving.set(root.id, request)
    try {
      return await request
    } finally {
      if (this.#approving.get(root.id) === request) this.#approving.delete(root.id)
    }
  }

  async #spawn(caller: Session, p: ControlParams<'session.spawn'>): Promise<unknown> {
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
        if (!(await this.#requestApproval(root)))
          throw new ControlFailure('delegation_approval_required', 'Delegation was not approved.')
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
      child = {
        id,
        projectId: caller.projectId,
        parentSessionId: caller.id,
        rootSessionId: root.id,
        createdBy: { kind: 'session', sessionId: caller.id },
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

  async #read(target: Session, p: ControlParams<'session.read'>): Promise<unknown> {
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
        const text = message.parts
          .flatMap((part) =>
            part.type === 'text'
              ? [part.text]
              : p.includeToolSummaries && part.type === 'tool-call'
                ? [`[Tool: ${part.name}]`]
                : p.includeToolSummaries && part.type === 'tool-result'
                  ? [`[Result: ${part.resultJson.slice(0, 500)}]`]
                  : [],
          )
          .join('\n')
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
    return {
      session: target,
      activeTurnId: state.activeTurnId,
      latestTurn: state.lastTurn ?? null,
      messages,
      renderedText: messages
        .map((message) => `${message.role}: ${message.text}`)
        .join('\n\n')
        .slice(0, p.maxChars),
      latestAssistantText:
        [...messages].reverse().find((message) => message.role === 'assistant')?.text ?? '',
      truncated: remaining === 0 || selected.length < state.messages.length,
    }
  }
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
