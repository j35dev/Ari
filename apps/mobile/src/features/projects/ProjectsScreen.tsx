import { useEffect, useState, type ReactNode } from 'react'
import type { RemoteModelCatalog } from '@ari/contracts/remote'
import { useApp } from '../../lib/app-state'
import { sessionIdOf } from '../../lib/command-result'

/**
 * Projects, and starting work in one (ADR §14).
 *
 * The flow is deliberately short — project, provider, prompt, start — because
 * a phone is the wrong place for a configuration screen. What is *not* here
 * matters as much: no permission mode, no filesystem root, no provider login.
 * The desktop's ceiling applies and mobile cannot raise it.
 */
export function ProjectsScreen({ onOpen }: { onOpen: (sessionId: string) => void }): ReactNode {
  const app = useApp()
  const [chosen, setChosen] = useState<string | null>(null)
  const [prompt, setPrompt] = useState('')
  const [provider, setProvider] = useState('')
  const [model, setModel] = useState('')
  const [catalog, setCatalog] = useState<RemoteModelCatalog | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const canCreate = app.session?.supports('session.create') ?? false
  const canListModels = app.session?.supports('models.list') ?? false

  // The desktop's runnable providers, asked once per expansion: the catalog
  // is small and the desktop's own picker reads the same merged snapshot.
  useEffect(() => {
    if (chosen === null || !canListModels || app.session === null) return
    const session = app.session
    let cancelled = false
    setCatalog(null)
    void session
      .query<RemoteModelCatalog>('models.list')
      .then((next) => {
        if (!cancelled) setCatalog(next)
      })
      .catch(() => {
        // An unreadable catalog must not block creation: the desktop's
        // defaults still apply, and the selects simply stay hidden.
        if (!cancelled) setCatalog(null)
      })
    return () => {
      cancelled = true
    }
  }, [chosen, canListModels, app.session])

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

  return (
    <div className="h-full overflow-y-auto px-4 pb-6 pt-4">
      <h1 className="text-sm font-medium">Projects the desktop shared with this phone</h1>

      {!canCreate && (
        <p className="mt-3 rounded-md border border-border bg-surface-1 p-3 text-sm text-fg-muted">
          This desktop does not accept new sessions from a phone right now. Existing sessions are
          still available under Sessions.
        </p>
      )}

      {error !== null && (
        <p role="alert" className="mt-3 rounded-md border border-danger bg-danger-subtle p-3 text-sm">
          {error}
        </p>
      )}

      <ul className="mt-3 space-y-2">
        {app.projects.map((project) => (
          <li key={project.id} className="rounded-xl border border-border bg-surface-1 p-4">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-[15px] font-medium tracking-tight">{project.name}</p>
                <p className="mt-0.5 text-xs text-fg-subtle">
                  {project.sessionCount} session{project.sessionCount === 1 ? '' : 's'}
                </p>
              </div>
              <button
                type="button"
                disabled={!canCreate}
                onClick={() => setChosen(chosen === project.id ? null : project.id)}
                className="h-11 shrink-0 rounded-lg bg-surface-2 px-4 text-sm font-medium disabled:opacity-50"
              >
                New
              </button>
            </div>

            {chosen === project.id && (
              <form
                className="mt-3 space-y-2"
                onSubmit={(event) => {
                  event.preventDefault()
                  void start(project.id)
                }}
              >
                {catalog !== null && catalog.providers.length > 0 && (
                  <>
                    <label
                      className="block text-xs text-fg-muted"
                      htmlFor={`provider-${project.id}`}
                    >
                      Provider
                    </label>
                    <select
                      id={`provider-${project.id}`}
                      value={provider}
                      onChange={(event) => chooseProvider(event.target.value)}
                      className="h-11 w-full rounded-xl border border-border bg-bg px-3"
                    >
                      <option value="">Desktop default</option>
                      {catalog.providers.map((entry) => (
                        <option key={entry.driverKind} value={entry.driverKind}>
                          {entry.driverKind}
                        </option>
                      ))}
                    </select>
                    {provider.length > 0 && (
                      <>
                        <label
                          className="block text-xs text-fg-muted"
                          htmlFor={`model-${project.id}`}
                        >
                          Model
                        </label>
                        <select
                          id={`model-${project.id}`}
                          value={model}
                          onChange={(event) => chooseModel(event.target.value)}
                          className="h-11 w-full rounded-xl border border-border bg-bg px-3"
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
                      </>
                    )}
                  </>
                )}
                <label className="block text-xs text-fg-muted" htmlFor={`prompt-${project.id}`}>
                  First message (optional)
                </label>
                <textarea
                  id={`prompt-${project.id}`}
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  rows={3}
                  className="w-full resize-none rounded-md border border-border bg-bg p-3"
                />
                <button
                  type="submit"
                  disabled={busy}
                  className="h-12 w-full rounded-xl bg-accent font-medium text-fg-on-accent disabled:opacity-50"
                >
                  {busy ? 'Starting…' : 'Start session'}
                </button>
              </form>
            )}
          </li>
        ))}
      </ul>

      {app.projects.length === 0 && (
        <p className="mt-4 text-sm text-fg-muted">
          No projects are shared with this device. Pair again from the desktop and choose which
          projects this phone may reach.
        </p>
      )}
    </div>
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
