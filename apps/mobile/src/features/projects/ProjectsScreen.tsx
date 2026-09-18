import { useState, type ReactNode } from 'react'
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
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const canCreate = app.session?.supports('session.create') ?? false

  async function start(projectId: string): Promise<void> {
    if (app.session === null) return
    setBusy(true)
    setError(null)
    try {
      const created = await app.session.send({
        op: 'session.create',
        projectId,
        // Left out entirely when the user did not name one, so the desktop's
        // configured default applies rather than an empty string reaching a
        // check it would fail.
        ...(provider.trim().length === 0 ? {} : { driverKind: provider.trim() }),
      })
      const sessionId = sessionIdOf(created)
      if (sessionId === null) throw new Error('the desktop did not name the new session')
      if (prompt.trim().length > 0) {
        await app.session.send({ op: 'session.prompt', sessionId, text: prompt.trim() })
      }
      setPrompt('')
      setChosen(null)
      setProvider('')
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
          <li key={project.id} className="rounded-lg border border-border bg-surface-1 p-3">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-sm">{project.name}</p>
                <p className="text-2xs text-fg-subtle">
                  {project.sessionCount} session{project.sessionCount === 1 ? '' : 's'}
                </p>
              </div>
              <button
                type="button"
                disabled={!canCreate}
                onClick={() => setChosen(chosen === project.id ? null : project.id)}
                className="h-11 shrink-0 rounded-md border border-border px-3 text-sm disabled:opacity-50"
              >
                New session
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
                <label className="block text-xs text-fg-muted" htmlFor={`provider-${project.id}`}>
                  Provider (optional — the desktop's default is used otherwise)
                </label>
                <input
                  id={`provider-${project.id}`}
                  value={provider}
                  onChange={(event) => setProvider(event.target.value)}
                  placeholder="claude, codex, …"
                  autoCapitalize="none"
                  className="h-11 w-full rounded-md border border-border bg-bg px-3"
                />
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
                  className="h-11 w-full rounded-md bg-accent text-fg-on-accent disabled:opacity-50"
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
