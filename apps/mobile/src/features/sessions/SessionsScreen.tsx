import { useMemo, useState, type ReactNode } from 'react'
import { ArrowUpRight, CircleCheck, LoaderCircle, Plus, RefreshCw, Pin } from 'lucide-react'
import { useApp } from '../../lib/app-state'
import { relativeTime } from '../../lib/format'
import { EmptyState } from '../../components/EmptyState'
import { FilterChips, ScreenHeader, SearchField } from '../../components/ui'

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
  const [failure, setFailure] = useState<string | null>(null)
  const [pinning, setPinning] = useState<string | null>(null)
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
  async function pin(id: string, pinned: boolean): Promise<void> {
    setPinning(id)
    try {
      await app.session?.send({ op: 'session.update', sessionId: id, pinned })
      await app.refresh()
    } catch (error) {
      setFailure(error instanceof Error ? error.message : 'Could not update this session.')
    } finally {
      setPinning(null)
    }
  }
  const running = app.sessions.filter((session) => session.status === 'running').length
  return (
    <div className="flex h-full flex-col">
      <div className="screen-heading space-y-3">
        <ScreenHeader
          title="Your workspace"
          subtitle={
            running > 0
              ? `${running} session${running === 1 ? '' : 's'} running on your computer.`
              : 'Pick up a conversation. Make something happen.'
          }
          action={
            <button
              type="button"
              aria-label="New session"
              className="icon-button bg-accent text-fg-on-accent"
              onClick={onNewSession}
              disabled={!app.session?.supports('session.create')}
            >
              <Plus size={21} />
            </button>
          }
        />
        <SearchField
          value={query}
          onChange={setQuery}
          placeholder="Search sessions or projects"
          label="Search sessions"
        />
        <FilterChips options={filters} active={filter} onPick={setFilter} />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6">
        {(failure ?? app.error) !== null && (
          <p role="alert" className="error-banner">
            {failure ?? app.error}
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
              <span>{group.sessions.length}</span>
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
                      className="flex min-h-[88px] min-w-0 flex-1 items-start gap-3 py-4 text-left"
                      aria-label={`Open ${session.title || 'Untitled session'}`}
                    >
                      <span
                        className={`mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg border border-border ${session.status === 'running' ? 'bg-success-subtle text-success' : 'bg-surface-1 text-fg-subtle'}`}
                      >
                        {session.status === 'running' ? (
                          <LoaderCircle size={15} className="animate-spin" />
                        ) : (
                          <CircleCheck size={15} />
                        )}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[15px] font-medium tracking-tight">
                          {session.title || 'Untitled session'}
                        </span>
                        <span className="mt-1 block truncate text-xs text-fg-muted">
                          {project}{' '}
                          <span className="text-fg-subtle">
                            · {relativeTime(session.updatedAt)}
                          </span>
                        </span>
                        <span
                          className={`mt-2 inline-flex items-center gap-1.5 text-[11px] ${session.status === 'running' ? 'text-success' : session.status === 'error' ? 'text-danger' : 'text-fg-subtle'}`}
                        >
                          <span className="size-1 rounded-full bg-current" />
                          {session.status === 'running'
                            ? 'Working'
                            : session.status === 'error'
                              ? 'Needs attention'
                              : `${session.messageCount} messages`}
                        </span>
                      </span>
                      <ArrowUpRight size={14} className="mt-1 shrink-0 text-fg-subtle" />
                    </button>
                    {app.session?.supports('session.update') && (
                      <button
                        type="button"
                        className={`icon-button ${session.pinned === true ? 'text-accent' : 'text-fg-subtle'}`}
                        aria-label={`${session.pinned === true ? 'Unpin' : 'Pin'} ${session.title}`}
                        aria-pressed={session.pinned === true}
                        disabled={pinning !== null}
                        onClick={() => void pin(session.id, session.pinned !== true)}
                      >
                        <Pin size={15} />
                      </button>
                    )}
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
