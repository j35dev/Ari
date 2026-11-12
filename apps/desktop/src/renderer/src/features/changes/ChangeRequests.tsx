import { useEffect, useState } from 'react'
import { ExternalLink, GitPullRequest, RefreshCw, Search } from 'lucide-react'
import type { GitScope, HostConnection } from '@ari/contracts/rpc'
import { rpc } from '../../lib/rpc'
import { iconButton } from '../../lib/recipes'
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
      <div className="p-8 text-center text-[13px] text-fg-subtle">
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
    let timer: ReturnType<typeof setTimeout> | undefined
    const invalidate = (): void => {
      if (document.hidden || timer) return
      timer = setTimeout(() => {
        timer = undefined
        setAttempt((value) => value + 1)
      }, 300)
    }
    const off = rpc.subscribe('scm.changed', scope, invalidate)
    window.addEventListener('focus', invalidate)
    document.addEventListener('visibilitychange', invalidate)
    return () => {
      off()
      clearTimeout(timer)
      window.removeEventListener('focus', invalidate)
      document.removeEventListener('visibilitychange', invalidate)
    }
  }, [scope])
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
          <header className="flex min-h-12 shrink-0 items-center gap-1 border-b border-border py-1.5 pl-4 pr-2">
            <span className="mr-2 shrink-0 text-fg-subtle">
              <SourceControlMark provider={state.value?.repository?.provider ?? null} size={16} />
            </span>
            <div className="min-w-0 flex-1">
              <h2 className="truncate text-sm font-medium text-fg">
                {state.value?.repository?.name ?? 'Pull & merge requests'}
              </h2>
              <p className="truncate text-xs text-fg-subtle">
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
                className={iconButton}
              >
                <ExternalLink size={14} />
              </button>
            ) : null}
            <button
              type="button"
              aria-label="Refresh requests"
              disabled={state.loading}
              onClick={() => setAttempt((value) => value + 1)}
              className={iconButton}
            >
              <RefreshCw size={14} className={state.loading ? 'animate-spin' : ''} />
            </button>
          </header>
          {state.error ? (
            <p role="alert" className="border-b border-border px-4 py-2.5 text-[13px] text-danger">
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
            <label className="mx-3 mt-3 flex shrink-0 items-center gap-2 rounded-md border border-border bg-surface-1 px-2.5 transition-colors hover:border-border-strong focus-within:border-border-strong focus-within:ring-2 focus-within:ring-accent-ring">
              <Search size={14} className="shrink-0 text-fg-subtle" aria-hidden />
              <input
                aria-label="Filter requests"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                maxLength={256}
                placeholder="Find a request, branch or author…"
                className="h-8 min-w-0 flex-1 bg-transparent text-[13px] text-fg outline-none placeholder:text-fg-subtle"
              />
            </label>
          ) : null}
          <div className="ari-scroll min-h-0 flex-1 overflow-auto">
            {state.loading && !state.value ? (
              <div role="status" aria-label="Loading requests" className="space-y-5 p-4">
                {[1, 2, 3].map((value) => (
                  <div key={value} className="space-y-2">
                    <div className="h-3 w-3/4 animate-pulse rounded bg-fg/6" />
                    <div className="h-2 w-1/2 animate-pulse rounded bg-fg/6" />
                  </div>
                ))}
              </div>
            ) : requests.length ? (
              <ul className="mx-auto max-w-5xl px-2 pb-4 pt-2">
                {requests.map((request) => (
                  <li key={request.number}>
                    <button
                      type="button"
                      onClick={() => setSelected(request.number)}
                      className="group flex w-full items-start gap-2.5 rounded-md px-2 py-2.5 text-left transition-colors hover:bg-fg/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
                    >
                      <GitPullRequest
                        size={14}
                        className={`mt-[3px] shrink-0 ${request.draft ? 'text-fg-subtle' : 'text-fg-muted'}`}
                        aria-hidden
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-medium leading-snug text-fg">
                          {request.title}
                        </span>
                        <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-fg-subtle">
                          <span className="font-mono">#{request.number}</span>
                          <span>{request.author}</span>
                          <span className="font-mono">
                            {request.head} → {request.base}
                          </span>
                          {request.draft ? (
                            <span className="rounded-sm bg-fg/6 px-1.5 text-fg-muted">Draft</span>
                          ) : null}
                        </span>
                      </span>
                      <span className="hidden text-xs text-fg-subtle @[44rem]:block">Review →</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : !state.error && !state.loading ? (
              <div className="flex h-full min-h-48 flex-col items-center justify-center gap-2 p-8 text-center">
                <GitPullRequest size={24} className="mb-1 text-fg-subtle" aria-hidden />
                <h3 className="text-sm font-medium text-fg">
                  {query
                    ? 'No matching requests'
                    : state.value?.repository
                      ? 'No open requests'
                      : 'Repository remote unavailable'}
                </h3>
                <p className="max-w-sm text-[13px] leading-relaxed text-fg-subtle">
                  {query
                    ? 'Try a title, branch name or request number.'
                    : state.value?.repository
                      ? 'Publish a feature branch, then create a pull or merge request from Git actions.'
                      : state.value?.detail}
                </p>
              </div>
            ) : null}
          </div>
        </>
      )}
    </section>
  )
}
