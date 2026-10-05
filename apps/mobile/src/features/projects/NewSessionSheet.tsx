import { useState, type ReactNode } from 'react'
import { BottomSheet } from '../../components/ui'
import { EmptyState } from '../../components/EmptyState'
import { useApp } from '../../lib/app-state'
import { sessionIdOf } from '../../lib/command-result'
import { writeDraft } from '../../lib/draft'
import { readCreation, writeCreation, type NewSessionRequest } from '../../lib/new-session'
import { RemoteError } from '../../lib/gateway-client'
import type { PermissionMode } from '@ari/contracts/common'
import { ModelPicker, modelSelectionLabel } from '../../components/ModelPicker'
import { SessionControls } from '../../components/SessionControls'

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
  const [effort, setEffort] = useState<string | null>(restored?.effort ?? null)
  const [mode, setMode] = useState<PermissionMode | null>(restored?.permissionMode ?? null)
  const [draft, setDraft] = useState(restored?.draft ?? '')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(
    restored === null
      ? null
      : 'An unconfirmed creation was restored. Retry checks the same receipt.',
  )
  const [pending, setPending] = useState<NewSessionRequest | null>(restored)
  const [pickingModel, setPickingModel] = useState(false)
  async function create(): Promise<void> {
    if (busy || app.session === null || !project) return
    const command = pending ?? {
      key: crypto.randomUUID(),
      projectId: project,
      driverKind: provider,
      modelId: model,
      effort,
      permissionMode: mode,
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
          ...(command.permissionMode === null ? {} : { permissionMode: command.permissionMode }),
          ...(command.effort === null ? {} : { effort: command.effort }),
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
  if (pickingModel)
    return (
      <ModelPicker
        driverKind={provider}
        modelId={model}
        onClose={() => setPickingModel(false)}
        onSelect={(nextProvider, nextModel) => {
          // Levels belong to a provider and model, so a saved one may not carry over.
          if (nextProvider !== provider || nextModel !== model) setEffort(null)
          setProvider(nextProvider)
          setModel(nextModel)
        }}
      />
    )
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
          <div>
            <p className="text-xs text-fg-muted">Agent, effort and permissions</p>
            <div className="mt-2 flex min-h-11 items-center gap-1.5 overflow-x-auto">
              <SessionControls
                driverKind={provider || app.catalog?.defaults?.driverKind || ''}
                modelId={model}
                modelLabel={modelSelectionLabel(app.catalog, provider, model)}
                effort={effort}
                permissionMode={mode ?? app.catalog?.defaults?.permissionMode ?? 'ask'}
                disabled={pending !== null || busy}
                onPickModel={() => setPickingModel(true)}
                onEffort={setEffort}
                onMode={setMode}
              />
            </div>
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
            Review and send your draft inside the session.
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
