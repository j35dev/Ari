import { useEffect, useMemo, useState } from 'react'
import { visibleProjects } from '../aria/visibility'
import type { GitComparison, GitScope } from '@ari/contracts/rpc'
import { createLogger } from '@ari/shared/logger'
import { rpc } from '../../lib/rpc'
import { CheckpointList } from './CheckpointList'
import { ReviewWorkspace, type ReviewWorkspaceProps } from './ReviewWorkspace'
import { ChangeRequests } from './ChangeRequests'
import { Maximize2, PanelRight, X } from 'lucide-react'
import { ReviewActions } from './ReviewActions'

const log = createLogger('ui:changes')

export interface ChangesViewProps {
  sessionId?: string | null
  projectId?: string | null
  initialComparison?: GitComparison
  onRange?: ReviewWorkspaceProps['onRange']
  onCheckedOut?: (path: string) => Promise<void> | void
  initialTab?: 'changes' | 'requests'
  onTabChange?: (tab: 'changes' | 'requests') => void
  onExpand?: () => void
  onDock?: () => void
  onClose?: () => void
}

/** Local review and hosted requests share one expandable source-control workspace. */
export function ChangesView({
  sessionId = null,
  projectId = null,
  initialComparison,
  onRange,
  onCheckedOut,
  initialTab = 'changes',
  onTabChange,
  onExpand,
  onDock,
  onClose,
}: ChangesViewProps) {
  const [fallback, setFallback] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  const [checkpoints, setCheckpoints] = useState(false)
  const [tab, setTab] = useState(initialTab)
  const selectTab = (value: 'changes' | 'requests') => {
    setTab(value)
    onTabChange?.(value)
  }
  useEffect(() => setTab(initialTab), [initialTab, JSON.stringify(initialComparison)])
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
        if (!cancelled) setFallback(visibleProjects(projects)[0]?.id ?? null)
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
      <div className="flex min-h-10 shrink-0 items-center gap-2 border-b border-border/60 bg-surface-0 px-3">
        <div className="flex self-stretch gap-4" role="tablist" aria-label="Source control view">
          {(['changes', 'requests'] as const).map((value) => (
            <button
              key={value}
              id={`scm-tab-${value}`}
              type="button"
              role="tab"
              aria-selected={tab === value}
              tabIndex={tab === value ? 0 : -1}
              onKeyDown={(event) => {
                if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
                  event.preventDefault()
                  const next =
                    event.key === 'Home'
                      ? 'changes'
                      : event.key === 'End'
                        ? 'requests'
                        : tab === 'changes'
                          ? 'requests'
                          : 'changes'
                  selectTab(next)
                  document.getElementById(`scm-tab-${next}`)?.focus()
                }
              }}
              aria-controls={`scm-panel-${value}`}
              onClick={() => selectTab(value)}
              className={`border-b-2 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring ${tab === value ? 'border-accent text-fg' : 'border-transparent text-fg-subtle hover:text-fg'}`}
            >
              {value === 'changes' ? 'Changes' : 'Pull requests'}
            </button>
          ))}
        </div>
        <div className="flex-1" />
        {onExpand ? (
          <button
            type="button"
            aria-label="Expand source control"
            title="Open a full-width review workspace"
            onClick={onExpand}
            className="rounded-md p-1.5 text-fg-subtle hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
          >
            <Maximize2 size={13} />
          </button>
        ) : null}
        {onDock ? (
          <button
            type="button"
            aria-label="Dock source control"
            title="Review beside your conversation"
            onClick={onDock}
            className="rounded-md p-1.5 text-fg-subtle hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
          >
            <PanelRight size={13} />
          </button>
        ) : null}
        {onClose ? (
          <button
            type="button"
            aria-label="Close source control"
            onClick={onClose}
            className="rounded-md p-1.5 text-fg-subtle hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
          >
            <X size={13} />
          </button>
        ) : null}
      </div>
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
          {tab === 'requests' ? (
            <div
              id="scm-panel-requests"
              role="tabpanel"
              aria-labelledby="scm-tab-requests"
              className="min-h-0 flex-1"
            >
              <ChangeRequests scope={scope} onCheckedOut={onCheckedOut} />
            </div>
          ) : (
            <div
              id="scm-panel-changes"
              role="tabpanel"
              aria-labelledby="scm-tab-changes"
              className="min-h-0 flex-1"
            >
              <ReviewWorkspace
                scope={scope}
                initialComparison={initialComparison}
                onRange={onRange}
                renderControls={(state) => <ReviewActions {...state} />}
              />
            </div>
          )}
        </div>
      </div>
      {sessionId && tab === 'changes' ? (
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
