import { useEffect, useState, type ReactNode } from 'react'
import { BottomSheet, FilterChips, ScreenHeader, SearchField } from '../../components/ui'
import { useApp } from '../../lib/app-state'
import { sessionIdOf } from '../../lib/command-result'
import { relativeTime } from '../../lib/format'

/**
 * Projects, and starting work in one.
 *
 * The flow stays short — project, provider, prompt, start — because a phone
 * is the wrong place for a configuration screen. What is *not* here matters
 * as much: no permission mode, no filesystem root, no provider login. The
 * desktop's ceiling applies and mobile cannot raise it.
 *
 * Stars are this phone's own: the desktop has no starred-projects concept,
 * so they live in local storage next to the remembered provider choices.
 */

type ProjectFilter = 'all' | 'recent' | 'starred'

const FILTERS: readonly { id: ProjectFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'recent', label: 'Recent' },
  { id: 'starred', label: 'Starred' },
]

export function ProjectsScreen({
  onOpen,
  expandRequest,
  onNewSession,
}: {
  onOpen: (sessionId: string) => void
  expandRequest?: { projectId: string; nonce: number } | null
  onNewSession: () => void
}): ReactNode {
  const app = useApp()
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<ProjectFilter>('all')
  const [stars, setStars] = useState<string[]>(() => readStars())
  const [chosen, setChosen] = useState<string | null>(null)
  const [prompt, setPrompt] = useState('')
  const [provider, setProvider] = useState('')
  const [model, setModel] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const canCreate = app.session?.supports('session.create') ?? false
  // One catalog for the whole app, refreshed with everything else: the form
  // reads it rather than asking again per expansion.
  const catalog = app.catalog

  // The last choice per project, restored when the form opens and validated
  // against what the desktop serves now rather than trusted blindly.
  useEffect(() => {
    if (chosen === null || catalog === null) return
    const remembered = readChoice(chosen)
    const entry = catalog.providers.find((item) => item.driverKind === remembered.driverKind)
    if (entry === undefined) {
      setProvider('')
      setModel('')
      return
    }
    setProvider(entry.driverKind)
    setModel(entry.models.some((item) => item.id === remembered.modelId) ? remembered.modelId : '')
  }, [chosen, catalog])

  // Another screen asking for a project's form: open it and bring it into view.
  useEffect(() => {
    if (expandRequest === null || expandRequest === undefined) return
    setChosen(expandRequest.projectId)
    document
      .getElementById(`project-${expandRequest.projectId}`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [expandRequest])

  function toggleStar(projectId: string): void {
    setStars((current) => {
      const next = current.includes(projectId)
        ? current.filter((id) => id !== projectId)
        : [...current, projectId]
      writeStars(next)
      return next
    })
  }

  function chooseProvider(driverKind: string): void {
    setProvider(driverKind)
    setModel('')
    if (chosen !== null) writeChoice(chosen, { driverKind, modelId: '' })
  }

  function chooseModel(modelId: string): void {
    setModel(modelId)
    if (chosen !== null) writeChoice(chosen, { driverKind: provider, modelId })
  }

  async function start(projectId: string): Promise<void> {
    if (app.session === null) return
    setBusy(true)
    setError(null)
    try {
      const created = await app.session.send({
        op: 'session.create',
        projectId,
        // Left out entirely when the desktop default applies, so an empty
        // string never reaches a check it would fail.
        ...(provider.length === 0 ? {} : { driverKind: provider }),
        ...(provider.length === 0 || model.length === 0 ? {} : { modelId: model }),
      })
      const sessionId = sessionIdOf(created)
      if (sessionId === null) throw new Error('the desktop did not name the new session')
      if (prompt.trim().length > 0) {
        await app.session.send({ op: 'session.prompt', sessionId, text: prompt.trim() })
      }
      setPrompt('')
      setChosen(null)
      setProvider('')
      setModel('')
      await app.refresh()
      onOpen(sessionId)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'could not start that session')
    } finally {
      setBusy(false)
    }
  }

  const needle = query.trim().toLowerCase()
  const enriched = app.projects.map((project) => {
    const sessions = app.sessions.filter((session) => session.projectId === project.id)
    const latest = sessions.reduce((max, session) => Math.max(max, session.updatedAt), 0)
    const running = sessions.filter((session) => session.status === 'running').length
    return { ...project, latest, running }
  })
  const visible = enriched
    .filter((project) => needle.length === 0 || project.name.toLowerCase().includes(needle))
    .filter((project) => filter !== 'starred' || stars.includes(project.id))
    .sort((a, b) => {
      if (filter === 'recent' || needle.length > 0) return b.latest - a.latest
      return a.name.localeCompare(b.name)
    })

  return (
    <div className="relative flex h-full flex-col">
      <div className="shrink-0 space-y-3 px-4 pb-2 pt-4">
        <ScreenHeader title="Projects" subtitle="All your projects, in one place." />
        <SearchField
          value={query}
          onChange={setQuery}
          placeholder="Search projects…"
          label="Search projects"
        />
        <FilterChips options={FILTERS} active={filter} onPick={setFilter} />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-24">
        {!canCreate && (
          <p className="mt-3 rounded-xl border border-border bg-surface-1 p-4 text-sm text-fg-muted">
            This desktop does not accept new sessions from a phone right now. Existing sessions are
            still available under Sessions.
          </p>
        )}

        {error !== null && (
          <p role="alert" className="mt-3 rounded-xl border border-danger bg-danger-subtle p-4 text-sm">
            {error}
          </p>
        )}

        {visible.length === 0 ? (
          <p className="mt-8 text-center text-sm text-fg-muted">
            {app.projects.length === 0
              ? 'No projects are shared with this device. Pair again from the desktop and choose which projects this phone may reach.'
              : filter === 'starred'
                ? 'No starred projects yet. Star the ones you reach for most.'
                : 'Nothing matches that search.'}
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {visible.map((project) => (
              <li key={project.id} id={`project-${project.id}`}>
                <div className="flex items-center gap-1 py-2">
                  <span aria-hidden className="flex h-11 w-8 shrink-0 items-center justify-center text-fg-muted">
                    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M2.5 5.5A1.5 1.5 0 0 1 4 4h3.5l1.8 2H16a1.5 1.5 0 0 1 1.5 1.5V14A1.5 1.5 0 0 1 16 15.5H4A1.5 1.5 0 0 1 2.5 14V5.5Z" />
                    </svg>
                  </span>
                  <button
                    type="button"
                    onClick={() => setChosen(chosen === project.id ? null : project.id)}
                    aria-expanded={chosen === project.id}
                    className="min-w-0 flex-1 py-2 pr-1 text-left"
                  >
                    <span className="block truncate text-[15px] font-medium tracking-tight">
                      {project.name}
                    </span>
                    <span className="mt-0.5 block truncate text-xs text-fg-subtle">
                      {project.sessionCount} session{project.sessionCount === 1 ? '' : 's'}
                      {project.latest > 0 ? ` · Updated ${relativeTime(project.latest)}` : ''}
                    </span>
                  </button>
                  {project.running > 0 && (
                    <span
                      aria-label={`${project.running} running sessions`}
                      className="flex h-6 min-w-6 shrink-0 items-center justify-center rounded-full bg-accent px-1.5 text-xs font-medium text-fg-on-accent"
                    >
                      {project.running}
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => toggleStar(project.id)}
                    aria-label={stars.includes(project.id) ? `Unstar ${project.name}` : `Star ${project.name}`}
                    aria-pressed={stars.includes(project.id)}
                    className={`flex h-11 w-11 shrink-0 items-center justify-center ${
                      stars.includes(project.id) ? 'text-accent' : 'text-fg-subtle'
                    }`}
                  >
                    <svg width="18" height="18" viewBox="0 0 20 20" fill={stars.includes(project.id) ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <path d="M10 2.5 12.3 7l4.9.6-3.6 3.3.9 4.9L10 13.4l-4.5 2.4.9-4.9L2.8 7.6 7.7 7 10 2.5Z" />
                    </svg>
                  </button>
                </div>

                {chosen === project.id && (
                  <form
                    className="mb-3 space-y-3 rounded-2xl border border-border bg-surface-1 p-4"
                    onSubmit={(event) => {
                      event.preventDefault()
                      void start(project.id)
                    }}
                  >
                    {catalog !== null && catalog.providers.length > 0 && (
                      <>
                        <div>
                          <label className="block text-xs text-fg-muted" htmlFor={`provider-${project.id}`}>
                            Provider
                          </label>
                          <select
                            id={`provider-${project.id}`}
                            value={provider}
                            onChange={(event) => chooseProvider(event.target.value)}
                            className="mt-1 h-11 w-full rounded-xl border border-border bg-bg px-3"
                          >
                            <option value="">Desktop default</option>
                            {catalog.providers.map((entry) => (
                              <option key={entry.driverKind} value={entry.driverKind}>
                                {entry.driverKind}
                              </option>
                            ))}
                          </select>
                        </div>
                        {provider.length > 0 && (
                          <div>
                            <label className="block text-xs text-fg-muted" htmlFor={`model-${project.id}`}>
                              Model
                            </label>
                            <select
                              id={`model-${project.id}`}
                              value={model}
                              onChange={(event) => chooseModel(event.target.value)}
                              className="mt-1 h-11 w-full rounded-xl border border-border bg-bg px-3"
                            >
                              <option value="">Desktop default</option>
                              {catalog.providers
                                .find((entry) => entry.driverKind === provider)
                                ?.models.map((entry) => (
                                  <option key={entry.id} value={entry.id}>
                                    {entry.label}
                                  </option>
                                ))}
                            </select>
                          </div>
                        )}
                      </>
                    )}
                    <div>
                      <label className="block text-xs text-fg-muted" htmlFor={`prompt-${project.id}`}>
                        First message (optional)
                      </label>
                      <textarea
                        id={`prompt-${project.id}`}
                        value={prompt}
                        onChange={(event) => setPrompt(event.target.value)}
                        rows={3}
                        className="mt-1 w-full resize-none rounded-xl border border-border bg-bg p-3"
                      />
                    </div>
                    <button
                      type="submit"
                      disabled={busy || !canCreate}
                      className="h-12 w-full rounded-xl bg-accent font-medium text-fg-on-accent disabled:opacity-50"
                    >
                      {busy ? 'Starting…' : 'Start session'}
                    </button>
                  </form>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {canCreate && (
        <button
          type="button"
          onClick={onNewSession}
          aria-label="New session"
          className="absolute bottom-6 right-4 flex h-14 w-14 items-center justify-center rounded-full bg-accent text-fg-on-accent shadow-lg"
        >
          <svg width="22" height="22" viewBox="0 0 22 22" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden>
            <path d="M11 4v14M4 11h14" />
          </svg>
        </button>
      )}
    </div>
  )
}

/** Picks the project a new session starts in. Shared with the Sessions screen. */
export function NewSessionSheet({
  onClose,
  onPick,
}: {
  onClose: () => void
  onPick: (projectId: string) => void
}): ReactNode {
  const app = useApp()
  return (
    <BottomSheet title="New session" onClose={onClose}>
      <ul className="divide-y divide-border">
        {app.projects.map((project) => (
          <li key={project.id}>
            <button
              type="button"
              onClick={() => onPick(project.id)}
              className="flex min-h-11 w-full items-center justify-between gap-3 py-2 text-left"
            >
              <span className="min-w-0">
                <span className="block truncate text-[15px] font-medium">{project.name}</span>
                <span className="mt-0.5 block text-xs text-fg-subtle">
                  {project.sessionCount} session{project.sessionCount === 1 ? '' : 's'}
                </span>
              </span>
              <span aria-hidden className="shrink-0 text-fg-subtle">›</span>
            </button>
          </li>
        ))}
      </ul>
      {app.projects.length === 0 && (
        <p className="py-4 text-sm text-fg-muted">No projects are shared with this device.</p>
      )}
    </BottomSheet>
  )
}

interface ModelChoice {
  driverKind: string
  modelId: string
}

/** The last provider/model choice per project, so a repeated task starts the same way. */
function choiceKey(projectId: string): string {
  return `ari.mobile.models.${projectId}`
}

function readChoice(projectId: string): ModelChoice {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(choiceKey(projectId)) ?? 'null')
    if (parsed !== null && typeof parsed === 'object') {
      const choice = parsed as Record<string, unknown>
      if (typeof choice['driverKind'] === 'string' && typeof choice['modelId'] === 'string') {
        return { driverKind: choice['driverKind'], modelId: choice['modelId'] }
      }
    }
  } catch {
    // A corrupt entry is forgotten, not fatal.
  }
  return { driverKind: '', modelId: '' }
}

function writeChoice(projectId: string, choice: ModelChoice): void {
  try {
    localStorage.setItem(choiceKey(projectId), JSON.stringify(choice))
  } catch {
    // Private browsing may refuse storage; the choice simply does not persist.
  }
}

const STARS_KEY = 'ari.mobile.stars'

function readStars(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STARS_KEY) ?? '[]')
    if (Array.isArray(parsed)) return parsed.filter((entry): entry is string => typeof entry === 'string')
  } catch {
    // A corrupt entry is forgotten, not fatal.
  }
  return []
}

function writeStars(stars: string[]): void {
  try {
    localStorage.setItem(STARS_KEY, JSON.stringify(stars))
  } catch {
    // Private browsing may refuse storage; the stars simply do not persist.
  }
}
