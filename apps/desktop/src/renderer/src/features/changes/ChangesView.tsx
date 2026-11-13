import { useEffect, useMemo, useState } from 'react'
import { visibleProjects } from '../aria/visibility'
import type { GitComparison, GitScope } from '@ari/contracts/rpc'
import type { Project } from '@ari/contracts/project'
import { createLogger } from '@ari/shared/logger'
import { Select } from '@ari/ui/select'
import { useToolSessionClient } from '../terminal/tool-session-client'
import { ReviewWorkspace, type ReviewView, type ReviewWorkspaceProps } from './ReviewWorkspace'
import { Maximize2, PanelRight, X } from 'lucide-react'
import { iconButton } from '../../lib/recipes'

const log = createLogger('ui:changes')

export interface ChangesViewProps {
  sessionId?: string | null
  projectId?: string | null
  initialComparison?: GitComparison
  onRange?: ReviewWorkspaceProps['onRange']
  onCheckedOut?: (path: string) => Promise<void> | void
  initialTab?: ReviewView
  onTabChange?: (tab: ReviewView) => void
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
  const administrationReason = remote
    ? 'Pull requests and checkpoint changes are unavailable on remote machines.'
    : null
  const [fallback, setFallback] = useState<string | null>(null)
  const [projects, setProjects] = useState<Project[]>([])
  const [error, setError] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  const [view, setView] = useState(initialTab)
  const selectView = (value: ReviewView) => {
    if (value === 'requests' && remote) return
    setView(value)
    onTabChange?.(value)
  }
  useEffect(() => setView(initialTab), [initialTab, JSON.stringify(initialComparison)])
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
  // Full page (it can be docked back) keeps its page title; the tools live in
  // the review header either way.
  const page = onDock !== undefined
  const tools = (
    <>
      {!sessionId && !projectId && projects.length ? (
        <Select
          aria-label="Source control project"
          value={fallback ?? ''}
          options={projects.map((project) => ({ value: project.id, label: project.name }))}
          onValueChange={setFallback}
          className="ml-1 max-w-40"
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
          <Maximize2 size={14} aria-hidden />
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
          <PanelRight size={14} aria-hidden />
        </button>
      ) : null}
      {onClose ? (
        <button
          type="button"
          aria-label="Close source control"
          title="Close"
          onClick={onClose}
          className={iconButton}
        >
          <X size={14} aria-hidden />
        </button>
      ) : null}
    </>
  )
  return (
    <div className="flex h-full min-h-0 flex-col bg-bg">
      {page ? (
        <header className="flex shrink-0 items-center px-6 pb-2 pt-6">
          <h1 className="text-[24px] font-semibold leading-8 tracking-[-0.02em] text-fg">
            Changes
          </h1>
        </header>
      ) : null}
      {error && !scope ? (
        <div
          role="alert"
          className="flex shrink-0 items-center gap-3 border-b border-border px-3 py-2 text-[13px] text-danger"
        >
          <span className="min-w-0 flex-1">{error}</span>
          <button
            type="button"
            className="shrink-0 text-fg-muted underline hover:text-fg"
            onClick={() => setRetry((value) => value + 1)}
          >
            Retry
          </button>
        </div>
      ) : null}
      <div className="min-h-0 flex-1">
        <ReviewWorkspace
          scope={scope}
          initialComparison={initialComparison}
          onRange={onRange}
          view={view}
          onViewChange={selectView}
          administrationReason={administrationReason}
          onCheckedOut={onCheckedOut}
          tools={tools}
        />
      </div>
    </div>
  )
}
