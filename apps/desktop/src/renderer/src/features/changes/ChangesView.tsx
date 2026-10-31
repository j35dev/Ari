import { useEffect, useMemo, useState } from 'react'
import type { GitComparison, GitScope } from '@ari/contracts/rpc'
import { GitPullRequest } from 'lucide-react'
import { createLogger } from '@ari/shared/logger'
import { rpc } from '../../lib/rpc'
import { CheckpointList } from './CheckpointList'
import { ReviewWorkspace, type ReviewWorkspaceProps } from './ReviewWorkspace'
import { SourceControlWorkspace } from './SourceControlWorkspace'

const log = createLogger('ui:changes')
type ShipPhase = 'commit' | 'pr' | 'done'

export interface ChangesViewProps {
  sessionId?: string | null
  projectId?: string | null
  sourceControl?: boolean
  initialComparison?: GitComparison
  onRange?: ReviewWorkspaceProps['onRange']
  onCreatePr?: () => void
  onCheckedOut?: (path: string) => Promise<void> | void
}

/** Routes the active capability scope into the shared review/source-control canvas. */
export function ChangesView({
  sessionId = null,
  projectId = null,
  sourceControl = false,
  initialComparison,
  onRange,
  onCreatePr,
  onCheckedOut,
}: ChangesViewProps) {
  const [fallback, setFallback] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  const [checkpoints, setCheckpoints] = useState(false)
  const scope = useMemo<GitScope | null>(
    () =>
      sessionId
        ? { sessionId }
        : projectId
          ? { projectId }
          : fallback
            ? { projectId: fallback }
            : null,
    [sessionId, projectId, fallback],
  )
  useEffect(() => {
    if (sessionId || projectId) return
    let cancelled = false
    setError(null)
    void rpc
      .invoke('project.list')
      .then((projects) => {
        if (!cancelled) setFallback(projects[0]?.id ?? null)
      })
      .catch((error: unknown) => {
        log.warn('Project scope unavailable', { error: String(error) })
        if (!cancelled) setError('Could not load projects. Retry or reopen your project.')
      })
    return () => {
      cancelled = true
    }
  }, [sessionId, projectId, retry])
  return (
    <div className="flex h-full min-h-0 flex-col">
      {error && !scope ? (
        <p role="alert" className="p-6 text-sm text-danger">
          {error}
          <button
            type="button"
            className="ml-3 underline"
            onClick={() => setRetry((value) => value + 1)}
          >
            Retry
          </button>
        </p>
      ) : null}
      <div className="min-h-0 flex-1">
        {sourceControl ? (
          <SourceControlWorkspace
            scope={scope}
            initialComparison={initialComparison}
            onRange={onRange}
            onCreatePr={onCreatePr}
            onCheckedOut={onCheckedOut}
          />
        ) : (
          <ReviewWorkspace scope={scope} initialComparison={initialComparison} onRange={onRange} />
        )}
      </div>
      {sessionId ? (
        <div className="shrink-0 border-t border-border/60 bg-surface-0 px-3 py-2">
          <button
            type="button"
            className="text-2xs text-fg-muted hover:text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-ring"
            aria-expanded={checkpoints}
            onClick={() => setCheckpoints(!checkpoints)}
          >
            Turn checkpoints
          </button>
          {checkpoints ? (
            <div className="ari-scroll max-h-48 overflow-auto pt-2">
              <CheckpointList projectId={projectId ?? 'adhoc'} sessionId={sessionId} />
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

/**
 * Ship flow (M21.4, Conductor's arc): stage-all → commit → push in one
 * action, then an inline PR form driven by `gh pr create`. Each step reports
 * its failure inline; the PR link lands as plain text.
 */
export function ShipSection({
  scope,
  hasChanges,
  onShipped,
}: {
  scope: GitScope
  hasChanges: boolean
  onShipped: () => void
}) {
  const [message, setMessage] = useState('')
  const [phase, setPhase] = useState<ShipPhase>('commit')
  const [prTitle, setPrTitle] = useState('')
  const [prBody, setPrBody] = useState('')
  const [prUrl, setPrUrl] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const commitAndPush = (): void => {
    const trimmed = message.trim()
    if (trimmed.length === 0 || busy) return
    setBusy(true)
    setError(null)
    void rpc
      .invoke('git.add', { ...scope, paths: ['.'] })
      .then((r) => {
        if (!r.ok) throw new Error(r.error)
        return rpc.invoke('git.commit', { ...scope, message: trimmed })
      })
      .then((r) => {
        if (!r.ok) throw new Error(r.error)
        return rpc.invoke('git.push', { ...scope }).then((p) => {
          if (!p.ok) throw new Error(p.error)
        })
      })
      .then(() => {
        setPhase('pr')
        setPrTitle(trimmed.split('\n')[0] ?? trimmed)
        setMessage('')
        onShipped()
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false))
  }

  const createPr = (): void => {
    if (busy || prTitle.trim().length === 0) return
    setBusy(true)
    setError(null)
    void rpc
      .invoke('git.createPr', {
        ...scope,
        title: prTitle.trim(),
        ...(prBody.trim().length > 0 ? { body: prBody.trim() } : {}),
      })
      .then((r) => {
        if (!r.ok) throw new Error(r.error ?? 'PR creation failed')
        setPrUrl(r.url)
        setPhase('done')
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false))
  }

  return (
    <section aria-label="Ship" className="flex flex-col gap-2">
      <h3 className="flex items-center gap-1.5 text-sm font-semibold text-fg">
        <GitPullRequest size={13} className="text-fg-subtle" /> Ship
      </h3>

      {phase === 'commit' ? (
        <div className="flex items-center gap-2">
          <input
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitAndPush()
            }}
            disabled={busy || !hasChanges}
            placeholder={hasChanges ? 'Commit message — stages all changes' : 'Worktree clean'}
            aria-label="Commit message"
            className="h-7 min-w-0 flex-1 rounded-md border border-border bg-surface-1 px-2 text-xs text-fg placeholder:text-fg-subtle focus:border-border-strong focus:outline-none"
          />
          <button
            type="button"
            onClick={commitAndPush}
            disabled={busy || !hasChanges || message.trim().length === 0}
            className="shrink-0 rounded-md bg-accent px-2.5 py-1 text-xs font-medium text-fg-on-accent transition-colors hover:bg-accent-hover disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
          >
            {busy ? 'Shipping…' : 'Commit & push'}
          </button>
        </div>
      ) : null}

      {phase === 'pr' ? (
        <div className="flex flex-col gap-2 rounded-md border border-border bg-surface-1 p-2.5">
          <input
            value={prTitle}
            onChange={(e) => setPrTitle(e.target.value)}
            aria-label="Pull request title"
            placeholder="PR title"
            className="h-7 w-full rounded-md border border-border bg-surface-1 px-2 text-xs text-fg placeholder:text-fg-subtle focus:border-border-strong focus:outline-none"
          />
          <textarea
            value={prBody}
            onChange={(e) => setPrBody(e.target.value)}
            aria-label="Pull request description"
            placeholder="Description (optional)"
            rows={3}
            className="w-full resize-none rounded-md border border-border bg-surface-1 px-2 py-1 text-xs text-fg placeholder:text-fg-subtle focus:border-border-strong focus:outline-none"
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={createPr}
              disabled={busy || prTitle.trim().length === 0}
              className="rounded-md bg-accent px-2.5 py-1 text-xs font-medium text-fg-on-accent transition-colors hover:bg-accent-hover disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
            >
              {busy ? 'Creating…' : 'Open pull request'}
            </button>
            <button
              type="button"
              onClick={() => setPhase('commit')}
              className="rounded-md px-2 py-1 text-xs text-fg-subtle transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
            >
              Skip
            </button>
          </div>
        </div>
      ) : null}

      {phase === 'done' ? (
        <p className="text-xs text-success">
          Pull request open{prUrl !== null ? ' — ' : ''}
          {prUrl !== null ? (
            <span className="font-mono break-all">{prUrl}</span>
          ) : (
            ' (gh printed no URL)'
          )}
        </p>
      ) : null}

      {error !== null ? (
        <p role="alert" className="break-words text-xs text-danger">
          {error}
        </p>
      ) : null}
    </section>
  )
}
