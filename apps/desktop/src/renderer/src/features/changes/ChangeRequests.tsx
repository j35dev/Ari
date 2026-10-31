import { useEffect, useState } from 'react'
import type { GitScope, HostConnection } from '@ari/contracts/rpc'
import { createLogger } from '@ari/shared/logger'
import { rpc } from '../../lib/rpc'

const log = createLogger('ui:change-requests')

/** Open pull or merge requests for the recognized remote. Unsupported forges stay explicit. */
export function ChangeRequests({
  scope,
  onCheckedOut,
}: {
  scope: GitScope | null
  onCheckedOut?: (path: string) => Promise<void> | void
}) {
  const [attempt, setAttempt] = useState(0)
  const [checkout, setCheckout] = useState<
    | { phase: 'confirm' | 'running' | 'done'; number: number }
    | { phase: 'error'; number: number; message: string }
    | null
  >(null)
  const [state, setState] = useState<
    | { kind: 'hidden' }
    | { kind: 'loading' }
    | { kind: 'ready'; value: HostConnection }
    | { kind: 'error'; message: string }
  >({ kind: 'hidden' })
  const scopeKey = scope ? JSON.stringify(scope) : ''
  useEffect(() => {
    if (!scope) return
    let cancelled = false
    setState({ kind: 'loading' })
    void rpc
      .invoke('scm.requests', scope)
      .then((result) => {
        if (cancelled) return
        setState(
          result.ok
            ? { kind: 'ready', value: result.value }
            : { kind: 'error', message: result.error.message },
        )
      })
      .catch((error: unknown) => {
        log.warn('Change requests unavailable', { error: String(error) })
        if (!cancelled) setState({ kind: 'error', message: 'Could not load change requests.' })
      })
    return () => {
      cancelled = true
    }
  }, [scopeKey, attempt])
  if (!scope || state.kind === 'hidden') return null
  const provider = state.kind === 'ready' ? state.value.repository?.provider : undefined
  const canCheckout = provider === 'github' || provider === 'gitlab'
  const open = (url: string): void => {
    void rpc.invoke('shell.openUrl', { url }).catch((error: unknown) => {
      log.warn('Could not open change request', { error: String(error) })
    })
  }
  const createWorktree = (): void => {
    if (!scope || checkout?.phase !== 'confirm') return
    const number = checkout.number
    setCheckout({ phase: 'running', number })
    void rpc
      .invoke('scm.checkout', { ...scope, number })
      .then(async (result) => {
        if (!result.ok) {
          setCheckout({ phase: 'error', number, message: result.error.message })
          return
        }
        setCheckout({ phase: 'done', number })
        await onCheckedOut?.(result.value.path)
      })
      .catch((error: unknown) => {
        log.warn('Could not check out change request', { error: String(error) })
        setCheckout({ phase: 'error', number, message: 'Could not check out the request.' })
      })
  }
  return (
    <section className="shrink-0 border-b border-border px-3 py-2" aria-label="Change requests">
      {state.kind === 'loading' ? (
        <p role="status" className="text-2xs text-fg-subtle">
          Checking the hosting remote…
        </p>
      ) : null}
      {state.kind === 'error' ? (
        <p role="alert" className="text-2xs text-danger">
          {state.message}
          <button
            type="button"
            className="ml-2 underline"
            onClick={() => setAttempt((value) => value + 1)}
          >
            Retry
          </button>
        </p>
      ) : null}
      {state.kind === 'ready' ? (
        <>
          <p className="text-2xs text-fg-muted">
            {state.value.repository
              ? `${state.value.repository.name} · ${state.value.detail}`
              : state.value.detail}
          </p>
          {checkout?.phase === 'confirm' ? (
            <p className="mt-1 text-2xs text-fg-muted">
              {onCheckedOut
                ? `Create a worktree for #${checkout.number} and open a session there? The current checkout stays as it is.`
                : `Create a worktree for #${checkout.number}? The current checkout stays as it is.`}
              <button type="button" className="ml-2 underline" onClick={createWorktree}>
                Create worktree
              </button>
              <button type="button" className="ml-2 underline" onClick={() => setCheckout(null)}>
                Cancel
              </button>
            </p>
          ) : null}
          {checkout?.phase === 'running' ? (
            <p role="status" className="mt-1 text-2xs text-fg-subtle">
              Checking out #{checkout.number}…
            </p>
          ) : null}
          {checkout?.phase === 'done' ? (
            <p role="status" className="mt-1 text-2xs text-fg-muted">
              Checked out #{checkout.number}. The current checkout was left unchanged.
            </p>
          ) : null}
          {checkout?.phase === 'error' ? (
            <p role="alert" className="mt-1 text-2xs text-danger">
              {checkout.message}
            </p>
          ) : null}
          {state.value.requests.length > 0 ? (
            <ul className="ari-scroll mt-1 max-h-28 overflow-auto">
              {state.value.requests.map((request) => (
                <li key={request.number} className="flex items-center gap-1">
                  <button
                    type="button"
                    className="block min-w-0 flex-1 truncate rounded-sm px-1 text-left font-mono text-2xs text-fg hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-ring"
                    onClick={() => open(request.url)}
                  >
                    {request.draft ? 'Draft · ' : ''}#{request.number} {request.title}
                  </button>
                  {canCheckout ? (
                    <button
                      type="button"
                      className="shrink-0 rounded-sm px-1 text-2xs text-fg-muted underline hover:text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-ring"
                      aria-label={`Check out #${request.number}`}
                      disabled={checkout?.phase === 'running'}
                      onClick={() => setCheckout({ phase: 'confirm', number: request.number })}
                    >
                      Check out
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : null}
    </section>
  )
}
