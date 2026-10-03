import { useState, type ReactNode } from 'react'
import type { Session } from '@ari/contracts/session'
import { BottomSheet } from '../../components/ui'
import { useApp } from '../../lib/app-state'
import { ForkSheet } from './ForkSheet'

/** Editable session metadata uses the desktop's model catalog and permission ceiling. */
export function SessionDetails({
  session,
  onClose,
  onChanged,
  onArchive,
  onForked,
}: {
  session: Session
  onClose: () => void
  onChanged: () => Promise<void>
  onArchive?: () => void
  onForked?: (id: string) => void
}): ReactNode {
  const app = useApp()
  const [title, setTitle] = useState(session.title)
  const [model, setModel] = useState(session.modelId ?? '')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [forking, setForking] = useState(false)
  const editable =
    app.connection === 'connected' && app.session?.supports('session.update') === true
  const models =
    app.catalog?.providers.find((provider) => provider.driverKind === session.driverKind)?.models ??
    []
  async function save(): Promise<void> {
    setBusy(true)
    try {
      await app.session?.send({
        op: 'session.update',
        sessionId: session.id,
        title: title.trim(),
        ...(model === (session.modelId ?? '') ? {} : { modelId: model || null }),
      })
      await onChanged()
      await app.refresh()
      onClose()
    } catch (error) {
      setFailure(error instanceof Error ? error.message : 'Could not save this session.')
    } finally {
      setBusy(false)
    }
  }
  if (forking && onForked !== undefined)
    return <ForkSheet parent={session} onClose={() => setForking(false)} onForked={onForked} />
  return (
    <BottomSheet title="Session details" onClose={onClose}>
      <form
        className="space-y-4 pb-3"
        onSubmit={(event) => {
          event.preventDefault()
          void save()
        }}
      >
        <label className="block text-xs text-fg-muted">
          Session name
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            maxLength={200}
            disabled={!editable || busy}
            className="mt-2 min-h-12 w-full rounded-xl border border-border bg-surface-1 px-3 text-fg"
          />
        </label>
        <label className="block text-xs text-fg-muted">
          Model
          <select
            value={model}
            onChange={(event) => setModel(event.target.value)}
            disabled={!editable || busy || session.status === 'running'}
            className="mt-2 min-h-12 w-full rounded-xl border border-border bg-surface-1 px-3 text-fg"
          >
            <option value="">Desktop default</option>
            {!models.some((entry) => entry.id === model) && model !== '' && (
              <option value={model}>{model}</option>
            )}
            {models.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.label}
              </option>
            ))}
          </select>
        </label>
        <dl className="divide-y divide-border text-sm">
          {[
            ['Provider', session.driverKind],
            ['Permissions', session.permissionMode],
            ['Status', session.status],
            ['Workspace', session.workspace?.kind ?? 'project'],
          ].map(([label, value]) => (
            <div key={label} className="flex justify-between gap-3 py-3">
              <dt className="text-fg-muted">{label}</dt>
              <dd className="truncate">{value}</dd>
            </div>
          ))}
        </dl>
        <p className="text-xs leading-relaxed text-fg-subtle">
          Permission limits are set on your computer. Model changes apply when the session is idle.
        </p>
        {failure !== null && (
          <p role="alert" className="error-banner">
            {failure}
          </p>
        )}
        {editable && (
          <button type="submit" className="primary-button w-full" disabled={busy || !title.trim()}>
            {busy ? 'Saving…' : 'Save changes'}
          </button>
        )}
        {onForked !== undefined && app.session?.supports('session.fork') === true && (
          <button
            type="button"
            className="secondary-button w-full"
            disabled={busy || app.connection !== 'connected'}
            onClick={() => setForking(true)}
          >
            Fork session
          </button>
        )}
        {onArchive !== undefined && (
          <button
            type="button"
            className="secondary-button w-full text-danger"
            disabled={busy}
            onClick={onArchive}
          >
            Archive session
          </button>
        )}
      </form>
    </BottomSheet>
  )
}
