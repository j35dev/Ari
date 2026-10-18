import { useEffect, useState } from 'react'
import { ChevronRight, GitBranch } from 'lucide-react'
import { SessionActivityMark } from '../moment'
import type { SessionActivity } from '../session/session-activity'
import { summarizeDelegation } from './delegation-rows'
import type { DelegatedChild, DelegatedChildState, DelegationRow } from './types'

const STATE_LABEL: Record<DelegatedChildState, string> = {
  working: 'Working',
  'needs-you': 'Needs you',
  waiting: 'Waiting on its children',
  done: 'Done',
  failed: 'Failed',
  stopped: 'Stopped',
  idle: 'Idle',
  removed: 'Removed',
}

const STATE_TONE: Record<DelegatedChildState, string> = {
  working: 'text-fg',
  'needs-you': 'text-warning',
  waiting: 'text-fg-muted',
  done: 'text-fg-muted',
  failed: 'text-danger',
  stopped: 'text-fg-subtle',
  idle: 'text-fg-subtle',
  removed: 'text-fg-subtle',
}

/** The sidebar's activity mark for the states it has one for. */
function markFor(state: DelegatedChildState, startedAt: number | null): SessionActivity | null {
  if (state === 'working') return { phase: 'working', startedAt }
  if (state === 'needs-you') return { phase: 'paused', startedAt }
  if (state === 'done') return { phase: 'done', startedAt: null }
  if (state === 'failed') return { phase: 'error', startedAt: null }
  return null
}

function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
}

function Elapsed({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  return <span className="tabular-nums">{formatElapsed(now - startedAt)}</span>
}

function ChildRow({
  child,
  onOpen,
}: {
  child: DelegatedChild
  onOpen?: (id: string) => void
}) {
  const mark = markFor(child.state, child.startedAt)
  const openable = child.state !== 'removed' && onOpen !== undefined
  const model = child.modelId ? `${child.driverKind} · ${child.modelId}` : child.driverKind
  const settled = child.state === 'done' || child.state === 'failed' || child.state === 'stopped'
  const body = (
    <>
      <span className="flex min-w-0 items-center gap-2">
        <span className="flex size-2.5 shrink-0 items-center justify-center">
          {mark ? (
            <SessionActivityMark activity={mark} />
          ) : (
            <span aria-hidden className="size-1 rounded-[1px] bg-fg-subtle/50" />
          )}
        </span>
        <span className="min-w-0 truncate text-xs text-fg">{child.title}</span>
        {child.role && child.role !== 'general' ? (
          <span className="shrink-0 rounded-sm border border-border px-1 font-mono text-2xs text-fg-subtle">
            {child.role}
          </span>
        ) : null}
        <span className="min-w-0 flex-1 truncate font-mono text-2xs text-fg-subtle">{model}</span>
        <span className={`shrink-0 font-mono text-2xs ${STATE_TONE[child.state]}`}>
          {STATE_LABEL[child.state]}
          {child.state === 'working' && child.startedAt !== null ? (
            <>
              {' '}
              <Elapsed startedAt={child.startedAt} />
            </>
          ) : null}
        </span>
        {openable ? (
          <ChevronRight
            size={12}
            aria-hidden="true"
            className="shrink-0 text-fg-subtle opacity-40 transition-opacity group-hover:opacity-100"
          />
        ) : null}
      </span>
      {settled && child.report ? (
        <span className="mt-0.5 block truncate pl-[18px] text-2xs text-fg-muted">
          {child.report.replace(/\s+/g, ' ')}
        </span>
      ) : null}
    </>
  )
  const className =
    'group block w-full rounded-md px-1 py-[3px] text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-ring'
  return openable ? (
    <button
      type="button"
      onClick={() => onOpen(child.sessionId)}
      aria-label={`Open ${child.title}: ${STATE_LABEL[child.state]}`}
      className={`${className} hover:bg-surface-1/70`}
    >
      {body}
    </button>
  ) : (
    <div className={className}>{body}</div>
  )
}

/**
 * The children a turn delegated to, in place in the transcript: who is doing
 * what, how it is going, and what each reported. The rail is live while any of
 * them is running, so the eye finds unfinished work the same way it finds an
 * unfinished activity burst.
 */
export function DelegationCard({
  row,
  onOpenSession,
}: {
  row: DelegationRow
  onOpenSession?: (id: string) => void
}) {
  const live = row.children.some(
    (child) => child.state === 'working' || child.state === 'needs-you',
  )
  return (
    <div className="ari-burst my-1 pl-3" data-activity={live ? 'working' : 'settled'}>
      {row.children.length > 1 ? (
        <p className="flex items-center gap-2 px-1 py-[3px] text-xs text-fg-subtle">
          <GitBranch size={11} aria-hidden="true" className="shrink-0 text-accent" />
          <span className="text-fg-muted">Delegated to {row.children.length} sessions</span>
          <span className="font-mono text-2xs">{summarizeDelegation(row.children)}</span>
        </p>
      ) : null}
      <ul role="list" aria-label="Delegated sessions">
        {row.children.map((child) => (
          <li key={child.sessionId}>
            <ChildRow child={child} onOpen={onOpenSession} />
          </li>
        ))}
      </ul>
    </div>
  )
}
