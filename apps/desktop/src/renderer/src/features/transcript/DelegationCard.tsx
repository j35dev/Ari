import { useId, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { ProviderLogo } from '../composer/provider-logo'
import { useTickingText } from '../moment'
import { agentModelLabel } from './agent-label'
import { delegationPhrases, isLiveChild, splitDelegation } from './delegation-rows'
import { reportSnippet } from './report-snippet'
import type { DelegatedChild, DelegatedChildState, DelegationRow } from './types'
import { DelegatedResult, RESULT_SLOT } from './DelegatedResult'

const STATE_LABEL: Record<DelegatedChildState, string> = {
  working: 'Working',
  queued: 'Queued',
  'needs-lead': 'Needs lead',
  starting: 'Starting',
  stopping: 'Stopping',
  unknown: 'Activity unknown',
  'needs-you': 'Needs you',
  waiting: 'Waiting on its children',
  done: 'Result ready',
  failed: 'Failed',
  stopped: 'Interrupted',
  idle: 'Idle',
  removed: 'Removed',
}

/** The shared status glyph (styles/frame.css) each state draws. */
const STATE_GLYPH: Record<DelegatedChildState, string> = {
  working: 'working',
  stopping: 'working',
  waiting: 'working',
  queued: 'queued',
  starting: 'queued',
  'needs-you': 'attention',
  'needs-lead': 'attention',
  done: 'done',
  failed: 'error',
  stopped: 'stopped',
  idle: 'idle',
  unknown: 'idle',
  removed: 'idle',
}

/** Provider tiles shown in a group row; one per provider, not one per agent. */
const MAX_TILES = 3

function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
}

/** Repaints on the shared clock; a running child never re-renders the card. */
function Elapsed({ startedAt }: { startedAt: number }) {
  const ref = useTickingText<HTMLSpanElement>((now) => formatElapsed(now - startedAt), startedAt)
  return (
    <span ref={ref} className="tabular-nums">
      0s
    </span>
  )
}

/** The model on its own: the provider is already shown as a mark beside it. */
function modelName(child: DelegatedChild): string {
  const label = agentModelLabel(child.driverKind, child.modelId)
  const split = label.indexOf(' · ')
  return split === -1 ? label : label.slice(split + 3)
}

/**
 * One agent as one line: the status glyph, its title, then what it is doing or
 * what it reported in plain words, and at the right its provider and model.
 */
function ChildRow({ child, onOpen }: { child: DelegatedChild; onOpen?: (id: string) => void }) {
  const removed = child.state === 'removed'
  const openable = !removed && onOpen !== undefined
  const settled = child.state === 'done' || child.state === 'failed' || child.state === 'stopped'
  const said = settled && child.report ? reportSnippet(child.report) : ''
  const role = child.role && child.role !== 'general' ? child.role : null
  const body = (
    <>
      <span className="ari-status" data-status={STATE_GLYPH[child.state]} aria-hidden="true" />
      <span
        className={`max-w-[42%] shrink-0 truncate ${
          removed ? 'text-fg-subtle' : 'font-medium text-fg'
        }`}
      >
        {child.title}
      </span>
      <span
        className={`min-w-0 flex-1 truncate ${
          child.state === 'needs-you'
            ? 'text-accent'
            : said === ''
              ? 'text-fg-subtle'
              : 'text-fg-muted'
        }`}
      >
        {said === '' ? STATE_LABEL[child.state] : said}
      </span>
      <span
        className="flex min-w-0 max-w-[30%] shrink-0 items-center gap-1.5 text-xs text-fg-subtle"
        title={role === null ? undefined : `${role} agent`}
      >
        <span className="flex shrink-0 opacity-70 [&>span]:bg-transparent" aria-hidden="true">
          <ProviderLogo kind={child.driverKind} size={12} />
        </span>
        <span className="min-w-0 truncate">{modelName(child)}</span>
      </span>
    </>
  )
  const className =
    'flex h-8 min-w-0 flex-1 items-center gap-2.5 rounded-md text-left text-[13.5px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-ring'
  return openable ? (
    <button
      type="button"
      onClick={() => onOpen(child.sessionId)}
      aria-label={`Open ${child.title}: ${STATE_LABEL[child.state]}`}
      className={`${className} -mx-1.5 px-1.5 transition-colors hover:bg-fg/5`}
    >
      {body}
    </button>
  ) : (
    <div className={className}>{body}</div>
  )
}

/**
 * One agent's line and its trailing slot: the result action once there is a
 * result, the running time while it works, and the same width left empty
 * otherwise, so the model column lines up down the list. An opened result
 * drops to the line below.
 */
function ChildItem({
  child,
  sessionId,
  onOpen,
}: {
  child: DelegatedChild
  sessionId?: string
  onOpen?: (id: string) => void
}) {
  const slot = (
    <span className={`flex h-7 shrink-0 items-center px-2 text-xs text-fg-subtle ${RESULT_SLOT}`}>
      {child.state === 'working' && child.startedAt !== null ? (
        <Elapsed startedAt={child.startedAt} />
      ) : null}
    </span>
  )
  return (
    <li className="flex flex-wrap items-center gap-x-1">
      <ChildRow child={child} onOpen={onOpen} />
      {sessionId ? (
        <DelegatedResult
          key={`${sessionId}:${child.sessionId}`}
          sessionId={sessionId}
          child={child}
          placeholder={slot}
        />
      ) : (
        slot
      )}
    </li>
  )
}

/**
 * The children a turn delegated to, in place in the transcript. Several agents
 * are one row: a tile per provider, the count, and how it is going in words,
 * with the part that needs the user in the accent. Opening the row lists each
 * agent on the step hairline: who is doing what, what each reported, and its
 * result to open. A single delegated agent is that one line outright.
 *
 * The row counts the agents that are running or finished recently. Removed
 * sessions and long-finished work wait behind "Show N earlier agents".
 */
export function DelegationCard({
  row,
  onOpenSession,
  sessionId,
}: {
  row: DelegationRow
  onOpenSession?: (id: string) => void
  sessionId?: string
}) {
  const [open, setOpen] = useState(false)
  const [earlierOpen, setEarlierOpen] = useState(false)
  const listId = useId()
  const earlierId = useId()
  const { current, earlier } = splitDelegation(row.children, Date.now())
  const live = current.some(isLiveChild)
  const grouped = current.length > 1
  const providers = [...new Set(current.map((child) => child.driverKind))]
  // The group has been running since its longest-running child started.
  const startedAt = current.reduce<number | null>(
    (earliest, child) =>
      child.state === 'working' && child.startedAt !== null
        ? Math.min(earliest ?? child.startedAt, child.startedAt)
        : earliest,
    null,
  )
  return (
    <div className="ari-burst my-1" data-activity={live ? 'working' : 'settled'}>
      {grouped ? (
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          aria-controls={listId}
          className="group -mx-1.5 flex h-10 w-[calc(100%+0.75rem)] min-w-0 items-center gap-2.5 rounded-md px-1.5 text-left text-sm text-fg-muted transition-colors hover:bg-fg/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
        >
          <span className="flex shrink-0" aria-hidden="true">
            {providers.slice(0, MAX_TILES).map((kind, index) => (
              <span
                key={kind}
                className={`grid size-[22px] place-items-center rounded-full bg-surface-2 ring-2 ring-bg [&>span]:bg-transparent ${
                  index > 0 ? '-ml-1.5' : ''
                }`}
              >
                <ProviderLogo kind={kind} size={12} />
              </span>
            ))}
          </span>
          <span className="shrink-0 font-medium text-fg">{current.length} agents</span>
          <span className="min-w-0 truncate">
            {delegationPhrases(current).map(({ state, phrase }, index) => (
              <span key={state}>
                {index > 0 ? ', ' : null}
                <span className={state === 'needs-you' ? 'text-accent' : undefined}>{phrase}</span>
              </span>
            ))}
          </span>
          <span className="ml-auto flex shrink-0 items-center gap-2 text-[13px] text-fg-subtle">
            {startedAt !== null ? <Elapsed startedAt={startedAt} /> : null}
            <ChevronRight
              size={14}
              aria-hidden="true"
              className={`transition-[color,transform] duration-150 group-hover:text-fg motion-reduce:transition-none ${open ? 'rotate-90' : ''}`}
            />
          </span>
        </button>
      ) : null}
      <div
        id={listId}
        hidden={grouped && !open}
        className={
          grouped ? 'ari-burst-steps mb-1 ml-[9px] border-l border-border-strong pl-5' : undefined
        }
      >
        <ul role="list" aria-label="Delegated sessions">
          {current.map((child) => (
            <ChildItem
              key={child.sessionId}
              child={child}
              sessionId={sessionId}
              onOpen={onOpenSession}
            />
          ))}
        </ul>
        {earlier.length > 0 ? (
          <>
            <button
              type="button"
              onClick={() => setEarlierOpen((value) => !value)}
              aria-expanded={earlierOpen}
              aria-controls={earlierId}
              className="group flex h-8 items-center gap-1.5 rounded-md text-[13px] text-fg-subtle transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
            >
              {earlierOpen ? 'Hide' : 'Show'} {earlier.length} earlier{' '}
              {earlier.length === 1 ? 'agent' : 'agents'}
              <ChevronRight
                size={13}
                aria-hidden="true"
                className={`transition-transform duration-150 motion-reduce:transition-none ${earlierOpen ? 'rotate-90' : ''}`}
              />
            </button>
            <ul
              id={earlierId}
              role="list"
              aria-label="Earlier delegated sessions"
              hidden={!earlierOpen}
            >
              {earlier.map((child) => (
                <ChildItem
                  key={child.sessionId}
                  child={child}
                  sessionId={sessionId}
                  onOpen={onOpenSession}
                />
              ))}
            </ul>
          </>
        ) : null}
      </div>
    </div>
  )
}
