import { useEffect, useRef, useState } from 'react'
import { ArrowUpRight, ChevronLeft, GitBranch, Plus, X } from 'lucide-react'
import type { DriverKind, PermissionMode } from '@ari/contracts/common'
import type { OrchestrationView } from '@ari/contracts/orchestration'
import { formatTokens, formatUsd } from '../usage/parse-ccusage'
import { isWorkFolded, workLabel, workState } from './work-presentation'
import { workButton } from './work-actions'
import { WorkDecision } from './WorkDecision'
import { WorkLauncher } from './WorkLauncher'
import { WorkTaskDetails } from './WorkTaskDetails'
import { WorkRoutines } from './WorkRoutines'
import { WorkMessages } from './WorkMessages'
import { WorkComparison, type ComparisonSelection } from './WorkComparison'
import './work-panel.css'

/** An optional task inspector; the transcript and composer keep their state. */
export function WorkPanel({
  sessionId,
  panelId = 'ari-work-panel',
  view,
  loadError,
  defaults,
  onClose,
  onOpen,
  onChanged,
}: {
  sessionId: string
  panelId?: string
  view: OrchestrationView | null
  loadError?: string | null
  defaults: { driverKind: DriverKind; modelId: string | null; permissionMode: PermissionMode }
  onClose: () => void
  onOpen?: (id: string) => void
  onChanged: () => void
}) {
  const panel = useRef<HTMLElement>(null)
  const close = useRef<HTMLButtonElement>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [tab, setTab] = useState<'tasks' | 'decisions' | 'results' | 'messages'>('tasks')
  const [adding, setAdding] = useState(false)
  const [narrow, setNarrow] = useState(false)
  const [showEnded, setShowEnded] = useState(false)
  const [comparison, setComparison] = useState<ComparisonSelection[]>([])
  const [visibleTaskIds, setVisibleTaskIds] = useState(() =>
    (view?.tasks ?? []).filter((task) => !isWorkFolded(task)).map((task) => task.taskId),
  )
  useEffect(() => {
    const active = (view?.tasks ?? [])
      .filter((task) => !isWorkFolded(task))
      .map((task) => task.taskId)
    setVisibleTaskIds((previous) =>
      active.some((id) => !previous.includes(id))
        ? [...previous, ...active.filter((id) => !previous.includes(id))]
        : previous,
    )
  }, [view?.tasks])
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    close.current?.focus()
    return () => {
      if (previous?.isConnected) previous.focus()
    }
  }, [])
  useEffect(() => {
    const workspace = panel.current?.parentElement
    if (!workspace) return
    const measure = () => setNarrow(workspace.getBoundingClientRect().width <= 680)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(workspace)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    const siblings = Array.from(panel.current?.parentElement?.children ?? []).filter(
      (element): element is HTMLElement =>
        element instanceof HTMLElement &&
        element !== panel.current &&
        !element.hasAttribute('data-work-backdrop'),
    )
    if (!narrow) return
    const previous = siblings.map((element) => element.inert)
    siblings.forEach((element) => {
      element.inert = true
    })
    return () => {
      siblings.forEach((element, index) => {
        element.inert = previous[index] ?? false
      })
    }
  }, [narrow])
  const tasks = view?.tasks ?? []
  const decisions = tasks.flatMap((task) => task.requests)
  const child = tasks.find((task) => task.taskId === selected)
  // Preserve row order while statuses change. Finished tasks fold on request.
  const ended = tasks.filter(isWorkFolded)
  const results = tasks.filter((task) => task.results.length)
  const filtered =
    tab === 'results'
      ? results
      : showEnded
        ? tasks
        : tasks.filter((task) => visibleTaskIds.includes(task.taskId))
  return (
    <>
      {narrow ? (
        <div
          data-work-backdrop
          aria-hidden
          className="absolute inset-0 z-overlay bg-black/20"
          onClick={onClose}
        />
      ) : null}
      <aside
        ref={panel}
        id={panelId}
        role={narrow ? 'dialog' : 'complementary'}
        aria-modal={narrow || undefined}
        aria-label="Work details"
        className={`ari-work-panel ${tab === 'results' && comparison.length >= 2 && !child && !adding ? 'ari-work-panel-comparing' : ''} flex min-h-0 shrink-0 flex-col border-l border-border bg-surface-0`}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && !event.defaultPrevented) {
            event.stopPropagation()
            onClose()
          }
          if (narrow && event.key === 'Tab') {
            const focusable = Array.from(
              panel.current?.querySelectorAll<HTMLElement>(
                'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), summary, [tabindex="0"]',
              ) ?? [],
            ).filter(
              (element) =>
                !element.closest('fieldset:disabled') &&
                (!element.closest('details:not([open])') || element.tagName === 'SUMMARY'),
            )
            const first = focusable[0]
            const last = focusable.at(-1)
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault()
              last?.focus()
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault()
              first?.focus()
            }
          }
        }}
      >
        <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
          {child || adding ? (
            <button
              type="button"
              aria-label="Back to tasks"
              onClick={() => {
                setSelected(null)
                setAdding(false)
              }}
              className={workButton}
            >
              <ChevronLeft size={14} />
            </button>
          ) : (
            <GitBranch size={14} aria-hidden className="text-fg-subtle" />
          )}
          <h2 className="min-w-0 flex-1 truncate text-sm font-medium text-fg">
            {child?.title ?? (adding ? 'New task' : 'Work')}
          </h2>
          <button
            ref={close}
            type="button"
            aria-label="Close work details"
            onClick={onClose}
            className={workButton}
          >
            <X size={14} />
          </button>
        </header>
        {loadError ? (
          <p role="alert" className="px-4 py-3 text-xs text-danger">
            {loadError}
            <button type="button" className={`${workButton} ml-1`} onClick={onChanged}>
              Refresh
            </button>
          </p>
        ) : null}
        {!view && !loadError ? (
          <p role="status" className="px-4 py-4 text-xs text-fg-subtle">
            Loading work…
          </p>
        ) : adding ? (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <WorkLauncher
              sessionId={sessionId}
              tasks={tasks}
              defaults={defaults}
              onChanged={onChanged}
              onCancel={() => setAdding(false)}
            />
          </div>
        ) : child ? (
          <WorkTaskDetails
            key={child.taskId}
            sessionId={sessionId}
            task={child}
            tasks={tasks}
            onChanged={onChanged}
            onOpen={onOpen}
          />
        ) : (
          <>
            <nav
              aria-label="Work sections"
              className="flex shrink-0 gap-1 overflow-x-auto border-b border-border px-2 py-1.5"
            >
              {(['tasks', 'decisions', 'results', 'messages'] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={tab === value}
                  onClick={() => setTab(value)}
                  className={`${workButton} ${tab === value ? 'bg-surface-2 text-fg' : ''}`}
                >
                  {value === 'tasks'
                    ? 'Tasks'
                    : value === 'decisions'
                      ? 'Decisions'
                      : value === 'results'
                        ? 'Results'
                        : 'Messages'}
                  {value !== 'messages' ? (
                    <span className="font-mono text-2xs tabular-nums text-fg-subtle">
                      {value === 'tasks'
                        ? tasks.length
                        : value === 'decisions'
                          ? decisions.length
                          : results.length}
                    </span>
                  ) : null}
                </button>
              ))}
            </nav>
            <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
              {tab === 'messages' ? (
                <WorkMessages sessionId={sessionId} observedAt={view?.observedAt ?? 0} />
              ) : tab === 'decisions' ? (
                decisions.length ? (
                  decisions.map((request) => (
                    <WorkDecision
                      key={`${request.childSessionId}:${request.kind}:${request.requestId}`}
                      sessionId={sessionId}
                      request={request}
                      onChanged={onChanged}
                    />
                  ))
                ) : (
                  <p className="px-2 py-8 text-xs text-fg-subtle">No decisions are waiting.</p>
                )
              ) : (
                <>
                  {tab === 'tasks' ? (
                    <button
                      type="button"
                      onClick={() => setAdding(true)}
                      className={`${workButton} mb-2`}
                    >
                      <Plus size={13} />
                      Add task
                    </button>
                  ) : null}
                  <ul aria-label={tab === 'tasks' ? 'Tasks' : 'Results'}>
                    {filtered.map((task) => {
                      const state = workState(task)
                      return (
                        <li key={task.taskId} className="border-b border-border/50 last:border-0">
                          {tab === 'results' && task.currentResultId ? (
                            <label className="flex items-center gap-2 px-2 pt-2 text-2xs text-fg-muted">
                              <input
                                type="checkbox"
                                checked={comparison.some((item) => item.taskId === task.taskId)}
                                disabled={
                                  comparison.length >= 8 &&
                                  !comparison.some((item) => item.taskId === task.taskId)
                                }
                                onChange={() =>
                                  setComparison((previous) =>
                                    previous.some((item) => item.taskId === task.taskId)
                                      ? previous.filter((item) => item.taskId !== task.taskId)
                                      : [
                                          ...previous,
                                          { taskId: task.taskId, resultId: task.currentResultId! },
                                        ],
                                  )
                                }
                              />
                              Compare {task.title}
                            </label>
                          ) : null}
                          <button
                            type="button"
                            onClick={() => setSelected(task.taskId)}
                            className="group flex w-full items-start gap-2 rounded-md px-2 py-3 text-left transition-colors hover:bg-surface-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
                          >
                            <span
                              className={`mt-1.5 size-1.5 shrink-0 rounded-full ${state === 'failed' ? 'bg-danger' : state === 'needs-you' || state === 'needs-lead' ? 'bg-warning' : state === 'completed' ? 'bg-success' : 'bg-fg-subtle/50'}`}
                              aria-hidden
                            />
                            <span className="min-w-0 flex-1">
                              <span className="block break-words text-xs font-medium leading-5 text-fg">
                                {task.title}
                              </span>
                              <span className="mt-0.5 flex flex-wrap gap-x-2 text-2xs text-fg-subtle">
                                <span
                                  className={
                                    state === 'needs-you' || state === 'needs-lead'
                                      ? 'text-warning'
                                      : state === 'failed'
                                        ? 'text-danger'
                                        : ''
                                  }
                                >
                                  {workLabel(task)}
                                </span>
                                <span>
                                  {task.driverKind} · {task.modelId ?? 'Default'}
                                </span>
                              </span>
                              {task.currentActivity.detail ? (
                                <span className="mt-1 block text-2xs leading-relaxed text-fg-muted">
                                  {task.currentActivity.detail}
                                </span>
                              ) : null}
                            </span>
                            <ArrowUpRight
                              size={12}
                              aria-hidden
                              className="mt-1 shrink-0 text-fg-subtle opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100"
                            />
                          </button>
                        </li>
                      )
                    })}
                  </ul>
                  {tab === 'results' ? (
                    <WorkComparison
                      tasks={tasks}
                      selected={comparison}
                      onClear={() => setComparison([])}
                    />
                  ) : null}
                  {!filtered.length ? (
                    <p className="px-2 py-6 text-xs text-fg-subtle">
                      {tab === 'results'
                        ? 'Results appear when an agent reports back.'
                        : ended.length
                          ? 'No active tasks.'
                          : 'Add a task or delegate work from the conversation.'}
                    </p>
                  ) : null}
                  {tab === 'tasks' && ended.length ? (
                    <button
                      type="button"
                      aria-expanded={showEnded}
                      className={`${workButton} mt-2`}
                      onClick={() => {
                        if (showEnded)
                          setVisibleTaskIds(
                            tasks.filter((task) => !isWorkFolded(task)).map((task) => task.taskId),
                          )
                        setShowEnded((value) => !value)
                      }}
                    >
                      {showEnded ? 'Hide completed work' : `Show completed work (${ended.length})`}
                    </button>
                  ) : null}
                </>
              )}
              <WorkRoutines
                sessionId={sessionId}
                titleOf={(id) =>
                  tasks.find((task) => task.attempts.some((attempt) => attempt.sessionId === id))
                    ?.title
                }
              />
              {view?.operations.some((operation) => operation.status === 'uncertain') ? (
                <details className="mt-4 px-2 text-xs text-warning">
                  <summary className="cursor-pointer">Operations need reconciliation</summary>
                  <ul className="mt-2 space-y-2">
                    {view.operations
                      .filter((operation) => operation.status === 'uncertain')
                      .map((operation) => (
                        <li key={operation.operationId}>
                          {operation.method}:{' '}
                          {operation.detail ??
                            'The runtime could not establish whether the action completed. Inspect the task before retrying.'}
                        </li>
                      ))}
                  </ul>
                </details>
              ) : null}
            </div>
            {view ? (
              <details className="shrink-0 border-t border-border px-4 py-3 text-2xs text-fg-subtle">
                <summary className="cursor-pointer">Team usage and limits</summary>
                <p className="mt-2">
                  Entire session tree ·{' '}
                  {view.budgets.inputTokens === null || view.budgets.outputTokens === null
                    ? 'Token usage unavailable'
                    : `${formatTokens(view.budgets.inputTokens + view.budgets.outputTokens)} tokens`}
                  {view.budgets.costUsd === null
                    ? ' · Pricing unavailable'
                    : ` · ${formatUsd(view.budgets.costUsd)}`}
                </p>
                {view.budgets.maxTokens !== null ? (
                  <p className="mt-1">Soft token limit: {formatTokens(view.budgets.maxTokens)}</p>
                ) : null}
                {view.budgets.maxCostUsd !== null ? (
                  <p className="mt-1">Soft cost limit: {formatUsd(view.budgets.maxCostUsd)}</p>
                ) : null}
              </details>
            ) : null}
          </>
        )}
      </aside>
    </>
  )
}
