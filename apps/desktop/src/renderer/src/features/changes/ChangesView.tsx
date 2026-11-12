import { useEffect, useMemo, useState } from 'react'
import { visibleProjects } from '../aria/visibility'
import type { GitComparison, GitScope } from '@ari/contracts/rpc'
import type { Project } from '@ari/contracts/project'
import { createLogger } from '@ari/shared/logger'
import { Select } from '@ari/ui/select'
import { useToolSessionClient } from '../terminal/tool-session-client'
import { CheckpointList } from './CheckpointList'
import { ReviewWorkspace, type ReviewWorkspaceProps } from './ReviewWorkspace'
import { ChangeRequests } from './ChangeRequests'
import { ChevronDown, Maximize2, PanelRight, X } from 'lucide-react'
import { ReviewActions } from './ReviewActions'
import { cx, iconButton, tab as tabClass, tabSelected, textButton } from '../../lib/recipes'

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
  const rpc = useToolSessionClient(sessionId ?? undefined)
  const remote = rpc.scope.kind === 'remote' || rpc.readOnly
  const wireSessionId = rpc.scope.kind === 'remote' ? rpc.scope.sessionId : sessionId
  const administrationReason = 'Pull requests and checkpoint changes are unavailable on remote machines.'
  const [fallback, setFallback] = useState<string | null>(null)
  const [projects, setProjects] = useState<Project[]>([])
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
      wireSessionId
        ? { sessionId: wireSessionId }
        : projectId
          ? { projectId }
          : fallback
            ? { projectId: fallback }
            : null,
    [wireSessionId, projectId, fallback],
  )
  useEffect(() => {
    if (remote || sessionId || projectId) return
    let cancelled = false
    setError(null)
    void rpc
      .invoke('project.list')
      .then((projects) => {
        if (!cancelled) {
          projects = visibleProjects(projects)
          setProjects(projects)
          setFallback((current) =>
            projects.some((project) => project.id === current)
              ? current
              : (projects[0]?.id ?? null),
          )
        }
      })
      .catch((error: unknown) => {
        log.warn('Project scope unavailable', { error: String(error) })
        if (!cancelled) setError('Could not load projects. Retry or reopen your project.')
      })
    return () => {
      cancelled = true
    }
  }, [sessionId, projectId, retry, remote, rpc])
  // Full page (it can be docked back) gets a title row; docked beside the
  // conversation, the panel's own tab row already names it.
  const page = onDock !== undefined
  const tools = (
    <>
      {!sessionId && !projectId && projects.length ? (
        <Select
          aria-label="Source control project"
          value={fallback ?? ''}
          options={projects.map((project) => ({ value: project.id, label: project.name }))}
          onValueChange={setFallback}
          className="max-w-48"
        />
      ) : null}
      {onExpand ? (
        <button
          type="button"
          aria-label="Expand source control"
          title="Open a full-width review workspace"
          onClick={onExpand}
          className={iconButton}
        >
          <Maximize2 size={14} />
        </button>
      ) : null}
      {onDock ? (
        <button
          type="button"
          aria-label="Dock source control"
          title="Review beside your conversation"
          onClick={onDock}
          className={iconButton}
        >
          <PanelRight size={14} />
        </button>
      ) : null}
      {onClose ? (
        <button
          type="button"
          aria-label="Close source control"
          onClick={onClose}
          className={iconButton}
        >
          <X size={14} />
        </button>
      ) : null}
    </>
  )
  return (
    <div className="flex h-full min-h-0 flex-col bg-bg">
      {page ? (
        <header className="flex shrink-0 items-center gap-1 px-6 pb-2 pt-6">
          <h1 className="text-[24px] font-semibold leading-8 tracking-[-0.02em] text-fg">
            Changes
          </h1>
          <div className="flex-1" />
          {tools}
        </header>
      ) : null}
      {/* No hairline here: the view below opens with its own toolbar and edge. */}
      <div className={cx('flex h-10 shrink-0 items-center gap-1', page ? 'px-5' : 'px-2')}>
        <div className="flex items-center gap-0.5" role="tablist" aria-label="Source control view">
          {(['changes', 'requests'] as const).map((value) => (
            <button
              key={value}
              id={`scm-tab-${value}`}
              type="button"
              role="tab"
              aria-selected={tab === value}
              disabled={remote && value === 'requests'}
              title={remote && value === 'requests' ? administrationReason : undefined}
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
                  if (remote && next === 'requests') return
                  selectTab(next)
                  document.getElementById(`scm-tab-${next}`)?.focus()
                }
              }}
              aria-controls={`scm-panel-${value}`}
              onClick={() => selectTab(value)}
              className={cx(tabClass, tab === value && tabSelected)}
            >
              {value === 'changes' ? 'Changes' : 'Pull requests'}
            </button>
          ))}
        </div>
        <div className="flex-1" />
        {page ? null : tools}
      </div>
      {error && !scope ? (
        <p role="alert" className="px-4 py-3 text-[13px] text-danger">
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
              {remote ? <p role="status" className="p-4 text-sm text-fg-muted">{administrationReason}</p>
                : <ChangeRequests scope={scope} onCheckedOut={onCheckedOut} />}
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
        <div className="shrink-0 border-t border-border px-2 py-1">
          <button
            type="button"
            className={textButton}
            aria-expanded={checkpoints}
            disabled={remote}
            title={remote ? administrationReason : undefined}
            onClick={() => setCheckpoints(!checkpoints)}
          >
            Turn checkpoints
            <ChevronDown
              size={14}
              aria-hidden
              className={cx('text-fg-subtle', checkpoints && 'rotate-180')}
            />
          </button>
          {checkpoints && !remote ? (
            <div className="ari-scroll max-h-48 overflow-auto px-2 pb-2 pt-1">
              <CheckpointList projectId={projectId ?? 'adhoc'} sessionId={sessionId} />
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
