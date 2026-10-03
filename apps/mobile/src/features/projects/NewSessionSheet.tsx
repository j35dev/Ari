import { useState, type ReactNode } from 'react'
import { BottomSheet } from '../../components/ui'
import { EmptyState } from '../../components/EmptyState'
import { useApp } from '../../lib/app-state'
import { sessionIdOf } from '../../lib/command-result'
import { writeDraft } from '../../lib/draft'
import { readCreation, writeCreation, type NewSessionRequest } from '../../lib/new-session'
import { RemoteError } from '../../lib/gateway-client'

/** Create once, retaining the receipt through a lost response, and hand the draft to the thread. */
export function NewSessionSheet({
  onClose,
  onOpen,
  projectId,
}: {
  onClose: () => void
  onOpen: (id: string) => void
  projectId?: string
}): ReactNode {
  const app = useApp()
  const deviceId = app.session?.deviceId ?? null
  const [restored] = useState(() => readCreation(app.origin, deviceId))
  const [project, setProject] = useState(
    restored?.projectId ?? projectId ?? app.projects[0]?.id ?? '',
  )
  const [provider, setProvider] = useState(restored?.driverKind ?? '')
  const [model, setModel] = useState(restored?.modelId ?? '')
  const [draft, setDraft] = useState(restored?.draft ?? '')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(
    restored === null
      ? null
      : 'An unconfirmed creation was restored. Retry checks the same receipt.',
  )
  const [pending, setPending] = useState<NewSessionRequest | null>(restored)
  async function create(): Promise<void> {
    if (busy || app.session === null || !project) return
    const command = pending ?? {
      key: crypto.randomUUID(),
      projectId: project,
      driverKind: provider,
      modelId: model,
      draft,
    }
    if (!writeCreation(app.origin, deviceId, command)) {
      setFailure(
        'This browser cannot preserve the creation receipt. Free browser storage before creating a session.',
      )
      return
    }
    setPending(command)
    setBusy(true)
    setFailure(null)
    try {
      const outcome = await app.session.send(
        {
          op: 'session.create',
          projectId: command.projectId,
          ...(command.driverKind === '' ? {} : { driverKind: command.driverKind }),
          ...(command.modelId === '' ? {} : { modelId: command.modelId }),
        },
        command.key,
      )
      const id = sessionIdOf(outcome)
      if (id === null)
        throw new Error('The desktop did not return a session. Retry to check this same creation.')
      writeDraft(app.origin, id, command.draft, deviceId)
      writeCreation(app.origin, deviceId, null)
      setPending(null)
      await app
        .refresh()
        .catch((error: unknown) =>
          console.warn('Created session; refreshing the list failed', error),
        )
      onOpen(id)
    } catch (error) {
      setFailure(
        error instanceof Error
          ? error.message
          : 'Could not create this session. Retry checks the same request.',
      )
      if (
        error instanceof RemoteError &&
        !['unreachable', 'internal_error', 'conflict'].includes(error.code)
      ) {
        setPending(null)
        writeCreation(app.origin, deviceId, null)
      }
    } finally {
      setBusy(false)
    }
  }
  const models = app.catalog?.providers.find((entry) => entry.driverKind === provider)?.models ?? []
  return (
    <BottomSheet title="New session" onClose={onClose}>
      {app.projects.length === 0 ? (
        <EmptyState
          title="Share a project first"
          detail="Select the projects this phone can access in desktop Mobile access settings."
        />
      ) : (
        <form
          className="space-y-4 py-3"
          onSubmit={(event) => {
            event.preventDefault()
            void create()
          }}
        >
          <label className="block text-xs text-fg-muted">
            Project
            <select
              value={project}
              onChange={(event) => setProject(event.target.value)}
              disabled={pending !== null || busy}
              className="mt-2 min-h-12 w-full rounded-xl border border-border bg-surface-1 px-3 text-fg"
            >
              {app.projects.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name}
                </option>
              ))}
            </select>
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block text-xs text-fg-muted">
              Agent
              <select
                value={provider}
                onChange={(event) => {
                  setProvider(event.target.value)
                  setModel('')
                }}
                disabled={pending !== null || busy}
                className="mt-2 min-h-12 w-full rounded-xl border border-border bg-surface-1 px-3 text-fg"
              >
                <option value="">Desktop default</option>
                {app.catalog?.providers.map((entry) => (
                  <option key={entry.driverKind} value={entry.driverKind}>
                    {entry.driverKind}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-xs text-fg-muted">
              Model
              <select
                value={model}
                onChange={(event) => setModel(event.target.value)}
                disabled={pending !== null || busy || provider === ''}
                className="mt-2 min-h-12 w-full rounded-xl border border-border bg-surface-1 px-3 text-fg"
              >
                <option value="">Default</option>
                {models.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="block text-xs text-fg-muted">
            Task draft
            <textarea
              value={draft}
              disabled={pending !== null || busy}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="Describe what you'd like to build…"
              rows={4}
              className="mt-2 w-full resize-none rounded-xl border border-border bg-surface-1 p-3 text-fg"
            />
          </label>
          <p className="text-xs leading-relaxed text-fg-subtle">
            Review and send your draft inside the session. Permissions follow your desktop settings.
          </p>
          {failure !== null && (
            <p role="alert" className="error-banner">
              {failure}
            </p>
          )}
          <button
            type="submit"
            className="primary-button w-full"
            disabled={busy || !project || app.connection !== 'connected'}
          >
            {busy ? 'Creating…' : failure !== null ? 'Retry same creation' : 'Create session'}
          </button>
        </form>
      )}
    </BottomSheet>
  )
}
