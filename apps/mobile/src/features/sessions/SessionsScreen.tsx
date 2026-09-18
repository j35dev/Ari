import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { SessionSummary } from '@ari/contracts/rpc'
import { useApp } from '../../lib/app-state'
import { relativeTime } from '../../lib/format'
import { SessionRow } from '../now/NowScreen'

/**
 * Sessions: search, project grouping, history (ADR §13).
 *
 * Grouped by project rather than by date, because a user looking for work they
 * started reaches for the project first — and the phone only ever holds the
 * projects the desktop granted it.
 */
export function SessionsScreen({ onOpen }: { onOpen: (sessionId: string) => void }): ReactNode {
  const app = useApp()
  const [query, setQuery] = useState('')
  const [showArchived, setShowArchived] = useState(false)

  // The list is the desktop's; a phone that has just returned from the
  // background is showing whatever it fetched last.
  useEffect(() => {
    void app.refresh()
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') void app.refresh()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [app])

  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const visible = app.sessions.filter((session) => {
      if (!showArchived && session.archived === true) return false
      if (needle.length === 0) return true
      return session.title.toLowerCase().includes(needle)
    })
    const byProject = new Map<string, SessionSummary[]>()
    for (const session of visible) {
      const list = byProject.get(session.projectId) ?? []
      list.push(session)
      byProject.set(session.projectId, list)
    }
    return [...byProject.entries()].map(([projectId, sessions]) => ({
      projectId,
      name: app.projects.find((project) => project.id === projectId)?.name ?? projectId,
      sessions: sessions.sort((a, b) => b.updatedAt - a.updatedAt),
    }))
  }, [app.sessions, app.projects, query, showArchived])

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 space-y-2 border-b border-border px-4 py-3">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search sessions"
          type="search"
          aria-label="Search sessions"
          className="h-11 w-full rounded-xl border border-border bg-surface-1 px-4 text-fg placeholder:text-fg-subtle"
        />
        <label className="flex items-center gap-2 text-xs text-fg-muted">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(event) => setShowArchived(event.target.checked)}
            className="h-4 w-4"
          />
          Show archived
        </label>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-6 pt-3">
        {app.error !== null && (
          <p role="alert" className="mb-3 rounded-md border border-danger bg-danger-subtle p-3 text-sm">
            {app.error}
          </p>
        )}

        {groups.length === 0 && (
          <p className="mt-6 text-sm text-fg-muted">
            {app.sessions.length === 0
              ? 'No sessions yet. Start one from Projects.'
              : 'Nothing matches that search.'}
          </p>
        )}

        {groups.map((group) => (
          <section key={group.projectId} className="mb-6">
            <h2 className="mb-2 flex items-baseline justify-between">
              <span className="text-xs font-medium uppercase tracking-wide text-fg-subtle">
                {group.name}
              </span>
              <span className="text-2xs text-fg-subtle">
                {group.sessions.length} session{group.sessions.length === 1 ? '' : 's'}
              </span>
            </h2>
            <div className="space-y-2">
              {group.sessions.map((session) => (
                <SessionRow key={session.id} session={session} onOpen={onOpen} />
              ))}
            </div>
          </section>
        ))}

        {app.sessions.length > 0 && (
          <p className="text-2xs text-fg-subtle">
            Updated {app.refreshing ? 'just now' : relativeTime(Date.now())}
          </p>
        )}
      </div>
    </div>
  )
}
