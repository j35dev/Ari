import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Gauge, LoaderCircle, Search, Settings, SquarePen } from 'lucide-react'
import type { SessionSummary } from '@ari/contracts/rpc'
import { ConnectionStrip } from '../../components/ConnectionStrip'
import { EmptyState } from '../../components/EmptyState'
import { useApp } from '../../lib/app-state'
import { connectionLabel, relativeTime } from '../../lib/format'
import { usePullToRefresh } from '../../lib/pull-to-refresh'
import { isRunning, shelve, type ShelfRow } from '../../lib/shelves'
import { useAttention } from '../../lib/use-attention'
import { UsageSheet } from '../usage/UsageSheet'
import { SessionActions } from './SessionActions'
import { ComputerButton } from '../computers/ComputerSwitcher'

const HOLD_MS = 480

/** Every session on the paired computer, the ones waiting on the user first. */
export function HomeScreen({
  onOpen,
  onNewSession,
  onSettings,
}: {
  onOpen: (sessionId: string) => void
  onNewSession: () => void
  onSettings: () => void
}): ReactNode {
  const app = useApp()
  const attention = useAttention()
  const [projectId, setProjectId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [archived, setArchived] = useState(false)
  const [acting, setActing] = useState<SessionSummary | null>(null)
  const [usage, setUsage] = useState(false)
  const { pull, ready, handlers } = usePullToRefresh(() => void app.refresh())
  // Coming back from a session shows what changed while it was open, not the
  // list as it was up to fifteen seconds ago.
  const { refresh } = app
  useEffect(() => {
    void refresh()
  }, [refresh])
  const shelves = useMemo(
    () =>
      shelve(app.sessions, attention.items, { projectId, query, projects: app.projects, archived }),
    [app.sessions, app.projects, attention.items, projectId, query, archived],
  )
  // Most recently active first, so the project in hand is the nearest chip.
  const projects = useMemo(() => {
    const latest = (id: string): number =>
      Math.max(0, ...app.sessions.filter((s) => s.projectId === id).map((s) => s.updatedAt))
    return [...app.projects].sort((a, b) => latest(b.id) - latest(a.id))
  }, [app.projects, app.sessions])
  const connected = app.connection === 'connected'
  const hostname = app.origin === null ? null : new URL(app.origin).hostname
  const host =
    app.activeComputer?.name ??
    (hostname === null
      ? 'No computer'
      : ['localhost', '127.0.0.1', '[::1]'].includes(hostname)
        ? 'This computer'
        : (hostname.split('.')[0] ?? hostname))
  const canCreate = connected && app.session?.supports('session.create') === true
  const hasArchived = app.sessions.some((session) => session.archived === true)
  const filtered = projectId !== null || query.trim() !== ''
  return (
    <div className="relative flex h-full flex-col">
      <header className="flex shrink-0 items-center justify-between gap-3 px-5 pb-2 pt-[max(0.75rem,env(safe-area-inset-top))]">
        <span className="text-[22px] font-semibold tracking-[-0.06em]">
          ari<span className="text-accent">.</span>
        </span>
        <div className="flex min-w-0 items-center gap-1">
          {connected && app.session?.supports('usage.allowance') === true && (
            <button
              type="button"
              className="icon-button -mr-2 text-fg-muted"
              aria-label="Usage"
              onClick={() => setUsage(true)}
            >
              <Gauge size={19} />
            </button>
          )}
          <button
            type="button"
            className="icon-button text-fg-muted"
            aria-label="Settings"
            onClick={onSettings}
          >
            <Settings size={19} />
          </button>
        </div>
      </header>
      <div className="shrink-0 px-5 pb-3">
        <ComputerButton />
        <div className="mt-4 flex items-baseline justify-between gap-3">
          <h1 className="text-[24px] font-semibold tracking-tight">Sessions</h1>
          <span
            role="status"
            aria-label={`${host}, ${connectionLabel(app.connection)}`}
            className="text-xs text-fg-subtle"
          >
            {connectionLabel(app.connection)}
          </span>
        </div>
      </div>
      <ConnectionStrip detail="Agents keep working on the computer" />
      <div
        data-testid="home-scroll"
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-[calc(7rem+env(safe-area-inset-bottom))]"
        {...handlers}
      >
        <div
          aria-hidden
          className="flex items-center justify-center overflow-hidden text-fg-subtle"
          style={{ height: app.refreshing ? 36 : pull }}
        >
          <LoaderCircle
            size={18}
            className={app.refreshing ? 'animate-spin' : ''}
            style={{
              transform: `rotate(${pull * 4}deg)`,
              opacity: ready || app.refreshing ? 1 : 0.5,
            }}
          />
        </div>
        <label className="flex items-center gap-2 rounded-full bg-surface-1 px-4">
          <Search size={16} className="shrink-0 text-fg-subtle" />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search"
            aria-label="Search sessions"
            className="h-11 min-w-0 flex-1 bg-transparent placeholder:text-fg-subtle"
          />
        </label>
        {projects.length > 1 && (
          <div
            role="group"
            aria-label="Project"
            className="no-scrollbar -mx-5 mt-3 flex gap-2 overflow-x-auto px-5"
          >
            {[{ id: null, name: 'All' }, ...projects].map((project) => (
              <button
                key={project.id ?? 'all'}
                type="button"
                aria-pressed={projectId === project.id}
                onClick={() => setProjectId(project.id)}
                className="control-chip shrink-0 aria-pressed:bg-fg aria-pressed:text-bg"
              >
                {project.name}
              </button>
            ))}
          </div>
        )}
        {(attention.failure ?? app.error) !== null && (
          <p role="alert" className="error-banner">
            {attention.failure ?? app.error}
          </p>
        )}
        {shelves.length === 0 && (
          <EmptyState
            title={
              filtered ? 'Nothing matches' : !connected ? 'Computer unavailable' : 'No sessions yet'
            }
            detail={
              filtered
                ? 'Try another project or a different search.'
                : !connected
                  ? 'Reconnect to load sessions. Your agents and workspace stay on this computer.'
                  : 'Start one here. The agent works on your computer while you keep an eye on it from your phone.'
            }
            action={
              !filtered && (
                <button
                  type="button"
                  className="primary-button"
                  onClick={onNewSession}
                  disabled={!canCreate}
                >
                  Start a session
                </button>
              )
            }
          />
        )}
        {shelves.map((shelf) => (
          <section key={shelf.id} aria-labelledby={`shelf-${shelf.id}`} className="mt-6">
            <h2
              id={`shelf-${shelf.id}`}
              className={`mb-1 text-xs font-medium ${shelf.id === 'needs-you' ? 'text-warning' : 'text-fg-subtle'}`}
            >
              {shelf.title}
              <span aria-hidden className="ml-2 tabular-nums text-fg-subtle">
                {shelf.rows.length}
              </span>
            </h2>
            <ul>
              {shelf.rows.map((row) => (
                <Row
                  key={row.session.id}
                  row={row}
                  stale={!connected}
                  project={
                    projectId === null
                      ? (app.projects.find((entry) => entry.id === row.session.projectId)?.name ??
                        null)
                      : null
                  }
                  onOpen={onOpen}
                  onHold={setActing}
                />
              ))}
            </ul>
          </section>
        ))}
        {hasArchived && (
          <button
            type="button"
            className="mt-6 min-h-11 text-xs text-fg-subtle"
            onClick={() => setArchived((shown) => !shown)}
          >
            {archived ? 'Hide archived' : 'Show archived'}
          </button>
        )}
      </div>
      <button
        type="button"
        aria-label="New chat"
        onClick={onNewSession}
        disabled={!canCreate}
        className="absolute bottom-[max(1.25rem,env(safe-area-inset-bottom))] right-5 flex min-h-13 items-center justify-center gap-2 rounded-full bg-accent px-5 text-sm font-medium text-fg-on-accent shadow-[var(--ari-shadow-2)] disabled:opacity-40"
      >
        <SquarePen size={22} />
        New chat
      </button>
      {acting !== null && <SessionActions session={acting} onClose={() => setActing(null)} />}
      {usage && <UsageSheet onClose={() => setUsage(false)} />}
    </div>
  )
}

const Row = memo(function Row({
  row,
  project,
  stale,
  onOpen,
  onHold,
}: {
  row: ShelfRow
  project: string | null
  /** The computer is out of reach: this is the last state it reported. */
  stale: boolean
  onOpen: (sessionId: string) => void
  onHold: (session: ShelfRow['session']) => void
}): ReactNode {
  const { session, ask, agents, parentTitle, state } = row
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const held = useRef(false)
  const cancel = (): void => {
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = null
  }
  const delegating = agents !== undefined && agents.working > 0
  /** The session's own turn is executing, as opposed to only its agents'. */
  const selfRunning = state === 'running' && isRunning(session)
  const plural = (count: number): string => `${count} agent${count === 1 ? '' : 's'}`
  const detail = [
    project,
    parentTitle === undefined ? null : `Agent of ${parentTitle || 'a session'}`,
    state === 'stalled'
      ? 'Not responding'
      : state === 'failed'
        ? `Failed ${relativeTime(session.updatedAt)}`
        : selfRunning
          ? stale
            ? 'Was working'
            : 'Working'
          : delegating
            ? `${agents.working} of ${plural(agents.total)} working`
            : relativeTime(session.updatedAt),
    agents === undefined
      ? null
      : selfRunning && delegating
        ? `${plural(agents.working)} working`
        : delegating
          ? null
          : plural(agents.total),
  ]
    .filter((part) => part !== null)
    .join(' · ')
  // What a running agent is doing, in its own latest words.
  const doing =
    selfRunning && session.lastMessagePreview
      ? session.lastMessagePreview.replace(/\s+/g, ' ').trim()
      : null
  return (
    <li className="[contain-intrinsic-size:auto_64px] [content-visibility:auto]">
      <button
        type="button"
        aria-label={`Open ${session.title || 'Untitled session'}`}
        aria-haspopup="menu"
        className="flex min-h-16 w-full select-none items-center gap-3 py-2.5 text-left [-webkit-touch-callout:none]"
        onClick={() => {
          // A hold has already opened the menu; the release must not also open the session.
          if (held.current) held.current = false
          else onOpen(session.id)
        }}
        onContextMenu={(event) => {
          event.preventDefault()
          cancel()
          onHold(session)
        }}
        onTouchStart={() => {
          held.current = false
          timer.current = setTimeout(() => {
            held.current = true
            onHold(session)
          }, HOLD_MS)
        }}
        onTouchMove={cancel}
        onTouchEnd={cancel}
        onTouchCancel={cancel}
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[16px] font-medium tracking-tight">
            {session.title || 'Untitled session'}
          </span>
          {ask !== null ? (
            <span className="mt-0.5 line-clamp-2 block text-[13px] leading-snug text-fg-muted">
              {parentTitle === undefined ? ask : `Agent of ${parentTitle || 'a session'} · ${ask}`}
            </span>
          ) : (
            <>
              {doing !== null && (
                <span className="mt-0.5 block truncate text-[13px] text-fg-muted">{doing}</span>
              )}
              <span
                className={`mt-0.5 block truncate text-xs ${state === 'failed' ? 'text-danger' : state === 'stalled' ? 'text-warning' : 'text-fg-subtle'}`}
              >
                {detail}
              </span>
            </>
          )}
        </span>
        {state !== 'idle' && state !== 'failed' && (
          <span
            aria-hidden
            className={`size-2 shrink-0 rounded-full ${
              stale
                ? 'bg-fg-subtle'
                : state === 'needs-you'
                  ? 'bg-warning'
                  : state === 'stalled'
                    ? 'border border-warning'
                    : 'status-pulse bg-success'
            }`}
          />
        )}
      </button>
    </li>
  )
})
