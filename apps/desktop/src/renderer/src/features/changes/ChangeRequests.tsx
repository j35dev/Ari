import { useEffect, useState } from 'react'
import { ExternalLink, GitPullRequest, RefreshCw, Search } from 'lucide-react'
import type { GitScope, HostConnection } from '@ari/contracts/rpc'
import { rpc } from '../../lib/rpc'
import { SourceControlMark } from './SourceControlMark'
import { RequestReview } from './RequestReview'

export function ChangeRequests({
  scope,
  onCheckedOut,
}: {
  scope: GitScope | null
  onCheckedOut?: (path: string) => Promise<void> | void
}) {
  if (!scope)
    return (
      <div className="p-8 text-center text-sm text-fg-subtle">
        Open a project to review its pull or merge requests.
      </div>
    )
  return <ScopedRequests key={JSON.stringify(scope)} scope={scope} onCheckedOut={onCheckedOut} />
}

function ScopedRequests({
  scope,
  onCheckedOut,
}: {
  scope: GitScope
  onCheckedOut?: (path: string) => Promise<void> | void
}) {
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<{
    value: HostConnection | null
    loading: boolean
    error: string | null
  }>({ value: null, loading: true, error: null })
  const [selected, setSelected] = useState<number | null>(null)
  const [query, setQuery] = useState('')
  useEffect(() => {
    let live = true
    const requestId = crypto.randomUUID()
    setState((state) => ({ ...state, loading: true, error: null }))
    void rpc
      .invoke('scm.requests', { ...scope, requestId })
      .then((result) => {
        if (live)
          setState(
            result.ok
              ? { value: result.value, loading: false, error: null }
              : { value: null, loading: false, error: result.error.message },
          )
      })
      .catch(() => {
        if (live)
          setState({
            value: null,
            loading: false,
            error: 'Could not load change requests. Refresh to retry.',
          })
      })
    return () => {
      live = false
      void rpc.invoke('scm.cancel', { requestId }).catch(() => undefined)
    }
  }, [attempt, scope])
  const requests =
    state.value?.requests.filter((request) =>
      `${request.number} ${request.title} ${request.author} ${request.head}`
        .toLowerCase()
        .includes(query.toLowerCase()),
    ) ?? []
  return (
    <section aria-label="Change requests" className="@container flex h-full min-h-0 flex-col bg-bg">
      {selected !== null ? (
        <RequestReview
          key={selected}
          scope={scope}
          number={selected}
          onBack={() => {
            setSelected(null)
            setAttempt((value) => value + 1)
          }}
          onCheckedOut={onCheckedOut}
        />
      ) : (
        <>
          <header className="flex min-h-14 shrink-0 items-center gap-3 border-b border-border/60 px-4">
            <span className="text-fg-muted">
              <SourceControlMark provider={state.value?.repository?.provider ?? null} />
            </span>
            <div className="min-w-0 flex-1">
              <h2 className="truncate text-sm font-semibold text-fg">
                {state.value?.repository?.name ?? 'Pull & merge requests'}
              </h2>
              <p className="mt-0.5 text-xs text-fg-subtle">
                {state.loading
                  ? 'Reading the hosting remote…'
                  : (state.value?.detail ?? 'Your repository on its hosting service')}
              </p>
            </div>
            {state.value?.repository ? (
              <button
                type="button"
                aria-label="Open repository on host"
                onClick={() =>
                  void rpc
                    .invoke('shell.openUrl', { url: state.value!.repository!.url })
                    .catch(() =>
                      setState((state) => ({
                        ...state,
                        error: 'Could not open the repository on its host.',
                      })),
                    )
                }
                className="rounded-md p-1.5 text-fg-subtle hover:bg-surface-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
              >
                <ExternalLink size={14} />
              </button>
            ) : null}
            <button
              type="button"
              aria-label="Refresh requests"
              disabled={state.loading}
              onClick={() => setAttempt((value) => value + 1)}
              className="rounded-md p-1.5 text-fg-subtle hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring disabled:opacity-40"
            >
              <RefreshCw size={14} className={state.loading ? 'animate-spin' : ''} />
            </button>
          </header>
          {state.error ? (
            <p
              role="alert"
              className="border-b border-danger/20 bg-danger-subtle px-4 py-3 text-xs text-danger"
            >
              {state.error}
              <button
                type="button"
                className="ml-2 underline"
                onClick={() => setAttempt((value) => value + 1)}
              >
                Retry
              </button>
            </p>
          ) : null}
          {state.value?.requests.length ? (
            <label className="mx-4 my-3 flex shrink-0 items-center gap-2 rounded-md border border-border/60 px-3">
              <Search size={13} className="text-fg-subtle" />
              <input
                aria-label="Filter requests"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                maxLength={256}
                placeholder="Find a request, branch or author…"
                className="h-9 min-w-0 flex-1 bg-transparent text-xs text-fg placeholder:text-fg-subtle focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-ring"
              />
            </label>
          ) : null}
          <div className="ari-scroll min-h-0 flex-1 overflow-auto">
            {state.loading && !state.value ? (
              <div role="status" aria-label="Loading requests" className="space-y-4 p-4">
                {[1, 2, 3].map((value) => (
                  <div key={value} className="space-y-2 border-b border-border/50 pb-4">
                    <div className="h-3 w-3/4 animate-pulse rounded bg-surface-2" />
                    <div className="h-2 w-1/2 animate-pulse rounded bg-surface-2" />
                  </div>
                ))}
              </div>
            ) : requests.length ? (
              <ul className="mx-auto max-w-5xl divide-y divide-border/50 px-3 pb-4">
                {requests.map((request) => (
                  <li key={request.number}>
                    <button
                      type="button"
                      onClick={() => setSelected(request.number)}
                      className="group flex w-full items-start gap-3 rounded-md px-3 py-4 text-left transition-colors hover:bg-surface-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
                    >
                      <GitPullRequest
                        size={17}
                        className={`mt-0.5 shrink-0 ${request.draft ? 'text-fg-subtle' : 'text-success'}`}
                        aria-hidden
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-medium leading-snug text-fg">
                          {request.title}
                        </span>
                        <span className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-fg-subtle">
                          <span className="font-mono">#{request.number}</span>
                          <span>{request.author}</span>
                          <span className="font-mono text-2xs">
                            {request.head} → {request.base}
                          </span>
                          {request.draft ? (
                            <span className="rounded bg-surface-2 px-1.5 py-0.5 text-2xs">
                              Draft
                            </span>
                          ) : null}
                        </span>
                      </span>
                      <span className="hidden text-2xs text-fg-subtle @[44rem]:block">
                        Review →
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : !state.error && !state.loading ? (
              <div className="flex h-full min-h-48 flex-col items-center justify-center gap-3 p-8 text-center">
                <GitPullRequest size={28} className="text-fg-subtle" />
                <h3 className="text-sm font-medium text-fg">
                  {query
                    ? 'No matching requests'
                    : state.value?.repository
                      ? 'No open requests'
                      : 'Connect your hosting service'}
                </h3>
                <p className="max-w-sm text-xs leading-relaxed text-fg-muted">
                  {query
                    ? 'Try a title, branch name or request number.'
                    : state.value?.repository
                      ? 'Publish a feature branch, then create a pull or merge request from Git actions.'
                      : 'Add a hosting connection in Settings → Source control for your repository.'}
                </p>
              </div>
            ) : null}
          </div>
        </>
      )}
    </section>
  )
}
