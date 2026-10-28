import { useEffect, useMemo, useState } from 'react'
import {
  ChevronDown,
  ChevronUp,
  Circle,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  ListTodo,
  Users,
} from 'lucide-react'
import type { ChildTask } from '@ari/contracts/agent-control'
import type { RpcResults } from '@ari/contracts/rpc'
import { rpc } from '../../lib/rpc'
import { formatTokens, formatUsd } from '../usage/parse-ccusage'

type PlanItems = RpcResults['plan.get']['items']

/**
 * Live plan surface (research gap: "what is it doing / what's left"): renders
 * the per-session `.ari-todo-<sessionId>.json` checklist that Ari Core's
 * todo_write maintains, then the lead's children — state, model and spend —
 * because spawning a worker is how a lead writes its plan when its provider
 * cannot maintain a todo file. Pinned above the transcript; each block
 * collapses on its own. Scoped by session id so two sessions in one project
 * never render each other's work.
 */
export function PlanPanel({
  sessionId,
  refreshNonce,
  tasks = null,
}: {
  sessionId: string | null
  refreshNonce?: number
  /** `session.tasks` for this session, kept live by the session view. */
  tasks?: readonly ChildTask[] | null
}) {
  const [items, setItems] = useState<PlanItems>(null)
  const [planExpanded, setPlanExpanded] = useState(true)
  const [teamExpanded, setTeamExpanded] = useState(true)

  useEffect(() => {
    if (sessionId === null) {
      setItems(null)
      return
    }
    let cancelled = false
    void rpc
      .invoke('plan.get', { sessionId })
      .then((result) => {
        if (!cancelled) setItems(result.items)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [sessionId, refreshNonce])

  const children = tasks ?? []
  const team = useMemo(() => teamSummary(children), [children])

  if ((items === null || items.length === 0) && children.length === 0) return null

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-2 px-4 pt-3">
      {items !== null && items.length > 0 ? (
        <PlanCard
          items={items}
          expanded={planExpanded}
          onToggle={() => setPlanExpanded((open) => !open)}
        />
      ) : null}
      {children.length > 0 ? (
        <div className="rounded-lg border border-border bg-surface-1">
          <button
            type="button"
            aria-expanded={teamExpanded}
            onClick={() => setTeamExpanded((open) => !open)}
            className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
          >
            <Users size={13} className="shrink-0 text-accent" aria-hidden />
            <span className="min-w-0 flex-1 truncate text-xs font-medium text-fg">Team</span>
            <span className="shrink-0 font-mono text-2xs tabular-nums text-fg-subtle">
              {children.length}
            </span>
            <span
              className="shrink-0 font-mono text-2xs tabular-nums text-fg-subtle"
              title="Tokens and cost across the children on this screen"
            >
              {formatTokens(team.tokens)}
              {team.unpriced > 0 ? ' · cost incomplete' : ` · ${formatUsd(team.costUsd)}`}
            </span>
            {teamExpanded ? (
              <ChevronUp size={12} className="shrink-0 text-fg-subtle" aria-hidden />
            ) : (
              <ChevronDown size={12} className="shrink-0 text-fg-subtle" aria-hidden />
            )}
          </button>
          {teamExpanded ? (
            <>
              <ul className="flex flex-col gap-1 border-t border-border px-3 py-2">
                {children.map((child) => (
                  <TeamRow key={child.sessionId} child={child} />
                ))}
              </ul>
              <p className="flex flex-wrap gap-x-3 gap-y-1 border-t border-border px-3 py-2 font-mono text-2xs text-fg-subtle">
                {team.models.map((model) => (
                  <span key={model.label} title={model.label} className="tabular-nums">
                    {model.label} · {formatTokens(model.tokens)}
                    {model.unpriced > 0 ? ' · unpriced' : ` · ${formatUsd(model.costUsd)}`}
                  </span>
                ))}
              </p>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function PlanCard({
  items,
  expanded,
  onToggle,
}: {
  items: NonNullable<PlanItems>
  expanded: boolean
  onToggle: () => void
}) {
  const done = items.filter((item) => item.status === 'done').length
  return (
    <div className="rounded-lg border border-border bg-surface-1">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={onToggle}
        className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
      >
        <ListTodo size={13} className="shrink-0 text-accent" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-fg">
          Plan
          {done === items.length ? ' — complete' : ''}
        </span>
        <span className="shrink-0 font-mono text-2xs tabular-nums text-fg-subtle">
          {done}/{items.length}
        </span>
        {expanded ? (
          <ChevronUp size={12} className="shrink-0 text-fg-subtle" aria-hidden />
        ) : (
          <ChevronDown size={12} className="shrink-0 text-fg-subtle" aria-hidden />
        )}
      </button>
      {expanded ? (
        <ul className="flex flex-col gap-1 border-t border-border px-3 py-2">
          {items.map((item, index) => (
            <li key={`${index}-${item.text}`} className="flex items-start gap-2">
              {item.status === 'done' ? (
                <CircleCheck size={13} className="mt-0.5 shrink-0 text-success" aria-hidden />
              ) : item.status === 'in_progress' ? (
                <Circle
                  size={13}
                  className="mt-0.5 shrink-0 animate-pulse text-busy"
                  fill="currentColor"
                  aria-hidden
                />
              ) : (
                <CircleDashed size={13} className="mt-0.5 shrink-0 text-fg-subtle" aria-hidden />
              )}
              <span
                className={`min-w-0 flex-1 break-words text-xs leading-relaxed ${
                  item.status === 'done' ? 'text-fg-subtle line-through' : 'text-fg-muted'
                }`}
              >
                {item.text}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

function TeamRow({ child }: { child: ChildTask }) {
  const state = childState(child)
  const tokens = child.usage.inputTokens + child.usage.outputTokens
  return (
    <li className="flex items-center gap-2">
      <StateIcon state={state} />
      <span className="min-w-0 flex-1 truncate text-xs text-fg" title={child.title}>
        {child.title}
      </span>
      <span className="shrink-0 text-2xs text-fg-subtle">{STATE_LABEL[state]}</span>
      {child.role ? (
        <span className="shrink-0 rounded-sm bg-surface-2 px-1 py-0.5 text-2xs text-fg-muted">
          {child.role}
        </span>
      ) : null}
      <span className="shrink-0 font-mono text-2xs tabular-nums text-fg-subtle" title="Spend">
        {formatTokens(tokens)}
        {child.usage.costUsd === null ? '' : ` · ${formatUsd(child.usage.costUsd)}`}
      </span>
    </li>
  )
}

type RowState =
  | 'working'
  | 'needs-you'
  | 'needs-lead'
  | 'waiting'
  | 'queued'
  | 'idle'
  | 'done'
  | 'failed'
  | 'stopped'

const STATE_LABEL: Record<RowState, string> = {
  working: 'Working',
  'needs-you': 'Needs you',
  'needs-lead': 'Needs lead',
  waiting: 'Waiting',
  queued: 'Queued',
  idle: 'Not started',
  done: 'Done',
  failed: 'Failed',
  stopped: 'Stopped',
}

/** The child's state as its lead reads it; activity, not the transcript, decides. */
function childState(task: ChildTask): RowState {
  switch (task.workState) {
    case 'working':
      return 'working'
    case 'blocked_on_user':
      return 'needs-you'
    case 'blocked_on_parent':
      return 'needs-lead'
    case 'queued':
      return 'queued'
    case 'waiting_for_children':
      return 'waiting'
    case 'not_started':
      return 'idle'
    case 'result_available':
      if (task.latestTurn?.stopReason === 'error') return 'failed'
      return task.latestTurn?.stopReason === 'interrupted' ? 'stopped' : 'done'
  }
}

function StateIcon({ state }: { state: RowState }) {
  switch (state) {
    case 'done':
      return <CircleCheck size={13} className="shrink-0 text-success" aria-hidden />
    case 'failed':
      return <CircleAlert size={13} className="shrink-0 text-danger" aria-hidden />
    case 'working':
      return (
        <Circle
          size={13}
          className="shrink-0 animate-pulse text-busy"
          fill="currentColor"
          aria-hidden
        />
      )
    case 'needs-you':
    case 'needs-lead':
      return <Circle size={13} className="shrink-0 text-warning" fill="currentColor" aria-hidden />
    default:
      return <CircleDashed size={13} className="shrink-0 text-fg-subtle" aria-hidden />
  }
}

/** Tokens and cost across the direct children, plus one line per model. */
function teamSummary(children: readonly ChildTask[]): {
  tokens: number
  costUsd: number
  unpriced: number
  models: { label: string; tokens: number; costUsd: number; unpriced: number }[]
} {
  let tokens = 0
  let costUsd = 0
  let unpriced = 0
  const byModel = new Map<string, { tokens: number; costUsd: number; unpriced: number }>()
  for (const child of children) {
    const own = child.usage.inputTokens + child.usage.outputTokens
    tokens += own
    if (child.usage.costUsd === null) unpriced += 1
    else costUsd += child.usage.costUsd
    const label = child.modelId ?? child.driverKind
    const row = byModel.get(label) ?? { tokens: 0, costUsd: 0, unpriced: 0 }
    row.tokens += own
    if (child.usage.costUsd === null) row.unpriced += 1
    else row.costUsd += child.usage.costUsd
    byModel.set(label, row)
  }
  return {
    tokens,
    costUsd,
    unpriced,
    models: [...byModel.entries()]
      .map(([label, row]) => ({ label, ...row }))
      .sort((a, b) => b.tokens - a.tokens),
  }
}
