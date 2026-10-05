import { useMemo, useRef, useState, type ReactNode } from 'react'
import { LoaderCircle, Search, Settings, SquarePen } from 'lucide-react'
import type { SessionSummary } from '@ari/contracts/rpc'
import { EmptyState } from '../../components/EmptyState'
import { useApp } from '../../lib/app-state'
import { connectionLabel, relativeTime } from '../../lib/format'
import { usePullToRefresh } from '../../lib/pull-to-refresh'
import { shelve, type ShelfRow } from '../../lib/shelves'
import { useAttention } from '../../lib/use-attention'
import { SessionActions } from './SessionActions'

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
  const { pull, ready, handlers } = usePullToRefresh(() => void app.refresh())
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
    hostname === null
      ? 'No computer'
      : ['localhost', '127.0.0.1', '[::1]'].includes(hostname)
        ? 'This computer'
        : (hostname.split('.')[0] ?? hostname)
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
          <span
            role="status"
            aria-label={`${host}, ${connectionLabel(app.connection)}`}
            className="flex min-w-0 items-center gap-2 text-xs text-fg-muted"
          >
            <span
              className={`size-1.5 shrink-0 rounded-full ${connected ? 'bg-success' : 'bg-warning'}`}
            />
            <span className="truncate">{host}</span>
          </span>
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
      {!connected && (
        <div
          role="status"
          className="mx-5 mb-2 flex shrink-0 items-center gap-3 rounded-xl bg-warning-subtle px-3 text-xs"
        >
          <span className="flex-1 py-2">
            {connectionLabel(app.connection)}. Your agents keep working on the computer.
          </span>
          <button
            type="button"
            className="min-h-11 font-medium"
            onClick={() => void app.reconnect()}
          >
            Retry
          </button>
        </div>
      )}
      <div
        data-testid="home-scroll"
        className="min-h-0 flex-1 overflow-y-auto px-5 pb-28"
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
            title={filtered ? 'Nothing matches' : 'No sessions yet'}
            detail={
              filtered
                ? 'Try another project or a different search.'
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
            </h2>
            <ul>
              {shelf.rows.map((row) => (
                <Row
                  key={row.session.id}
                  row={row}
                  project={
                    projectId === null
                      ? (app.projects.find((entry) => entry.id === row.session.projectId)?.name ??
                        null)
                      : null
                  }
                  onOpen={() => onOpen(row.session.id)}
                  onHold={() => setActing(row.session)}
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
        className="absolute bottom-[max(1.25rem,env(safe-area-inset-bottom))] right-5 flex size-14 items-center justify-center rounded-full bg-accent text-fg-on-accent shadow-[var(--ari-shadow-2)] disabled:opacity-40"
      >
        <SquarePen size={22} />
      </button>
      {acting !== null && <SessionActions session={acting} onClose={() => setActing(null)} />}
    </div>
  )
}

function Row({
  row,
  project,
  onOpen,
  onHold,
}: {
  row: ShelfRow
  project: string | null
  onOpen: () => void
  onHold: () => void
}): ReactNode {
  const { session, ask } = row
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const held = useRef(false)
  const cancel = (): void => {
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = null
  }
  const running = session.status === 'running'
  const detail = [project, running ? 'Working' : relativeTime(session.updatedAt)]
    .filter((part) => part !== null)
    .join(' · ')
  return (
    <li>
      <button
        type="button"
        aria-label={`Open ${session.title || 'Untitled session'}`}
        aria-haspopup="menu"
        className="flex min-h-16 w-full select-none items-center gap-3 py-2.5 text-left [-webkit-touch-callout:none]"
        onClick={() => {
          // A hold has already opened the menu; the release must not also open the session.
          if (held.current) held.current = false
          else onOpen()
        }}
        onContextMenu={(event) => {
          event.preventDefault()
          cancel()
          onHold()
        }}
        onTouchStart={() => {
          held.current = false
          timer.current = setTimeout(() => {
            held.current = true
            onHold()
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
              {ask}
            </span>
          ) : (
            <span className="mt-0.5 block truncate text-xs text-fg-subtle">{detail}</span>
          )}
        </span>
        {(running || ask !== null) && (
          <span
            aria-hidden
            className={`size-2 shrink-0 rounded-full ${ask !== null ? 'bg-warning' : 'status-pulse bg-success'}`}
          />
        )}
      </button>
    </li>
  )
}
