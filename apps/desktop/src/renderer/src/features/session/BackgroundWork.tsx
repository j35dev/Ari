import { useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { ChevronRight } from 'lucide-react'
import { transitions } from '@ari/ui/motion'
import type { BackgroundTask } from '@ari/contracts/background-task'
import { ElapsedSeconds, formatElapsed } from '../moment'
import { composerTabRail, composerTabRow, composerTabSection } from './ChildSessionActivity'

/** Rows the list shows at most, running ones first. */
const MAX_ROWS = 8

const STATUS_GLYPH: Record<BackgroundTask['status'], string | undefined> = {
  running: 'working',
  completed: 'done',
  failed: 'error',
  stopped: undefined,
}

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
 * Composer-top row for work the agent's own harness runs beside the
 * conversation: its sub-agents and the shells it sent to the background,
 * which can outlive the turn. Shown while any of it runs, or while the agent
 * is reporting back between turns. Expands in place like the child-session
 * row. There is no per-task stop: nothing Ari speaks to the agent can stop
 * one task, and the turn's own Stop already ends its sub-agents.
 */
export function BackgroundWork({
  tasks,
  reporting = false,
  since = null,
  providerLabel,
}: {
  tasks: readonly BackgroundTask[]
  /** The agent is producing output between turns right now. */
  reporting?: boolean
  /** Finished tasks that started before this (the latest turn's start) are left out. */
  since?: number | null
  providerLabel?: string
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
    <div className={composerTabSection}>
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
            className="max-h-48 overflow-y-auto pt-1.5"
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
        className={`${composerTabRail} w-full disabled:hover:text-fg-muted`}
      >
        <span
          role="status"
          aria-label="Working"
          title="Working"
          className="ari-status"
          data-status="working"
        />
        <span className="min-w-0 truncate font-medium text-fg">
          {providerLabel ? `${providerLabel} · ` : ''}
          {summary}
        </span>
        <span className="ms-auto flex shrink-0 items-center gap-2 text-fg-subtle">
          {oldest !== null ? <ElapsedSeconds startedAt={oldest} /> : null}
          {rows.length > 0 ? (
            <ChevronRight
              size={14}
              aria-hidden
              className={`shrink-0 transition-transform duration-150 ${open ? '-rotate-90' : ''}`}
            />
          ) : null}
        </span>
      </button>
    </div>
  )
}

function TaskRow({ task }: { task: BackgroundTask }) {
  const running = task.status === 'running'
  const shell = task.kind === 'shell'
  // A shell's end is rarely reported, so a running one is described by when
  // it started rather than claimed to be busy.
  const detail = task.detail ?? (running && shell ? 'Started in background' : null)
  return (
    <li className={composerTabRow}>
      <span aria-hidden className="ari-status" data-status={STATUS_GLYPH[task.status]} />
      <span
        className={`min-w-0 shrink truncate text-fg ${shell ? 'font-mono text-[12.5px]' : ''}`}
        title={task.label}
      >
        {task.label || (shell ? 'Shell command' : 'Sub-agent')}
      </span>
      <span className="min-w-0 flex-1 truncate text-fg-muted" title={detail ?? undefined}>
        {detail !== null ? (running && !shell ? `▸ ${detail}` : detail) : null}
      </span>
      <span className="flex shrink-0 items-center gap-2 text-fg-subtle">
        <span>{statusWord(task)}</span>
        {running ? (
          <ElapsedSeconds startedAt={task.startedAt} />
        ) : task.endedAt !== null ? (
          <span className="tabular-nums">
            {formatElapsed(Math.max(0, Math.floor((task.endedAt - task.startedAt) / 1000)))}
          </span>
        ) : null}
      </span>
    </li>
  )
}

/** The glyph carries the tone; the word beside the time only names it. */
function statusWord(task: BackgroundTask): string {
  switch (task.status) {
    case 'running':
      return task.kind === 'subagent' ? 'working' : 'in background'
    case 'completed':
      return 'done'
    case 'failed':
      return 'failed'
    case 'stopped':
      return 'stopped'
  }
}
