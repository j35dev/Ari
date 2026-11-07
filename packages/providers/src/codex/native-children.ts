import type { AgentEvent } from '@ari/contracts/agent-event'
import type { BackgroundTaskStatus } from '@ari/contracts/background-task'
import { appServerCorrelation } from './mapper'

interface Child {
  threadId: string
  turnId: string | null
  label: string
  status: BackgroundTaskStatus
  detail: string | null
  terminalTurns: Set<string>
  sent: string
}

/** Direct app-server children are read-only lifecycle records, never root text. */
export class CodexNativeChildren {
  readonly #children = new Map<string, Child>()

  /** Root collaboration calls can expose lifecycle without child deltas. */
  observeCollaboration(params: Record<string, unknown>): AgentEvent[] {
    const item = params['item'] as
      | {
          type?: string
          tool?: string
          receiverThreadIds?: unknown[]
          prompt?: string
          agentsStates?: Record<string, { status?: string }>
        }
      | undefined
    if (item?.type !== 'collabAgentToolCall') return []
    const events: AgentEvent[] = []
    if (item.tool === 'spawnAgent') {
      for (const threadId of Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds : []) {
        if (typeof threadId !== 'string' || !threadId) continue
        if (threadId === appServerCorrelation(params).threadId) continue
        events.push(
          ...this.observe('thread/started', { thread: { id: threadId, preview: item.prompt } }),
        )
      }
    }
    for (const [threadId, state] of Object.entries(item.agentsStates ?? {})) {
      const child = this.#children.get(threadId)
      if (!child || child.status !== 'running') continue
      const status = state?.status
      if (status === 'completed') child.status = 'completed'
      else if (status === 'interrupted') child.status = 'stopped'
      else if (status === 'errored' || status === 'shutdown' || status === 'notFound')
        child.status = 'failed'
      else continue
      if (child.turnId) child.terminalTurns.add(child.turnId)
      events.push(...this.#emit(child))
    }
    return events
  }

  observe(method: string, params: Record<string, unknown>): AgentEvent[] {
    const { threadId, turnId } = appServerCorrelation(params)
    if (!threadId) return []
    let child = this.#children.get(threadId)
    if (!child) {
      if (
        method !== 'thread/started' &&
        method !== 'turn/started' &&
        method !== 'turn/completed' &&
        !method.endsWith('/requestApproval')
      )
        return []
      child = {
        threadId,
        turnId: null,
        label: 'Sub-agent',
        status: 'running',
        detail: null,
        terminalTurns: new Set(),
        sent: '',
      }
      this.#children.set(threadId, child)
    }
    if (turnId && child.terminalTurns.has(turnId)) return []
    if (method === 'thread/started') {
      const thread = params['thread'] as { name?: unknown; preview?: unknown } | undefined
      const label = thread?.name ?? thread?.preview
      if (typeof label === 'string' && label.trim()) child.label = label.trim().slice(0, 80)
    } else if (method === 'turn/started' && turnId) {
      if (child.turnId && child.turnId !== turnId) child.terminalTurns.add(child.turnId)
      child.turnId = turnId
      child.status = 'running'
      child.detail = null
    } else if (method === 'turn/completed' && turnId) {
      if (child.turnId && child.turnId !== turnId) return []
      child.turnId = turnId
      const turn = params['turn'] as { status?: string; error?: { message?: string } } | undefined
      child.status =
        turn?.status === 'failed'
          ? 'failed'
          : turn?.status === 'interrupted'
            ? 'stopped'
            : 'completed'
      child.detail = turn?.status === 'failed' ? (turn.error?.message ?? 'Sub-agent failed') : null
      child.terminalTurns.add(turnId)
    } else if (method === 'item/started') {
      if (turnId && child.turnId && child.turnId !== turnId) return []
      const item = params['item'] as { type?: string; command?: string } | undefined
      child.detail = item?.command?.slice(0, 80) ?? item?.type ?? child.detail
    } else if (method.endsWith('/requestApproval')) {
      child.detail = 'Needs approval'
    } else {
      // Text, context and usage remain available in correlated diagnostics.
      return []
    }
    return this.#emit(child)
  }

  #emit(child: Child): AgentEvent[] {
    const sent = JSON.stringify([child.turnId, child.label, child.status, child.detail])
    if (sent === child.sent) return []
    child.sent = sent
    const event: AgentEvent & { providerThreadId: string; providerTurnId?: string } = {
      type: 'background-task',
      id: child.threadId,
      kind: 'subagent',
      label: child.label,
      status: child.status,
      detail: child.detail,
      providerThreadId: child.threadId,
      ...(child.turnId ? { providerTurnId: child.turnId } : {}),
    }
    return [event]
  }

  acceptsRequest(threadId: string, turnId: string | null): boolean {
    const child = this.#children.get(threadId)
    // An owned request may be the first observation of a native child.
    if (!child) return true
    return (
      child.status === 'running' &&
      (turnId === null || child.turnId === null || child.turnId === turnId) &&
      (turnId === null || !child.terminalTurns.has(turnId))
    )
  }

  /** The turn-only transport ended; surviving child processes cannot continue. */
  end(): AgentEvent[] {
    const events: AgentEvent[] = []
    for (const child of this.#children.values()) {
      if (child.status !== 'running') continue
      child.status = 'stopped'
      events.push({
        type: 'background-task',
        id: child.threadId,
        kind: 'subagent',
        label: child.label,
        status: 'stopped',
        detail: 'Provider process ended',
        ...{
          providerThreadId: child.threadId,
          ...(child.turnId ? { providerTurnId: child.turnId } : {}),
        },
      })
    }
    return events
  }
}
