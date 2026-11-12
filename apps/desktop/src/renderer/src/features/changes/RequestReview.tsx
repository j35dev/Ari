import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, Check, ExternalLink, GitPullRequest, RefreshCw } from 'lucide-react'
import type { ChangeRequest, ChangeRequestAction, GitScope } from '@ari/contracts/rpc'
import { Button } from '@ari/ui/button'
import { Dialog } from '@ari/ui/dialog'
import { Select } from '@ari/ui/select'
import { rpc } from '../../lib/rpc'
import { cx, iconButton, tab as tabClass, tabSelected } from '../../lib/recipes'
import { parseDiff } from '../diffs/parseDiff'
import { DiffSurface } from '../diffs/DiffSurface'
import { RequestActions } from './RequestActions'

export function RequestReview({
  scope,
  number,
  onBack,
  onCheckedOut,
}: {
  scope: GitScope
  number: number
  onBack: () => void
  onCheckedOut?: (path: string) => Promise<void> | void
}) {
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<{
    request: ChangeRequest | null
    error: string | null
    loading: boolean
  }>({ request: null, error: null, loading: true })
  const [diff, setDiff] = useState<{ text: string; error: string | null; loading: boolean }>({
    text: '',
    error: null,
    loading: false,
  })
  const [tab, setTab] = useState<'overview' | 'files'>('overview')
  const [file, setFile] = useState('')
  const [checkout, setCheckout] = useState(false)
  const [checkingOut, setCheckingOut] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const key = JSON.stringify(scope)
  useEffect(() => {
    let live = true
    const requestId = crypto.randomUUID()
    setState((state) => ({ ...state, loading: true, error: null }))
    void rpc
      .invoke('scm.request', { ...scope, number, requestId })
      .then((result) => {
        if (live)
          setState(
            result.ok
              ? { request: result.value, error: null, loading: false }
              : { request: null, error: result.error.message, loading: false },
          )
      })
      .catch(() => {
        if (live)
          setState({
            request: null,
            error: 'Could not load this request. Refresh to retry.',
            loading: false,
          })
      })
    return () => {
      live = false
      void rpc.invoke('scm.cancel', { requestId }).catch(() => undefined)
    }
  }, [key, number, attempt])
  useEffect(() => {
    if (tab !== 'files' || !state.request || state.loading) return
    let live = true
    const requestId = crypto.randomUUID()
    setDiff({ text: '', error: null, loading: true })
    void rpc
      .invoke('scm.requestDiff', { ...scope, number, requestId })
      .then((result) => {
        if (live)
          setDiff(
            result.ok
              ? { text: result.value, error: null, loading: false }
              : { text: '', error: result.error.message, loading: false },
          )
      })
      .catch(() => {
        if (live) setDiff({ text: '', error: 'Could not load the request diff.', loading: false })
      })
    return () => {
      live = false
      void rpc.invoke('scm.cancel', { requestId }).catch(() => undefined)
    }
  }, [key, number, tab, attempt, state.request?.headOid, state.loading])
  const patches = useMemo(
    () =>
      diff.text
        .split(/(?=^diff --git )/m)
        .filter((text) => text.trim())
        .flatMap((text) => {
          const file = parseDiff(text).files[0]
          return file ? [{ file, text }] : []
        }),
    [diff.text],
  )
  const selected = patches.find((patch) => patch.file.path === file) ?? patches[0]
  const request = state.request
  const refresh = (): void => setAttempt((value) => value + 1)
  const action = async (action: ChangeRequestAction): Promise<{ ok: boolean; message: string }> => {
    try {
      const result = await rpc.invoke('scm.requestAction', { ...scope, number, action })
      refresh()
      return result.ok
        ? { ok: true, message: result.value.message }
        : { ok: false, message: result.error.message }
    } catch {
      refresh()
      return {
        ok: false,
        message: 'The action result could not be confirmed. Refresh before retrying.',
      }
    }
  }
  const checkOut = async (): Promise<void> => {
    setCheckout(false)
    setCheckingOut(true)
    setNotice(null)
    try {
      const result = await rpc.invoke('scm.checkout', { ...scope, number })
      if (!result.ok) setNotice(result.error.message)
      else {
        setNotice(`Checked out #${number} in a separate worktree.`)
        await onCheckedOut?.(result.value.path)
      }
    } catch {
      setNotice('Could not create or open the request worktree.')
    } finally {
      setCheckingOut(false)
    }
  }
  const iconControl = iconButton
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-10 shrink-0 items-center gap-1 border-b border-border px-2">
        <button
          type="button"
          aria-label="Back to requests"
          onClick={onBack}
          className={iconControl}
        >
          <ArrowLeft size={14} />
        </button>
        <span className="ml-1 font-mono text-[12.5px] text-fg-muted">#{number}</span>
        <div className="flex-1" />
        <Button
          size="sm"
          variant="secondary"
          className="mr-1"
          disabled={checkingOut || state.loading || !request}
          onClick={() => setCheckout(true)}
        >
          {checkingOut ? 'Checking out…' : 'Check out'}
        </Button>
        {request ? (
          <button
            type="button"
            aria-label="Open request on host"
            onClick={() =>
              void rpc
                .invoke('shell.openUrl', { url: request.url })
                .catch(() => setNotice('Could not open the request on its host.'))
            }
            className={iconControl}
          >
            <ExternalLink size={14} />
          </button>
        ) : null}
        <button
          type="button"
          aria-label="Refresh request"
          disabled={state.loading}
          onClick={refresh}
          className={iconControl}
        >
          <RefreshCw size={14} className={state.loading ? 'animate-spin' : ''} />
        </button>
      </header>
      {state.error ? (
        <p role="alert" className="px-4 py-2.5 text-[13px] text-danger">
          {state.error}
          <button type="button" onClick={refresh} className="ml-2 underline">
            Retry
          </button>
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="border-b border-border px-4 py-2 text-[13px] text-fg-muted">
          {notice}
        </p>
      ) : null}
      {request ? (
        <>
          <div className="shrink-0 border-b border-border px-4 pt-4">
            <div className="flex items-start gap-2">
              <GitPullRequest
                size={16}
                aria-hidden
                className={`mt-[3px] shrink-0 ${request.draft ? 'text-fg-subtle' : 'text-fg-muted'}`}
              />
              <h2 className="text-base font-semibold leading-snug tracking-tight text-fg">
                {request.title}
              </h2>
            </div>
            <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-fg-subtle">
              <span className="rounded-sm bg-fg/6 px-1.5 py-0.5 text-fg-muted">
                {request.draft ? 'Draft' : request.state}
              </span>
              <span>{request.author}</span>
              <span className="font-mono">
                {request.head} → {request.base}
              </span>
            </p>
            <div
              className="-mx-2 mt-1 flex h-10 items-center gap-0.5"
              role="tablist"
              aria-label="Request view"
            >
              {(['overview', 'files'] as const).map((value) => (
                <button
                  key={value}
                  id={`request-tab-${value}`}
                  type="button"
                  role="tab"
                  aria-controls={`request-panel-${value}`}
                  aria-selected={tab === value}
                  tabIndex={tab === value ? 0 : -1}
                  onKeyDown={(event) => {
                    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
                      event.preventDefault()
                      const next =
                        event.key === 'Home'
                          ? 'overview'
                          : event.key === 'End'
                            ? 'files'
                            : tab === 'overview'
                              ? 'files'
                              : 'overview'
                      setTab(next)
                      document.getElementById(`request-tab-${next}`)?.focus()
                    }
                  }}
                  onClick={() => setTab(value)}
                  className={cx(tabClass, tab === value && tabSelected)}
                >
                  {value === 'overview' ? 'Overview & review' : 'Files changed'}
                </button>
              ))}
            </div>
          </div>
          {tab === 'overview' ? (
            <div
              id="request-panel-overview"
              role="tabpanel"
              aria-labelledby="request-tab-overview"
              className="ari-scroll min-h-0 flex-1 overflow-auto p-4"
            >
              <div className="mx-auto max-w-3xl">
                <p className="whitespace-pre-wrap break-words rounded-lg border border-border bg-surface-1 px-4 py-3 text-[13px] leading-relaxed text-fg-muted">
                  {request.body || 'No description provided.'}
                </p>
                {request.state === 'open' ? (
                  <RequestActions request={request} run={action} disabled={state.loading} />
                ) : (
                  <p className="mt-6 flex items-center gap-2 text-[13px] text-fg-subtle">
                    <Check size={14} />
                    This request is {request.state}.
                  </p>
                )}
              </div>
            </div>
          ) : (
            <div
              id="request-panel-files"
              role="tabpanel"
              aria-labelledby="request-tab-files"
              className="flex min-h-0 flex-1 flex-col"
            >
              {diff.loading ? (
                <p role="status" className="px-4 py-3 text-[13px] text-fg-subtle">
                  Loading request diff…
                </p>
              ) : diff.error ? (
                <p role="alert" className="px-4 py-3 text-[13px] text-danger">
                  {diff.error}
                  <button type="button" onClick={refresh} className="ml-2 underline">
                    Retry
                  </button>
                </p>
              ) : selected ? (
                <>
                  <div className="flex shrink-0 items-center gap-3 border-b border-border px-3 py-1.5">
                    <Select
                      aria-label="Request file"
                      value={selected.file.path}
                      options={patches.map((patch) => ({
                        value: patch.file.path,
                        label: patch.file.path,
                      }))}
                      onValueChange={setFile}
                      className="min-w-0 flex-1"
                    />
                    <span className="shrink-0 text-xs text-fg-subtle">
                      {patches.length} {patches.length === 1 ? 'file' : 'files'}
                    </span>
                  </div>
                  <div className="min-h-0 flex-1">
                    <DiffSurface
                      key={selected.file.path}
                      diffText={selected.text}
                      path={selected.file.path}
                      comparisonId={request.headOid ?? request.updatedAt}
                    />
                  </div>
                </>
              ) : (
                <p className="px-4 py-3 text-[13px] text-fg-subtle">
                  No text changes in this request.
                </p>
              )}
            </div>
          )}
        </>
      ) : state.loading ? (
        <div role="status" className="space-y-3 p-5">
          <span className="sr-only">Loading request…</span>
          <div className="h-4 w-3/4 animate-pulse rounded bg-fg/6" />
          <div className="h-3 w-1/2 animate-pulse rounded bg-fg/6" />
        </div>
      ) : null}
      <Dialog open={checkout} onOpenChange={setCheckout}>
        <Dialog.Content>
          <Dialog.Title>Check out #{number}</Dialog.Title>
          <Dialog.Description>
            Create a separate worktree for this request
            {onCheckedOut ? ' and open a session there' : ''}. Your current work stays in its
            checkout.
          </Dialog.Description>
          <div className="mt-4 flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setCheckout(false)}>
              Cancel
            </Button>
            <Button size="sm" variant="primary" onClick={() => void checkOut()}>
              Create worktree
            </Button>
          </div>
        </Dialog.Content>
      </Dialog>
    </div>
  )
}
