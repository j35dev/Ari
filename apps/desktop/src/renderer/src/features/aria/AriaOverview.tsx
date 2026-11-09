import { useEffect, useState, type JSX } from 'react'
import type { RpcResults, SessionEventFrame } from '@ari/contracts/rpc'
import { createLogger } from '@ari/shared/logger'
import { rpc } from '../../lib/rpc'
import { formatRelativeTime } from '../../shell/Sidebar'
import { useTickingText } from '../moment/shared-clock'

type Overview = RpcResults['aria.overview']
type Section = 'needsYou' | 'running' | 'doneToday'
type Row = Overview[Section][number]

const log = createLogger('renderer:aria-overview')
const SECTIONS = [
  ['needsYou', 'Needs you'],
  ['running', 'Running'],
  ['doneToday', 'Done today'],
] as const
const REFRESH_EVENTS = new Set([
  'session.created',
  'session.updated',
  'user.message.added',
  'turn.started',
  'turn.settled',
  'message.enqueued',
  'message.dequeued',
  'approval.requested',
  'approval.responded',
  'input.requested',
  'input.responded',
])

function Age({ at }: { at: number }) {
  const ref = useTickingText<HTMLSpanElement>((now) => formatRelativeTime(at, now), at)
  return <span ref={ref}>now</span>
}

function OverviewRow({ row, onOpen }: { row: Row; onOpen: (id: string) => void }) {
  const needsYou = 'kind' in row
  const done = 'report' in row
  const state = needsYou
    ? 'Needs you'
    : done
      ? 'Done'
      : row.state === 'queued'
        ? 'Queued'
        : 'Working'
  const tone = needsYou
    ? 'bg-warning'
    : done
      ? 'bg-success'
      : row.state === 'queued'
        ? 'bg-fg-subtle'
        : 'bg-busy'
  return (
    <button
      type="button"
      onClick={() => onOpen(row.sessionId)}
      title={
        needsYou
          ? row.summary
          : 'startedByAria' in row && row.startedByAria
            ? 'Started by Aria'
            : undefined
      }
      className="flex h-7 w-full min-w-0 items-center gap-2 rounded-md pl-2 pr-1 text-left text-[13px] text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
    >
      <span className={`size-1.5 shrink-0 rounded-full ${tone}`} role="img" aria-label={state} />
      <span className="min-w-0 flex-1 truncate">
        <span className="text-fg">{row.title}</span>
        {done && row.report ? (
          <span className="ml-2 text-xs text-fg-subtle">{row.report}</span>
        ) : null}
      </span>
      <span className="max-w-[25%] truncate text-2xs text-fg-subtle">
        {row.projectName ?? row.projectId}
      </span>
      <span className="min-w-11 shrink-0 text-right text-2xs tabular-nums text-fg-subtle">
        {needsYou ? row.kind : <Age at={done ? row.settledAt : (row.startedAt ?? row.updatedAt)} />}
      </span>
    </button>
  )
}

export function AriaOverview(props: {
  sessionId: string
  onOpenSession: (id: string) => void
}): JSX.Element | null {
  const [overview, setOverview] = useState<Overview | null>(null)
  const [expanded, setExpanded] = useState<Partial<Record<Section, boolean>>>({})

  useEffect(() => {
    let disposed = false
    let request = 0
    let pending: ReturnType<typeof setTimeout> | undefined
    setOverview(null)
    setExpanded({})
    const refresh = (): void => {
      const current = ++request
      void rpc
        .invoke('aria.overview', { sessionId: props.sessionId })
        .then((result) => {
          if (!disposed && current === request) setOverview(result)
        })
        .catch((error: unknown) => log.warn('rpc call failed', error))
    }
    const unsubscribe = rpc.subscribe('session.events', {}, (payload) => {
      const frame = payload as Partial<SessionEventFrame> | null
      if (frame?.replay || frame?.replayDone) return
      const type = (frame?.event as { type?: string } | undefined)?.type
      if (!type || (!REFRESH_EVENTS.has(type) && !type.startsWith('child.session.'))) return
      // Coalesce bursts without postponing the fetch while several workers settle.
      if (pending !== undefined) return
      pending = setTimeout(() => {
        pending = undefined
        refresh()
      }, 250)
    })
    refresh()
    return () => {
      disposed = true
      if (pending !== undefined) clearTimeout(pending)
      unsubscribe()
    }
  }, [props.sessionId])

  if (!overview || SECTIONS.every(([key]) => overview[key].length === 0)) return null
  return (
    <div className="max-h-[40vh] shrink-0 overflow-y-auto px-3 py-1" aria-label="Aria overview">
      {SECTIONS.map(([key, label]) => {
        const rows = overview[key]
        if (rows.length === 0) return null
        const open = expanded[key] === true
        const remaining = (open ? 0 : Math.max(0, rows.length - 5)) + overview.more[key]
        return (
          <section key={key} aria-label={label} className="mb-1 last:mb-0">
            <h2 className="px-2 py-1 text-2xs font-medium text-fg-subtle">{label}</h2>
            {(open ? rows : rows.slice(0, 5)).map((row) => (
              <OverviewRow
                key={
                  'requestId' in row
                    ? `${row.sessionId}:${row.kind}:${row.requestId}`
                    : row.sessionId
                }
                row={row}
                onOpen={props.onOpenSession}
              />
            ))}
            {remaining > 0 ? (
              open ? (
                <span className="block px-2 py-1 text-2xs text-fg-subtle">+{remaining} more</span>
              ) : (
                <button
                  type="button"
                  aria-label={`Show more ${label.toLowerCase()}`}
                  aria-expanded={false}
                  onClick={() => setExpanded((value) => ({ ...value, [key]: true }))}
                  className="rounded-md px-2 py-1 text-2xs text-fg-subtle hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
                >
                  +{remaining} more
                </button>
              )
            ) : null}
          </section>
        )
      })}
    </div>
  )
}
