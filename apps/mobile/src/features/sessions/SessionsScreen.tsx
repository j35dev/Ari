import { useMemo, useState, type ReactNode } from 'react'
import { Plus, RefreshCw, Pin, Search } from 'lucide-react'
import { useApp } from '../../lib/app-state'
import { relativeTime } from '../../lib/format'
import { EmptyState } from '../../components/EmptyState'
import { FilterChips, SearchField } from '../../components/ui'

const filters = [
  { id: 'all', label: 'All' },
  { id: 'active', label: 'Running' },
  { id: 'pinned', label: 'Pinned' },
  { id: 'archived', label: 'Archived' },
] as const
type Filter = (typeof filters)[number]['id']

/** Search and resume the desktop's sessions, with flags shared across devices. */
export function SessionsScreen({
  onOpen,
  onNewSession,
}: {
  onOpen: (id: string) => void
  onNewSession: () => void
}): ReactNode {
  const app = useApp()
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [searching, setSearching] = useState(false)
  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const today = new Date().setHours(0, 0, 0, 0)
    const map = new Map<string, typeof app.sessions>()
    for (const session of [...app.sessions].sort((a, b) => b.updatedAt - a.updatedAt)) {
      if ((session.archived === true) !== (filter === 'archived')) continue
      if (filter === 'active' && session.status !== 'running') continue
      if (filter === 'pinned' && session.pinned !== true) continue
      const project = app.projects.find((item) => item.id === session.projectId)?.name ?? ''
      if (needle && !`${session.title} ${project}`.toLowerCase().includes(needle)) continue
      const name =
        session.pinned === true ? 'Pinned' : session.updatedAt >= today ? 'Today' : 'Earlier'
      map.set(name, [...(map.get(name) ?? []), session])
    }
    return ['Pinned', 'Today', 'Earlier'].flatMap((name) =>
      map.has(name) ? [{ name, sessions: map.get(name) ?? [] }] : [],
    )
  }, [app.sessions, app.projects, query, filter])
  return (
    <div className="flex h-full flex-col">
      <div className="screen-heading space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h1 className="text-[23px] font-semibold tracking-tight">Sessions</h1>
          <div className="flex items-center gap-1">
            <button
              type="button"
              aria-label="Search and filter sessions"
              aria-expanded={searching}
              className="icon-button text-fg-muted"
              onClick={() => setSearching((open) => !open)}
            >
              <Search size={19} />
            </button>
            <button
              type="button"
              aria-label="New session"
              className="icon-button text-fg"
              onClick={onNewSession}
              disabled={!app.session?.supports('session.create')}
            >
              <Plus size={21} />
            </button>
          </div>
        </div>
        {searching && (
          <>
            <SearchField
              value={query}
              onChange={setQuery}
              placeholder="Search sessions or projects"
              label="Search sessions"
            />
            <FilterChips options={filters} active={filter} onPick={setFilter} />
          </>
        )}
        {!searching && (query || filter !== 'all') && (
          <button
            type="button"
            className="min-h-11 text-xs text-fg-muted"
            onClick={() => {
              setQuery('')
              setFilter('all')
            }}
          >
            Clear {filter !== 'all' ? filter : 'search'} filter
          </button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6">
        {app.error !== null && (
          <p role="alert" className="error-banner">
            {app.error}
          </p>
        )}
        {groups.length === 0 && (
          <EmptyState
            title={app.sessions.length === 0 ? 'A fresh start' : 'No matching sessions'}
            detail={
              app.sessions.length === 0
                ? 'Start a session in a shared project. Ari does the work on your computer while you stay in control.'
                : 'Try another search or filter.'
            }
            action={
              app.sessions.length === 0 && (
                <button
                  type="button"
                  className="primary-button"
                  onClick={onNewSession}
                  disabled={!app.session?.supports('session.create')}
                >
                  Start a session
                </button>
              )
            }
          />
        )}
        {groups.map((group) => (
          <section key={group.name} className="mb-5">
            <h2 className="section-label flex items-center justify-between">
              <span>{group.name}</span>
            </h2>
            <ul className="divide-y divide-border">
              {group.sessions.map((session) => {
                const project =
                  app.projects.find((item) => item.id === session.projectId)?.name ??
                  'Shared project'
                return (
                  <li key={session.id} className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => onOpen(session.id)}
                      className="flex min-h-[84px] min-w-0 flex-1 items-start py-4 text-left"
                      aria-label={`Open ${session.title || 'Untitled session'}`}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="mb-1.5 flex items-center justify-between gap-3 text-xs text-fg-muted">
                          <span className="truncate">{project}</span>
                          <span
                            className={`shrink-0 text-[11px] ${session.status === 'running' ? 'text-success' : session.status === 'error' ? 'text-danger' : session.status === 'waiting-approval' ? 'text-warning' : 'text-fg-subtle'}`}
                          >
                            {session.status === 'running'
                              ? 'Working'
                              : session.status === 'waiting-approval'
                                ? 'Approval'
                                : session.status === 'error'
                                  ? 'Needs attention'
                                  : relativeTime(session.updatedAt)}
                          </span>
                        </span>
                        <span className="flex items-center gap-2 text-[16px] font-medium tracking-tight">
                          <span className="truncate">{session.title || 'Untitled session'}</span>
                          {session.pinned === true && (
                            <Pin size={12} className="shrink-0 text-fg-subtle" />
                          )}
                        </span>
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          </section>
        ))}
        <button
          type="button"
          className="mx-auto flex min-h-11 items-center gap-2 text-xs text-fg-subtle"
          onClick={() => void app.refresh()}
          disabled={app.refreshing}
        >
          <RefreshCw size={12} className={app.refreshing ? 'animate-spin' : ''} />
          {app.refreshing ? 'Syncing with your computer' : 'Refresh workspace'}
        </button>
      </div>
    </div>
  )
}
