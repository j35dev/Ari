import { useEffect, useState } from 'react'
import type { GitScope, HostConnection } from '@ari/contracts/rpc'
import { createLogger } from '@ari/shared/logger'
import { rpc } from '../../lib/rpc'

const log = createLogger('ui:change-requests')

/** Open pull or merge requests for the recognized remote. Unsupported forges stay explicit. */
export function ChangeRequests({ scope }: { scope: GitScope | null }) {
  const [attempt, setAttempt] = useState(0)
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
  const open = (url: string): void => {
    void rpc.invoke('shell.openUrl', { url }).catch((error: unknown) => {
      log.warn('Could not open change request', { error: String(error) })
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
          {state.value.requests.length > 0 ? (
            <ul className="ari-scroll mt-1 max-h-28 overflow-auto">
              {state.value.requests.map((request) => (
                <li key={request.number}>
                  <button
                    type="button"
                    className="block w-full truncate rounded-sm px-1 text-left font-mono text-2xs text-fg hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-ring"
                    onClick={() => open(request.url)}
                  >
                    {request.draft ? 'Draft · ' : ''}#{request.number} {request.title}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : null}
    </section>
  )
}
