import { useState, type ReactNode } from 'react'
import { ChevronRight, GitBranch } from 'lucide-react'
import type { ChildTask } from '@ari/contracts/agent-control'
import { BottomSheet } from '../../components/ui'
import {
  AGENT_LABEL,
  agentState,
  agentsSummary,
  isLive,
  type AgentState,
} from '../../lib/delegation'

const TONE: Record<AgentState, string> = {
  working: 'text-fg',
  'needs-you': 'text-warning',
  waiting: 'text-fg-muted',
  done: 'text-fg-muted',
  failed: 'text-danger',
  stopped: 'text-fg-subtle',
  idle: 'text-fg-subtle',
}
const DOT: Record<AgentState, string> = {
  working: 'status-pulse bg-success',
  'needs-you': 'bg-warning',
  waiting: 'bg-fg-subtle',
  done: 'bg-success',
  failed: 'bg-danger',
  stopped: 'bg-fg-subtle',
  idle: 'bg-fg-subtle',
}

/**
 * The work a session handed to other agents: one line above the composer that
 * says how it is going, and a sheet with each agent, what it reported, and a
 * way into it. A phone has no room for the desktop's inline task cards, and
 * the question on a phone is the one this answers at a glance — is anything
 * still running, and does any of it need me.
 */
export function Agents({
  tasks,
  onOpen,
  onStopAll,
}: {
  tasks: readonly ChildTask[]
  onOpen: (sessionId: string) => void
  /** Stops every agent still running. Omitted when stopping is not possible. */
  onStopAll?: () => Promise<void>
}): ReactNode {
  const [open, setOpen] = useState(false)
  const [stopping, setStopping] = useState(false)
  if (tasks.length === 0) return null
  const states = tasks.map(agentState)
  const live = states.some(isLive)
  const needsYou = states.includes('needs-you')
  return (
    <>
      <button
        type="button"
        aria-label={`Delegated agents: ${agentsSummary(tasks)}`}
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
        className="mx-4 mb-2 flex min-h-11 shrink-0 items-center gap-2 rounded-xl bg-surface-1 px-3 text-left text-xs text-fg-muted"
      >
        <GitBranch size={14} aria-hidden className="shrink-0 text-accent" />
        <span className={`min-w-0 flex-1 truncate ${needsYou ? 'text-warning' : ''}`}>
          {agentsSummary(tasks)}
        </span>
        {live && (
          <span
            aria-hidden
            className={`size-2 shrink-0 rounded-full ${needsYou ? 'bg-warning' : 'status-pulse bg-success'}`}
          />
        )}
        <ChevronRight size={14} aria-hidden className="shrink-0 text-fg-subtle" />
      </button>
      {open && (
        <BottomSheet title="Delegated agents" onClose={() => setOpen(false)}>
          <ul className="pb-2">
            {tasks.map((task, index) => {
              const state = states[index] ?? 'idle'
              return (
                <li key={task.sessionId}>
                  <button
                    type="button"
                    aria-label={`Open ${task.title}: ${AGENT_LABEL[state]}`}
                    className="flex min-h-16 w-full items-start gap-3 py-2.5 text-left"
                    onClick={() => {
                      setOpen(false)
                      onOpen(task.sessionId)
                    }}
                  >
                    <span aria-hidden className={`mt-2 size-2 shrink-0 rounded-full ${DOT[state]}`} />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline gap-2">
                        <span className="min-w-0 flex-1 truncate text-[15px] font-medium tracking-tight">
                          {task.title}
                        </span>
                        <span className={`shrink-0 text-xs ${TONE[state]}`}>{AGENT_LABEL[state]}</span>
                      </span>
                      <span className="mt-0.5 block truncate text-xs text-fg-subtle">
                        {[task.role && task.role !== 'general' ? task.role : null, task.driverKind]
                          .filter((part) => part !== null)
                          .join(' · ')}
                      </span>
                      {task.report !== null && task.report.trim() !== '' && (
                        <span className="mt-1 line-clamp-3 block text-[13px] leading-snug text-fg-muted">
                          {task.report}
                        </span>
                      )}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
          {live && onStopAll !== undefined && (
            <button
              type="button"
              className="mb-2 min-h-11 w-full rounded-xl border border-border text-sm text-fg-muted disabled:opacity-40"
              disabled={stopping}
              onClick={() => {
                setStopping(true)
                void onStopAll().finally(() => setStopping(false))
              }}
            >
              {stopping ? 'Stopping…' : 'Stop all agents'}
            </button>
          )}
        </BottomSheet>
      )}
    </>
  )
}
