import { useEffect, useMemo, useState, type MouseEvent, type ReactNode } from 'react'
import type { SessionSummary } from '@ari/contracts/rpc'
import { useApp } from '../../lib/app-state'
import { relativeTime } from '../../lib/format'

/**
 * Sessions: search, project grouping, history (ADR §13).
 *
 * Grouped by project rather than by date, because a user looking for work they
 * started reaches for the project first — and the phone only ever holds the
 * projects the desktop granted it.
 */
type SessionFilter = 'all' | 'active' | 'pinned' | 'archived'

const PINNED_KEY = 'ari.mobile.pinnedSessions'

function readPinned(): Set<string> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(PINNED_KEY) ?? '[]')
    if (Array.isArray(parsed)) {
      return new Set(parsed.filter((entry): entry is string => typeof entry === 'string'))
    }
  } catch {
    // A corrupt entry is forgotten, not fatal.
  }
  return new Set()
}

function writePinned(set: Set<string>): void {
  try {
    localStorage.setItem(PINNED_KEY, JSON.stringify([...set]))
  } catch {
    // ignore
  }
}

function formatSessionTime(timestamp: number): string {
  const d = new Date(timestamp)
  const now = new Date()
  const isToday = d.toDateString() === now.toDateString()
  if (isToday) {
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  }
  return relativeTime(timestamp)
}

export function SessionsScreen({ onOpen }: { onOpen: (sessionId: string) => void }): ReactNode {
  const app = useApp()
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<SessionFilter>('all')
  const [pinned, setPinned] = useState<Set<string>>(readPinned)
  const [groupBy, setGroupBy] = useState<'date' | 'project'>('date')

  useEffect(() => {
    void app.refresh()
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') void app.refresh()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [app])

  /** A session counts as pinned from either side: the desktop or this phone. */
  function isPinned(session: SessionSummary): boolean {
    return session.pinned === true || pinned.has(session.id)
  }

  function togglePin(id: string, event: MouseEvent<HTMLButtonElement>): void {
    event.stopPropagation()
    setPinned((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      writePinned(next)
      return next
    })
  }

  const filteredSessions = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return app.sessions.filter((session) => {
      if (filter === 'archived') {
        if (session.archived !== true) return false
      } else {
        if (session.archived === true) return false
      }
      if (filter === 'active' && session.status !== 'running') return false
      if (filter === 'pinned' && !isPinned(session)) return false
      if (needle.length === 0) return true
      return session.title.toLowerCase().includes(needle)
    })
  }, [app.sessions, query, filter, pinned])

  // Group by date (Pinned, Today, Yesterday, Older) matching mockup Screen 2
  const dateGroups = useMemo(() => {
    const now = new Date()
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
    const yesterdayStart = todayStart - 24 * 60 * 60 * 1000

    const pinnedList: SessionSummary[] = []
    const todayList: SessionSummary[] = []
    const yesterdayList: SessionSummary[] = []
    const olderList: SessionSummary[] = []

    for (const session of filteredSessions) {
      if (filter !== 'pinned' && isPinned(session)) {
        pinnedList.push(session)
      } else if (session.updatedAt >= todayStart) {
        todayList.push(session)
      } else if (session.updatedAt >= yesterdayStart) {
        yesterdayList.push(session)
      } else {
        olderList.push(session)
      }
    }

    const sortFn = (a: SessionSummary, b: SessionSummary) => b.updatedAt - a.updatedAt

    return [
      { id: 'pinned', title: 'Pinned', sessions: pinnedList.sort(sortFn) },
      { id: 'today', title: 'Today', sessions: todayList.sort(sortFn) },
      { id: 'yesterday', title: 'Yesterday', sessions: yesterdayList.sort(sortFn) },
      { id: 'older', title: 'Older', sessions: olderList.sort(sortFn) },
    ].filter((g) => g.sessions.length > 0)
  }, [filteredSessions, pinned, filter])

  // Group by project
  const projectGroups = useMemo(() => {
    const byProject = new Map<string, SessionSummary[]>()
    for (const session of filteredSessions) {
      const list = byProject.get(session.projectId) ?? []
      list.push(session)
      byProject.set(session.projectId, list)
    }
    return [...byProject.entries()].map(([projectId, sessions]) => ({
      id: projectId,
      title: app.projects.find((project) => project.id === projectId)?.name ?? projectId,
      sessions: sessions.sort((a, b) => b.updatedAt - a.updatedAt),
    }))
  }, [filteredSessions, app.projects])

  const groups = groupBy === 'date' ? dateGroups : projectGroups

  return (
    <div className="flex h-full flex-col">
      {/* Header matching mockup Screen 2 */}
      <div className="shrink-0 px-4 pt-4 pb-2">
        <div className="flex items-baseline justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-fg">Sessions</h1>
            <p className="mt-0.5 text-xs text-fg-muted">Continue where you left off.</p>
          </div>
          <button
            type="button"
            onClick={() => setGroupBy(groupBy === 'date' ? 'project' : 'date')}
            className="rounded-lg border border-border bg-surface-1 px-2.5 py-1 text-2xs text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg"
          >
            {groupBy === 'date' ? 'By Project' : 'By Date'}
          </button>
        </div>

        {/* Search bar */}
        <div className="relative mt-3">
          <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-fg-subtle">
            <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <circle cx="9" cy="9" r="6" />
              <path d="m14 14 4 4" />
            </svg>
          </span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search sessions…"
            type="search"
            aria-label="Search sessions"
            className="h-11 w-full rounded-xl border border-border bg-surface-1 pl-9 pr-8 text-sm text-fg placeholder:text-fg-subtle focus:border-border-strong focus:outline-none"
          />
          {query.length > 0 && (
            <button
              type="button"
              onClick={() => setQuery('')}
              className="absolute inset-y-0 right-2.5 flex items-center text-xs text-fg-subtle hover:text-fg"
              aria-label="Clear search"
            >
              ✕
            </button>
          )}
        </div>

        {/* Filter pills */}
        <div className="mt-2.5 flex gap-1.5 overflow-x-auto pb-1" role="tablist" aria-label="Filter sessions">
          {(['all', 'active', 'pinned', 'archived'] as const).map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={filter === id}
              onClick={() => setFilter(id)}
              className={`rounded-full px-3.5 py-1 text-xs font-medium capitalize transition-colors ${
                filter === id
                  ? 'bg-accent text-fg-on-accent shadow-xs'
                  : 'border border-border bg-surface-1 text-fg-muted hover:bg-surface-2 hover:text-fg'
              }`}
            >
              {id}
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-6 pt-2">
        {app.error !== null && (
          <p role="alert" className="mb-3 rounded-xl border border-danger bg-danger-subtle p-3 text-xs text-danger">
            {app.error}
          </p>
        )}

        {groups.length === 0 && (
          <div className="mt-8 text-center">
            <p className="text-sm font-medium text-fg">
              {app.sessions.length === 0
                ? 'No sessions yet. Start one from Projects.'
                : 'Nothing matches that search.'}
            </p>
            <p className="mt-1 text-xs text-fg-subtle">
              {app.sessions.length > 0 && 'Try clearing your search or choosing another filter.'}
            </p>
          </div>
        )}

        {groups.map((group) => (
          <section key={group.id} className="mb-5">
            <h2 className="mb-2 flex items-baseline justify-between px-1">
              <span className="text-xs font-semibold uppercase tracking-wider text-fg-subtle">
                {group.title}
              </span>
              <span className="text-2xs font-medium text-fg-muted">
                {group.sessions.length}
              </span>
            </h2>
            <div className="space-y-2">
              {group.sessions.map((session) => {
                const pinnedNow = isPinned(session)
                const isRunning = session.status === 'running'
                const projectName = app.projects.find((p) => p.id === session.projectId)?.name ?? session.projectId
                return (
                  <div
                    key={session.id}
                    className="flex items-center gap-1 rounded-2xl border border-border bg-surface-1 p-2 pl-3.5 transition-colors hover:border-border-strong hover:bg-surface-2"
                  >
                    <button
                      type="button"
                      onClick={() => onOpen(session.id)}
                      aria-label={`Open ${session.title || 'untitled session'}`}
                      className="flex min-h-11 min-w-0 flex-1 items-center gap-3 text-left"
                    >
                      {/* Session document/chat icon */}
                      <span aria-hidden className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-border bg-surface-2 text-fg-muted">
                        <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M4 3a2 2 0 0 1 2-2h6l5 5v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V3Z" />
                          <path d="M12 1v5h5M8 10h4M8 14h4" />
                        </svg>
                      </span>

                      {/* Session Info */}
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[15px] font-semibold tracking-tight text-fg">
                          {session.title || 'Untitled session'}
                        </span>
                        <span className="mt-0.5 block truncate text-xs text-fg-subtle">
                          {projectName} · {session.messageCount} turns · {formatSessionTime(session.updatedAt)}
                        </span>
                      </span>

                      {isRunning && (
                        <span className="flex h-5 shrink-0 items-center gap-1 rounded-full bg-accent-subtle px-2 text-2xs font-semibold text-accent">
                          <span aria-hidden className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
                          active
                        </span>
                      )}

                      {/* Chevron */}
                      <span aria-hidden className="shrink-0 text-fg-subtle">
                        <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                          <path d="m7 4 6 6-6 6" />
                        </svg>
                      </span>
                    </button>

                    {/* Pin button */}
                    <button
                      type="button"
                      onClick={(event) => togglePin(session.id, event)}
                      className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl transition-colors ${
                        pinnedNow ? 'text-accent' : 'text-fg-subtle hover:text-fg'
                      }`}
                      aria-label={pinnedNow ? 'Unpin session' : 'Pin session'}
                      aria-pressed={pinnedNow}
                    >
                      <svg width="15" height="15" viewBox="0 0 20 20" fill={pinnedNow ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                        <path d="M12 2 18 8l-2 2-3-3-4 4v4l-2 2-1-5-5-1 2-2h4l4-4-3-3 2-2Z" />
                      </svg>
                    </button>
                  </div>
                )
              })}
            </div>
          </section>
        ))}

        {app.sessions.length > 0 && (
          <p className="mt-4 text-center text-2xs text-fg-subtle">
            Updated {app.refreshing ? 'just now' : relativeTime(Date.now())}
          </p>
        )}
      </div>
    </div>
  )
}
