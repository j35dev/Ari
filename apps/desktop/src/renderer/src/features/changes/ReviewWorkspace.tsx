import { useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  FileDiff,
  GitBranch,
  RefreshCw,
  UnfoldVertical,
} from 'lucide-react'
import type {
  GitComparison,
  GitScope,
  GitReviewManifest,
  SourceControlContext,
} from '@ari/contracts/rpc'
import { Select } from '@ari/ui/select'
import { createLogger } from '@ari/shared/logger'
import { rpc } from '../../lib/rpc'
import { iconButton } from '../../lib/recipes'
import { DiffSurface, type DiffRange } from '../diffs/DiffSurface'
import { ReviewNavigator } from './ReviewNavigator'
import { useSourceControl } from './use-source-control'
import { useReviewPreferences } from './use-review-preferences'

const log = createLogger('ui:review')
const control = iconButton
export interface ReviewControlsState {
  scope: GitScope
  context: SourceControlContext | null
  manifest: GitReviewManifest | null
  paths: string[]
  loading: boolean
  refresh: () => void
}
export interface ReviewWorkspaceProps {
  scope: GitScope | null
  initialComparison?: GitComparison
  onRange?: (path: string, comparisonId: string, range: DiffRange) => void
  label?: 'Review changes' | 'Source control'
  renderControls?: (state: ReviewControlsState) => ReactNode
}

/** Worktree-aware review canvas; selected files load individually and survive navigation. */
export function ReviewWorkspace(props: ReviewWorkspaceProps) {
  if (!props.scope)
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
        <FileDiff size={24} className="mb-1 text-fg-subtle" aria-hidden />
        <h2 className="text-sm font-medium text-fg">A place to review your work</h2>
        <p className="max-w-xs text-[13px] text-fg-subtle">
          Open a project or session to see its code changes.
        </p>
      </div>
    )
  return <ScopedReview key={JSON.stringify(props.scope)} {...props} scope={props.scope} />
}

function ScopedReview({
  scope,
  initialComparison,
  onRange,
  label = 'Review changes',
  renderControls,
}: ReviewWorkspaceProps & { scope: GitScope }) {
  const scopeKey = JSON.stringify(scope)
  const preferences = useReviewPreferences(scopeKey)
  const { comparison, path: selected, filter } = preferences.value
  const { context, manifest, error, watchError, loading, refresh } = useSourceControl(
    scope,
    comparison,
  )
  const [patch, setPatch] = useState<{ key: string; text: string; error: string | null } | null>(
    null,
  )
  const [contextLines, setContextLines] = useState(3)
  const [retry, setRetry] = useState(0)
  const [notice, setNotice] = useState<string | null>(null)
  const [selection, setSelection] = useState<string[]>([])
  const viewed = preferences.viewedPaths(manifest)
  useEffect(() => {
    if (manifest) preferences.reconcileViewed(manifest)
  }, [manifest])
  useEffect(() => {
    if (initialComparison) preferences.change({ comparison: initialComparison })
  }, [JSON.stringify(initialComparison)])
  const files = useMemo(
    () =>
      (manifest?.files ?? []).filter((file) =>
        file.path.toLowerCase().includes(filter.toLowerCase()),
      ),
    [manifest, filter],
  )
  const file = files.find((file) => file.path === selected) ?? files[0]
  const paths = selection.length
    ? selection.filter((path) => manifest?.files.some((file) => file.path === path))
    : file
      ? [file.path]
      : []
  const key = manifest && file ? `${manifest.id}:${file.path}:${contextLines}` : ''
  useEffect(() => {
    if (!manifest || !file) return
    let cancelled = false
    const requestId = crypto.randomUUID()
    void rpc
      .invoke('scm.diff', {
        ...scope,
        snapshotId: manifest.id,
        path: file.path,
        context: contextLines,
        requestId,
      })
      .then((result) => {
        if (!cancelled)
          setPatch({
            key,
            text: result.ok ? result.value : '',
            error: result.ok ? null : result.error.message,
          })
      })
      .catch((error: unknown) => {
        log.warn('File diff failed', { error: String(error) })
        if (!cancelled)
          setPatch({
            key,
            text: '',
            error: 'Could not load this file. Retry or choose another file.',
          })
      })
    return () => {
      cancelled = true
      void rpc
        .invoke('scm.cancel', { requestId })
        .catch((error: unknown) => log.warn('Diff cancellation failed', { error: String(error) }))
    }
  }, [manifest, file?.path, contextLines, retry])
  const options = [
    { value: 'working-tree', label: 'Working tree' },
    { value: 'unstaged', label: 'Unstaged' },
    { value: 'staged', label: 'Staged' },
    { value: 'branch', label: 'Branch changes' },
    ...(scope.sessionId ? [{ value: 'session', label: 'This session' }] : []),
    ...(context?.turns ?? []).map((turn, index) => ({
      value: `turn:${turn.turnId}`,
      label: `Turn ${index + 1}${turn.stable ? '' : ' · unavailable'}`,
    })),
    ...(comparison.kind === 'commit'
      ? [{ value: 'commit', label: `Commit ${comparison.ref.slice(0, 7)}` }]
      : []),
  ]
  const choice = comparison.kind === 'turn' ? `turn:${comparison.turnId}` : comparison.kind
  const copyPath = async (path: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(path)
      setNotice('Path copied')
    } catch (error) {
      log.warn('Copy path failed', { error: String(error) })
      setNotice('Could not copy this path.')
    }
  }
  const selectComparison = (value: string) => {
    setContextLines(3)
    setSelection([])
    if (value.startsWith('turn:'))
      preferences.change({ comparison: { kind: 'turn', turnId: value.slice(5) } })
    else if (value === 'branch') preferences.change({ comparison: { kind: 'branch' } })
    else if (
      value === 'staged' ||
      value === 'unstaged' ||
      value === 'working-tree' ||
      value === 'session'
    )
      preferences.change({ comparison: { kind: value } })
  }
  return (
    <section className="@container flex h-full min-h-0 flex-col bg-bg" aria-label={label}>
      {/* The panel's tab row (or the page title) already names this view, so
          the heading stays for assistive tech and the toolbar leads with the branch. */}
      <header className="flex min-h-10 shrink-0 flex-wrap items-center gap-2 border-b border-border py-1 pl-4 pr-2">
        <h2 className="sr-only">{label}</h2>
        <p className="flex min-w-0 items-center gap-1.5 text-[13px] text-fg-muted">
          <GitBranch size={14} className="shrink-0 text-fg-subtle" aria-hidden />
          <span className="min-w-0 truncate">
            {context
              ? (context.status.branch ?? 'Detached HEAD')
              : loading
                ? 'Reading repository…'
                : 'Repository unavailable'}{' '}
            · {scope.sessionId ? 'session' : 'project'}
          </span>
          {context?.status.ahead ? (
            <span className="shrink-0 font-mono text-xs" title="Commits ahead of upstream">
              ↑{context.status.ahead}
            </span>
          ) : null}
          {context?.status.behind ? (
            <span className="shrink-0 font-mono text-xs" title="Commits behind upstream">
              ↓{context.status.behind}
            </span>
          ) : null}
        </p>
        <div className="flex-1" />
        <Select
          aria-label="Compare changes"
          value={choice}
          options={options}
          onValueChange={selectComparison}
          className="max-w-48"
        />
        <button type="button" className={control} aria-label="Refresh changes" onClick={refresh}>
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
        </button>
      </header>
      {comparison.kind === 'branch' ? (
        <div className="flex items-center gap-2 border-b border-border px-4 py-1.5 text-xs text-fg-subtle">
          Compare from
          <Select
            aria-label="Base branch"
            value={comparison.base ?? ''}
            options={[
              { value: '', label: 'Automatic merge base' },
              ...(context?.refs ?? []).map((ref) => ({ value: ref, label: ref })),
            ]}
            onValueChange={(base) =>
              preferences.change({ comparison: { kind: 'branch', ...(base ? { base } : {}) } })
            }
          />
        </div>
      ) : null}
      {error || watchError ? (
        <div role="alert" className="border-b border-border px-4 py-2.5 text-[13px] text-danger">
          {error ?? watchError}
          <button type="button" className="ml-3 underline" onClick={refresh}>
            Retry
          </button>
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1 flex-col @[44rem]:flex-row">
        <ReviewNavigator
          files={files}
          selected={file?.path}
          filter={filter}
          commits={context?.commits ?? []}
          onFilter={(filter) => preferences.change({ filter })}
          onSelect={(path, multiple) => {
            setSelection(
              multiple
                ? paths.includes(path)
                  ? paths.filter((entry) => entry !== path)
                  : [...paths, path]
                : [path],
            )
            preferences.change({ path })
            setContextLines(3)
          }}
          selectedPaths={renderControls ? new Set(paths) : undefined}
          onSelectAll={
            renderControls
              ? () => setSelection(files.slice(0, 500).map((file) => file.path))
              : undefined
          }
          selectedCommit={comparison.kind === 'commit' ? comparison.ref : undefined}
          onCommit={(ref) => {
            preferences.change({ comparison: { kind: 'commit', ref } })
            setContextLines(3)
          }}
        />
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {file && manifest ? (
            <>
              {/* The file header and the diff toolbar under it share one hairline. */}
              <div className="flex min-h-9 shrink-0 flex-wrap items-center gap-x-1 gap-y-0.5 py-0.5 pl-4 pr-2">
                <FileDiff size={14} className="mr-1 shrink-0 text-fg-subtle" aria-hidden />
                <span
                  className="min-w-0 flex-1 basis-[calc(100%-1.75rem)] truncate font-mono text-[12.5px] text-fg @[44rem]:basis-auto"
                  title={file.path}
                >
                  {file.path}
                </span>
                <span className="font-mono text-xs tabular-nums text-success">
                  +{file.additions}
                </span>
                <span className="ml-1 font-mono text-xs tabular-nums text-danger">
                  −{file.deletions}
                </span>
                <label className="ml-3 flex cursor-pointer items-center gap-1.5 text-xs text-fg-muted">
                  <input
                    type="checkbox"
                    aria-label={`Mark ${file.path} viewed`}
                    checked={viewed.has(file.path)}
                    onChange={(event) =>
                      preferences.markViewed(manifest, file, event.target.checked)
                    }
                    className="size-3.5 accent-fg"
                  />
                  Viewed
                </label>
                <span className="mx-1.5 h-4 w-px bg-border" aria-hidden />
                <button
                  type="button"
                  className={control}
                  aria-label="Previous file"
                  disabled={files.indexOf(file) <= 0}
                  onClick={() => {
                    const next = files[files.indexOf(file) - 1]
                    if (next) {
                      preferences.change({ path: next.path })
                      setContextLines(3)
                      setSelection([next.path])
                    }
                  }}
                >
                  <ChevronLeft size={14} />
                </button>
                <span className="font-mono text-xs tabular-nums text-fg-subtle">
                  {files.indexOf(file) + 1}/{files.length}
                </span>
                <button
                  type="button"
                  className={control}
                  aria-label="Next file"
                  disabled={files.indexOf(file) >= files.length - 1}
                  onClick={() => {
                    const next = files[files.indexOf(file) + 1]
                    if (next) {
                      preferences.change({ path: next.path })
                      setContextLines(3)
                      setSelection([next.path])
                    }
                  }}
                >
                  <ChevronRight size={14} />
                </button>
                <button
                  type="button"
                  className={control}
                  aria-label="Copy file path"
                  onClick={() => void copyPath(file.path)}
                >
                  <Copy size={14} />
                </button>
                <button
                  type="button"
                  className={control}
                  aria-label="Expand diff context"
                  disabled={contextLines >= 1000}
                  onClick={() => setContextLines((value) => Math.min(1000, value + 40))}
                >
                  <UnfoldVertical size={14} />
                </button>
              </div>
              <div className="min-h-0 flex-1">
                {patch?.key === key ? (
                  patch.error ? (
                    <p role="alert" className="px-4 py-3 text-[13px] text-danger">
                      {patch.error}
                      <button
                        type="button"
                        className="ml-3 underline"
                        onClick={() => setRetry((value) => value + 1)}
                      >
                        Retry file
                      </button>
                    </p>
                  ) : (
                    <DiffSurface
                      key={file.path}
                      diffText={patch.text}
                      path={file.path}
                      comparisonId={manifest.id}
                      scrollOffset={preferences.offset(file.path)}
                      onScrollOffset={(offset) => preferences.recordScroll(file.path, offset)}
                      onRange={
                        onRange ? (range) => onRange(file.path, manifest.id, range) : undefined
                      }
                    />
                  )
                ) : (
                  <div role="status" aria-label="Loading file diff" className="space-y-3 p-5">
                    <span className="sr-only">Loading file diff…</span>
                    {[70, 90, 50, 80, 65, 85].map((width, index) => (
                      <div key={index} className="flex gap-4">
                        <span className="h-2.5 w-7 animate-pulse rounded bg-fg/6" />
                        <span
                          className="h-2.5 animate-pulse rounded bg-fg/6"
                          style={{ width: `${width}%` }}
                        />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          ) : !loading && !error ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
              <Check size={24} className="mb-1 text-fg-subtle" aria-hidden />
              <h3 className="text-sm font-medium text-fg">Nothing to review here</h3>
              <p className="max-w-xs text-[13px] leading-relaxed text-fg-subtle">
                {filter
                  ? 'No changed files match your search.'
                  : comparison.kind === 'working-tree'
                    ? 'Working tree clean. Choose Branch changes or This session to review committed work.'
                    : 'This comparison has no net changes.'}
              </p>
            </div>
          ) : loading ? (
            <div role="status" className="space-y-3 p-6">
              <span className="sr-only">Loading changes…</span>
              <div className="h-3 w-44 animate-pulse rounded bg-fg/6" />
              <div className="h-3 w-64 animate-pulse rounded bg-fg/6" />
            </div>
          ) : null}
        </div>
      </div>
      {renderControls?.({ scope, context, manifest, paths, loading, refresh })}
      <div className="flex h-7 shrink-0 items-center gap-2 border-t border-border px-4 font-mono text-xs text-fg-subtle">
        <span className="truncate">
          {manifest?.baseLabel ?? '—'} → {manifest?.headLabel ?? '—'}
        </span>
        <div className="flex-1" />
        {notice ? <span role="status">{notice}</span> : null}
        {manifest?.truncated ? <span className="text-warning">File list truncated</span> : null}
        {manifest && viewed.size ? (
          <span>
            {viewed.size}/{manifest.files.length} viewed
          </span>
        ) : null}
      </div>
    </section>
  )
}
