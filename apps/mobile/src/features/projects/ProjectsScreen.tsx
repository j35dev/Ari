import { useEffect, useState, type ReactNode } from 'react'
import { ArrowUpRight, Folder, Plus, Star, ChevronLeft } from 'lucide-react'
import { FilterChips, ScreenHeader, SearchField } from '../../components/ui'
import { EmptyState } from '../../components/EmptyState'
import { useApp } from '../../lib/app-state'
import { relativeTime } from '../../lib/format'

const filters = [
  { id: 'all', label: 'All projects' },
  { id: 'recent', label: 'Recent' },
  { id: 'starred', label: 'Starred' },
] as const
type Filter = (typeof filters)[number]['id']
function readStars(origin: string | null): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(`ari.stars:${origin ?? ''}`) ?? '[]')
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string')
      : []
  } catch (error) {
    console.warn('Could not restore starred projects', error)
    return []
  }
}
/** Shared projects with their recent work; creation opens a focused sheet. */
export function ProjectsScreen({
  onOpen,
  onNewSession,
}: {
  onOpen: (id: string) => void
  onNewSession: (projectId?: string) => void
}): ReactNode {
  const app = useApp()
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [stars, setStars] = useState(() => readStars(app.origin))
  const [selected, setSelected] = useState<string | null>(null)
  useEffect(() => {
    setStars(readStars(app.origin))
    setSelected(null)
  }, [app.origin])
  const visible = app.projects
    .map((project) => ({
      ...project,
      sessions: app.sessions
        .filter((item) => item.projectId === project.id && item.archived !== true)
        .sort((a, b) => b.updatedAt - a.updatedAt),
    }))
    .filter(
      (project) =>
        project.name.toLowerCase().includes(query.trim().toLowerCase()) &&
        (filter !== 'starred' || stars.includes(project.id)),
    )
    .sort((a, b) =>
      filter === 'recent'
        ? (b.sessions[0]?.updatedAt ?? 0) - (a.sessions[0]?.updatedAt ?? 0)
        : a.name.localeCompare(b.name),
    )
  const project = visible.find((entry) => entry.id === selected)
  function toggle(id: string): void {
    const next = stars.includes(id) ? stars.filter((item) => item !== id) : [...stars, id]
    setStars(next)
    try {
      localStorage.setItem(`ari.stars:${app.origin ?? ''}`, JSON.stringify(next))
    } catch (error) {
      console.warn('Could not save starred projects', error)
    }
  }
  return (
    <div className="flex h-full flex-col">
      <div className="screen-heading space-y-3">
        <ScreenHeader
          title={project?.name ?? 'Projects'}
          subtitle={
            project === undefined
              ? 'Your computer. Your projects. Anywhere.'
              : `${project.sessions.length} sessions in this workspace.`
          }
          action={
            <button
              type="button"
              className="icon-button"
              aria-label={project === undefined ? 'New session' : 'Back to projects'}
              onClick={() => (project === undefined ? onNewSession() : setSelected(null))}
            >
              {project === undefined ? <Plus size={20} /> : <ChevronLeft size={20} />}
            </button>
          }
        />
        {project === undefined && (
          <>
            <SearchField
              value={query}
              onChange={setQuery}
              placeholder="Find a project"
              label="Search projects"
            />
            <FilterChips options={filters} active={filter} onPick={setFilter} />
          </>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6">
        {project === undefined && visible.length === 0 && (
          <EmptyState
            title={app.projects.length === 0 ? 'No shared projects yet' : 'No matching projects'}
            detail={
              app.projects.length === 0
                ? 'Choose which projects this phone can access in Ari on your computer, under Settings → Mobile access.'
                : 'Try another search or star a project for quick access.'
            }
          />
        )}
        {project === undefined ? (
          <ul className="divide-y divide-border">
            {visible.map((entry) => (
              <li key={entry.id} className="flex items-center gap-3 py-2">
                <button
                  type="button"
                  className="flex min-h-20 min-w-0 flex-1 items-center gap-3 text-left"
                  onClick={() => setSelected(entry.id)}
                >
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-border bg-surface-1 text-fg-muted">
                    <Folder size={18} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[15px] font-medium">{entry.name}</span>
                    <span className="mt-1 block text-xs text-fg-subtle">
                      {entry.sessionCount} sessions
                      {entry.sessions[0] === undefined
                        ? ''
                        : ` · ${relativeTime(entry.sessions[0].updatedAt)}`}
                    </span>
                  </span>
                </button>
                <button
                  type="button"
                  className={`icon-button ${stars.includes(entry.id) ? 'text-accent' : 'text-fg-subtle'}`}
                  aria-label={`${stars.includes(entry.id) ? 'Unstar' : 'Star'} ${entry.name}`}
                  aria-pressed={stars.includes(entry.id)}
                  onClick={() => toggle(entry.id)}
                >
                  <Star size={16} fill={stars.includes(entry.id) ? 'currentColor' : 'none'} />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <>
            <button
              type="button"
              className="primary-button my-3 w-full"
              disabled={!app.session?.supports('session.create') || app.connection !== 'connected'}
              onClick={() => onNewSession(project.id)}
            >
              <Plus size={17} />
              New session
            </button>
            <ul className="divide-y divide-border">
              {project.sessions.map((session) => (
                <li key={session.id}>
                  <button
                    type="button"
                    onClick={() => onOpen(session.id)}
                    className="flex min-h-20 w-full items-center justify-between gap-3 text-left"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-[15px] font-medium">
                        {session.title || 'Untitled session'}
                      </span>
                      <span className="mt-1 block text-xs text-fg-subtle">
                        {session.status === 'running' ? 'Working' : relativeTime(session.updatedAt)}
                      </span>
                    </span>
                    <ArrowUpRight size={15} className="text-fg-subtle" />
                  </button>
                </li>
              ))}
            </ul>
            {project.sessions.length === 0 && (
              <EmptyState
                title="Ready for your first task"
                detail="Create a session to start working in this project."
              />
            )}
          </>
        )}
      </div>
    </div>
  )
}
