import { useEffect, useMemo, useState } from 'react'
import type { GitComparison, GitScope } from '@ari/contracts/rpc'
import { createLogger } from '@ari/shared/logger'
import { rpc } from '../../lib/rpc'
import { CheckpointList } from './CheckpointList'
import { ReviewWorkspace, type ReviewWorkspaceProps } from './ReviewWorkspace'
import { ChangeRequests } from './ChangeRequests'

const log = createLogger('ui:changes')

export interface ChangesViewProps {
  sessionId?: string | null
  projectId?: string | null
  initialComparison?: GitComparison
  onRange?: ReviewWorkspaceProps['onRange']
  onCheckedOut?: (path: string) => Promise<void> | void
}

/** The one review view: open requests for the remote above the diff of the active scope. Git actions live in the titlebar control. */
export function ChangesView({
  sessionId = null,
  projectId = null,
  initialComparison,
  onRange,
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
        <div className="flex h-full min-h-0 flex-col">
          <ChangeRequests scope={scope} onCheckedOut={onCheckedOut} />
          <div className="min-h-0 flex-1">
            <ReviewWorkspace
              scope={scope}
              initialComparison={initialComparison}
              onRange={onRange}
            />
          </div>
        </div>
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
