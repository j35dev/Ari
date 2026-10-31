import { useEffect, useMemo, useState } from 'react'
import { Check, Copy, FileDiff, GitBranch, RefreshCw, UnfoldVertical } from 'lucide-react'
import type { GitComparison, GitScope } from '@ari/contracts/rpc'
import { Select } from '@ari/ui/select'
import { createLogger } from '@ari/shared/logger'
import { rpc } from '../../lib/rpc'
import { DiffSurface, type DiffRange } from '../diffs/DiffSurface'
import { ReviewNavigator } from './ReviewNavigator'
import { useSourceControl } from './use-source-control'
import { useReviewPreferences } from './use-review-preferences'

const log = createLogger('ui:review')
const control =
  'flex size-7 items-center justify-center rounded-md text-fg-subtle transition-colors hover:bg-surface-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring disabled:opacity-30'
export interface ReviewWorkspaceProps {
  scope: GitScope | null
  initialComparison?: GitComparison
  onRange?: (path: string, comparisonId: string, range: DiffRange) => void
}

/** Worktree-aware review canvas; selected files load individually and survive navigation. */
export function ReviewWorkspace(props: ReviewWorkspaceProps) {
  if (!props.scope)
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
        <FileDiff size={30} className="text-fg-subtle" />
        <h2 className="text-base font-semibold text-fg">A place to review your work</h2>
        <p className="max-w-xs text-sm text-fg-muted">
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
    <section className="flex h-full min-h-0 flex-col bg-bg" aria-label="Review changes">
      <header className="flex min-h-14 shrink-0 flex-wrap items-center gap-3 border-b border-border/60 px-4 py-2">
        <FileDiff size={18} className="text-accent" />
        <div className="min-w-0">
          <h2 className="text-sm font-semibold tracking-tight text-fg">Review changes</h2>
          <p className="flex items-center gap-1.5 font-mono text-2xs text-fg-subtle">
            <GitBranch size={10} />
            {context
              ? (context.status.branch ?? 'Detached HEAD')
              : loading
                ? 'Reading repository…'
                : 'Repository unavailable'}{' '}
            · {scope.sessionId ? 'session' : 'project'}
          </p>
        </div>
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
        <div className="flex items-center gap-2 border-b border-border/60 px-4 py-2 text-2xs text-fg-muted">
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
        <div
          role="alert"
          className="border-b border-danger/20 bg-danger-subtle px-4 py-3 text-xs text-danger"
        >
          {error ?? watchError}
          <button type="button" className="ml-3 underline" onClick={refresh}>
            Retry
          </button>
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1">
        <ReviewNavigator
          files={files}
          selected={file?.path}
          filter={filter}
          commits={context?.commits ?? []}
          onFilter={(filter) => preferences.change({ filter })}
          onSelect={(path) => {
            preferences.change({ path })
            setContextLines(3)
          }}
          onCommit={(ref) => {
            preferences.change({ comparison: { kind: 'commit', ref } })
            setContextLines(3)
          }}
        />
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {file && manifest ? (
            <>
              <div className="flex min-h-11 shrink-0 flex-wrap items-center gap-2 border-b border-border/60 px-4 py-2">
                <span
                  className="min-w-0 flex-1 truncate font-mono text-xs text-fg"
                  title={file.path}
                >
                  {file.path}
                </span>
                <span className="font-mono text-2xs text-success">+{file.additions}</span>
                <span className="font-mono text-2xs text-danger">−{file.deletions}</span>
                <button
                  type="button"
                  className={control}
                  aria-label="Copy file path"
                  onClick={() => void copyPath(file.path)}
                >
                  <Copy size={13} />
                </button>
                <button
                  type="button"
                  className={control}
                  aria-label="Expand diff context"
                  disabled={contextLines >= 1000}
                  onClick={() => setContextLines((value) => Math.min(1000, value + 40))}
                >
                  <UnfoldVertical size={13} />
                </button>
              </div>
              <div className="min-h-0 flex-1">
                {patch?.key === key ? (
                  patch.error ? (
                    <p role="alert" className="p-8 text-sm text-danger">
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
                  <p role="status" className="p-6 text-xs text-fg-subtle">
                    Loading file diff…
                  </p>
                )}
              </div>
            </>
          ) : !loading && !error ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
              <Check size={30} className="text-success/60" />
              <h3 className="text-sm font-medium text-fg">Nothing to review here</h3>
              <p className="max-w-xs text-xs leading-relaxed text-fg-subtle">
                {filter
                  ? 'No changed files match your search.'
                  : comparison.kind === 'working-tree'
                    ? 'Working tree clean. Choose Branch changes or This session to review committed work.'
                    : 'This comparison has no net changes.'}
              </p>
            </div>
          ) : null}
        </div>
      </div>
      <div className="flex h-7 shrink-0 items-center gap-2 border-t border-border/60 px-3 font-mono text-2xs text-fg-subtle">
        <span className="truncate">
          {manifest?.baseLabel ?? '—'} → {manifest?.headLabel ?? '—'}
        </span>
        <div className="flex-1" />
        {notice ? <span role="status">{notice}</span> : null}
        <span>
          {manifest
            ? manifest.live
              ? 'Live selection · frozen snapshot'
              : 'Immutable snapshot'
            : '—'}
        </span>
        {manifest?.truncated ? <span className="text-warning">File list truncated</span> : null}
      </div>
    </section>
  )
}
