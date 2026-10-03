import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { Session } from '@ari/contracts/session'
import type { DriverKind } from '@ari/contracts/common'
import { BottomSheet } from '../../components/ui'
import { useApp } from '../../lib/app-state'
import { sessionIdOf } from '../../lib/command-result'
import { routeUrl } from '../../lib/routes'
import { ForkRequestStore, type ForkRequest } from './fork-request'

/** Create an isolated child through desktop delegation, retaining one immutable receipt. */
export function ForkSheet({
  parent,
  onClose,
  onForked,
}: {
  parent: Session
  onClose: () => void
  onForked: (id: string) => void
}): ReactNode {
  const app = useApp()
  const store = useMemo(
    () => new ForkRequestStore(app.origin, app.session?.deviceId ?? null, parent.id),
    [app.origin, app.session?.deviceId, parent.id],
  )
  const [pending, setPending] = useState<ForkRequest | null>(() => store.read())
  const [title, setTitle] = useState(
    () => pending?.title ?? `Fork: ${parent.title || 'Untitled session'}`.slice(0, 120),
  )
  const [provider, setProvider] = useState<DriverKind>(
    () => pending?.driverKind ?? parent.driverKind,
  )
  const [model, setModel] = useState(
    () => pending?.modelId ?? (provider === parent.driverKind ? (parent.modelId ?? '') : ''),
  )
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const alive = useRef(true)
  const inFlight = useRef(false)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  const connected =
    app.connection === 'connected' &&
    app.session?.supports('session.fork') === true &&
    app.session.deviceId !== null
  const locked = busy || pending !== null
  const models = app.catalog?.providers.find((entry) => entry.driverKind === provider)?.models ?? []
  async function fork(): Promise<void> {
    const session = app.session
    if (
      inFlight.current ||
      session === null ||
      !connected ||
      !title.trim() ||
      title.trim().length > 120
    )
      return
    inFlight.current = true
    setBusy(true)
    setFailure(null)
    try {
      const request = pending ?? {
        key: crypto.randomUUID(),
        title: title.trim(),
        driverKind: provider,
        ...(model === '' ? {} : { modelId: model }),
      }
      store.write(request)
      setPending(request)
      const { key, ...fields } = request
      const result = await session.send(
        { op: 'session.fork', sessionId: parent.id, ...fields },
        key,
      )
      const id = sessionIdOf(result)
      if (id === null)
        throw new Error(
          'The desktop did not confirm the child session. Inspect the parent or retry this same fork.',
        )
      await app
        .refresh()
        .catch((error: unknown) =>
          console.warn('Fork created, but the workspace could not refresh', error),
        )
      if (!alive.current) return
      store.clear()
      onForked(id)
    } catch (error) {
      if (alive.current)
        setFailure(
          error instanceof Error
            ? error.message
            : 'Could not confirm the fork. Retry checks the same request.',
        )
    } finally {
      inFlight.current = false
      if (alive.current) setBusy(false)
    }
  }
  return (
    <BottomSheet title="Fork session" onClose={onClose}>
      <form
        className="space-y-4 py-3"
        onSubmit={(event) => {
          event.preventDefault()
          void fork()
        }}
      >
        <p className="text-sm leading-relaxed text-fg-muted">
          Start an isolated child task from{' '}
          <span className="font-medium text-fg">{parent.title || 'this session'}</span>. Its context
          comes from the parent; delegation and permissions follow your desktop policy.
        </p>
        <label className="block text-xs text-fg-muted">
          Fork name
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            maxLength={120}
            disabled={locked}
            className="mt-2 min-h-12 w-full rounded-xl border border-border bg-surface-1 px-3 text-fg"
          />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block text-xs text-fg-muted">
            Agent
            <select
              value={provider}
              onChange={(event) => {
                const next = event.target.value as DriverKind
                setProvider(next)
                setModel(next === parent.driverKind ? (parent.modelId ?? '') : '')
              }}
              disabled={locked}
              className="mt-2 min-h-12 w-full rounded-xl border border-border bg-surface-1 px-3 text-fg"
            >
              {!app.catalog?.providers.some((entry) => entry.driverKind === provider) && (
                <option value={provider}>{provider}</option>
              )}
              {app.catalog?.providers.map((entry) => (
                <option
                  key={entry.driverKind}
                  value={entry.driverKind}
                  disabled={entry.available === false}
                >
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
              disabled={locked || models.length === 0}
              className="mt-2 min-h-12 w-full rounded-xl border border-border bg-surface-1 px-3 text-fg"
            >
              <option value="">
                {provider === parent.driverKind && parent.modelId !== null
                  ? 'Parent model'
                  : 'Provider default'}
              </option>
              {model !== '' && !models.some((entry) => entry.id === model) && (
                <option value={model}>{model}</option>
              )}
              {models.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        {(busy || pending !== null) && (
          <div
            role="status"
            className="rounded-xl border border-border bg-surface-1 p-3 text-xs leading-relaxed text-fg-muted"
          >
            <p>
              {busy
                ? 'Waiting for your computer to confirm the child task.'
                : 'This fork has an outstanding receipt. Retry checks the same request.'}
            </p>
            <p className="mt-2">
              Your agent may need native approval. Creation can wait up to five minutes; you can
              leave this sheet and return safely.
            </p>
            <a
              className="mt-2 inline-flex min-h-11 items-center font-medium text-fg"
              href={routeUrl({ destination: 'now', sessionId: null }, location.href)}
            >
              Open Inbox for approvals
            </a>
          </div>
        )}
        {!connected && (
          <p role="status" className="text-xs text-fg-muted">
            Reconnect to a desktop that supports isolated child tasks.
          </p>
        )}
        {failure !== null && (
          <p role="alert" className="error-banner">
            {failure}
          </p>
        )}
        <button
          type="submit"
          className="primary-button w-full"
          disabled={busy || !connected || !title.trim() || title.trim().length > 120}
        >
          {busy ? 'Waiting for desktop…' : pending !== null ? 'Retry same fork' : 'Create fork'}
        </button>
      </form>
    </BottomSheet>
  )
}
