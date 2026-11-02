import { useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { Bot, Check, ChevronUp, SquareTerminal } from 'lucide-react'
import { transitions } from '@ari/ui/motion'
import type { BackgroundTask } from '@ari/contracts/background-task'
import { ElapsedSeconds, formatElapsed, SessionActivityMark } from '../moment'

/** Rows the list shows at most, running ones first. */
const MAX_ROWS = 8
const WORKING = { phase: 'working', startedAt: null } as const

/** The rail's one-line summary of what runs, or null when nothing does. */
export function backgroundSummary(
  tasks: readonly BackgroundTask[],
  reporting: boolean,
): string | null {
  const agents = tasks.filter((task) => task.status === 'running' && task.kind === 'subagent')
  const shells = tasks.filter((task) => task.status === 'running' && task.kind === 'shell')
  const agentText = `${agents.length} agent${agents.length === 1 ? '' : 's'} working`
  const shellText =
    shells.length === 1 ? 'Background shell running' : `${shells.length} background shells`
  if (agents.length > 0 && shells.length > 0)
    return `${agentText} · ${shells.length} shell${shells.length === 1 ? '' : 's'}`
  if (agents.length > 0) return agentText
  if (shells.length > 0) return shellText
  return reporting ? 'Working in background' : null
}

/**
 * Composer-top rail for work the agent's own harness runs beside the
 * conversation: its sub-agents and the shells it sent to the background,
 * which can outlive the turn. Shown while any of it runs, or while the agent
 * is reporting back between turns. Expands in place like the child-session
 * rail. There is no per-task stop: nothing Ari speaks to the agent can stop
 * one task, and the turn's own Stop already ends its sub-agents.
 */
export function BackgroundWork({
  tasks,
  reporting = false,
  since = null,
}: {
  tasks: readonly BackgroundTask[]
  /** The agent is producing output between turns right now. */
  reporting?: boolean
  /** Finished tasks that started before this (the latest turn's start) are left out. */
  since?: number | null
}) {
  const [open, setOpen] = useState(false)
  const summary = backgroundSummary(tasks, reporting)
  if (summary === null) return null
  const running = tasks.filter((task) => task.status === 'running')
  const finished = tasks
    .filter((task) => task.status !== 'running' && (since === null || task.startedAt >= since))
    .reverse()
  const rows = [...running, ...finished].slice(0, MAX_ROWS)
  const oldest = running.reduce<number | null>(
    (min, task) => (min === null || task.startedAt < min ? task.startedAt : min),
    null,
  )
  return (
    <div>
      <AnimatePresence initial={false}>
        {open && rows.length > 0 ? (
          <motion.ul
            key="background"
            role="list"
            aria-label="Background work"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={transitions.morph}
            className="max-h-48 overflow-y-auto"
          >
            {rows.map((task) => (
              <TaskRow key={task.id} task={task} />
            ))}
          </motion.ul>
        ) : null}
      </AnimatePresence>
      <button
        type="button"
        aria-expanded={open}
        aria-label="Background work"
        disabled={rows.length === 0}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full min-w-0 items-center gap-2 px-3 py-1.5 text-left text-2xs text-fg-muted transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring disabled:hover:text-fg-muted"
      >
        <SessionActivityMark activity={WORKING} />
        <span className="min-w-0 truncate font-medium text-fg">{summary}</span>
        {oldest !== null ? <ElapsedSeconds startedAt={oldest} /> : null}
        {rows.length > 0 ? (
          <ChevronUp
            size={11}
            aria-hidden
            className={`ms-auto shrink-0 transition-transform duration-150 ${open ? '' : 'rotate-180'}`}
          />
        ) : null}
      </button>
    </div>
  )
}

function TaskRow({ task }: { task: BackgroundTask }) {
  const Icon = task.kind === 'subagent' ? Bot : SquareTerminal
  const running = task.status === 'running'
  // A shell's end is rarely reported, so a running one is described by when
  // it started rather than claimed to be busy.
  const detail = task.detail ?? (running && task.kind === 'shell' ? 'Started in background' : null)
  return (
    <li className="flex items-start gap-2 px-3 py-1.5">
      <Icon
        size={12}
        aria-hidden
        className={`mt-px shrink-0 ${running ? 'text-accent' : 'text-fg-subtle'}`}
      />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className="min-w-0 truncate text-xs text-fg" title={task.label}>
            {task.label || (task.kind === 'subagent' ? 'Sub-agent' : 'Shell command')}
          </span>
          <span className="shrink-0 text-2xs text-fg-subtle">
            {task.kind === 'subagent' ? 'agent' : 'shell'}
          </span>
        </span>
        {detail !== null ? (
          <span className="block truncate text-2xs text-fg-subtle" title={detail}>
            {running && task.kind === 'subagent' ? `▸ ${detail}` : detail}
          </span>
        ) : null}
      </span>
      <span className="flex shrink-0 items-center gap-1.5 font-mono text-2xs">
        <StatusLabel task={task} />
        {running ? (
          <ElapsedSeconds startedAt={task.startedAt} />
        ) : task.endedAt !== null ? (
          <span className="text-fg-subtle tabular-nums">
            {formatElapsed(Math.max(0, Math.floor((task.endedAt - task.startedAt) / 1000)))}
          </span>
        ) : null}
      </span>
    </li>
  )
}

function StatusLabel({ task }: { task: BackgroundTask }) {
  switch (task.status) {
    case 'running':
      return (
        <span className="text-accent">
          {task.kind === 'subagent' ? 'working' : 'in background'}
        </span>
      )
    case 'completed':
      return (
        <span className="inline-flex items-center gap-0.5 text-success">
          <Check size={10} aria-hidden />
          done
        </span>
      )
    case 'failed':
      return <span className="text-danger">failed</span>
    case 'stopped':
      return <span className="text-fg-subtle">stopped</span>
  }
}
