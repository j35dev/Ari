import { useId, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import type { ResultPackage } from '@ari/contracts/orchestration'
import type { DelegatedChild } from './types'
import { MarkdownBlock } from './MarkdownBlock'
import { DelegatedResultDiff } from './DelegatedResultDiff'
import { ResultError, resultButton } from './result-controls'
import { useDelegatedResult } from './use-delegated-result'
import { useSessionClient } from '../session/session-client'

const LABEL: Record<ResultPackage['reviewState'], string> = {
  available: 'Ready for review',
  reviewing: 'Reviewing',
  changes_requested: 'Changes requested',
  accepted: 'Accepted',
  integrated: 'Integrated',
}

/** A quiet entry point beside a settled child, with no permanent management panel. */
export function DelegatedResult({
  sessionId,
  child,
}: {
  sessionId: string
  child: DelegatedChild
}) {
  const client = useSessionClient()
  if (client.scope.kind === 'remote') return (
    <div className="mb-1 pl-[18px] text-2xs text-fg-muted">
      <button type="button" disabled title="Versioned result review is unavailable on this host." className={resultButton}>Inspect result</button>
      <span className="ml-2">Review, integrate and retry controls are unavailable on this host.</span>
    </div>
  )
  return (
    <ScopedDelegatedResult
      key={JSON.stringify([client.viewKey, client.authorizationEpoch, sessionId, child.sessionId])}
      sessionId={sessionId}
      child={child}
    />
  )
}

function ScopedDelegatedResult({ sessionId, child }: { sessionId: string; child: DelegatedChild }) {
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [diffOpen, setDiffOpen] = useState(false)
  const id = useId()
  const review = useDelegatedResult(sessionId, child.sessionId, open)
  const { result, target, current, busy, loading } = review
  const settled = ['done', 'failed', 'stopped', 'idle', 'removed'].includes(child.state)
  if (!settled && !open && !review.task) return null
  const disabled = busy || loading || !!review.loadError || !settled
  return (
    <div className="mb-1 pl-[18px]">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
        aria-label={`${open ? 'Hide' : 'Inspect'} result for ${child.title}`}
        className={`${resultButton} gap-1 px-1 py-1 text-2xs`}
      >
        <ChevronRight aria-hidden size={11} className={open ? 'rotate-90' : ''} />
        {open ? 'Hide result' : result ? `Result · ${LABEL[result.reviewState]}` : 'Inspect result'}
      </button>
      <div id={id} hidden={!open} className="mt-1 rounded-md border border-border/60 px-3 py-2.5">
        {loading ? (
          <p role="status" className="text-xs text-fg-subtle">
            Loading result…
          </p>
        ) : null}
        {review.loadError ? (
          <div className="text-xs">
            <ResultError message={review.loadError} />
            <button
              type="button"
              disabled={loading || busy}
              onClick={() => {
                void review.refresh()
              }}
              className={resultButton}
            >
              Retry result
            </button>
          </div>
        ) : null}
        {!loading && !review.loadError && !result ? (
          <p className="text-xs text-fg-muted">
            {target
              ? 'The selected result changed or is unavailable. Choose a version to inspect.'
              : 'No versioned result is available. The worker report above is not an accepted code snapshot.'}
          </p>
        ) : null}
        {review.task?.results.length ? (
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <label htmlFor={`${id}-version`} className="text-2xs text-fg-muted">
              Result version
            </label>
            <select
              id={`${id}-version`}
              value={target?.resultId ?? ''}
              disabled={busy || loading}
              onChange={(event) => {
                review.select(event.target.value)
                setDiffOpen(false)
              }}
              className="min-w-0 rounded-md border border-border bg-surface-1 px-2 py-1 text-xs text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
            >
              {!target ? <option value="">Choose version</option> : null}
              {target &&
              !review.task.results.some((entry) => entry.resultId === target.resultId) ? (
                <option value={target.resultId} disabled>
                  Version {target.version} · Unavailable
                </option>
              ) : null}
              {review.task.results.map((entry) => (
                <option key={entry.resultId} value={entry.resultId}>
                  Version {entry.version}
                  {entry.resultId === review.task?.currentResultId ? ' · Current' : ''}
                </option>
              ))}
            </select>
            {result ? (
              <span className="text-2xs text-fg-muted">{LABEL[result.reviewState]}</span>
            ) : null}
            {review.currentResult && !current ? (
              <button
                type="button"
                disabled={busy || loading}
                className={resultButton}
                onClick={() => {
                  review.select(review.currentResult!.resultId)
                  setDiffOpen(false)
                }}
              >
                Inspect current version
              </button>
            ) : null}
          </div>
        ) : null}
        {result ? (
          <>
            <div className="max-h-52 overflow-auto break-words text-xs">
              <MarkdownBlock text={result.summary} />
            </div>
            {result.terminalStatus !== 'completed' ? (
              <p className="mt-2 text-xs text-warning">
                Attempt {result.terminalStatus}. Review unfinished work before accepting.
              </p>
            ) : null}
            {result.snapshotUnavailable ? (
              <p className="mt-2 text-xs text-warning">
                Snapshot unavailable. Restore the workspace or retry in a new session before
                accepting.
              </p>
            ) : !result.snapshotCommit ? (
              <p className="mt-2 text-xs text-fg-muted">
                Report only. Acceptance records the report; no code can be integrated.
              </p>
            ) : null}
            {!current ? (
              <p className="mt-2 text-xs text-fg-subtle">
                Historical version.{' '}
                {review.currentResult
                  ? `Version ${review.currentResult.version} is current.`
                  : 'A newer attempt has no result yet.'}{' '}
                Choose the current version to accept or integrate.
              </p>
            ) : null}
            <div className="mt-2 flex flex-wrap gap-1">
              {result.snapshotCommit && !result.snapshotUnavailable ? (
                <button
                  type="button"
                  disabled={disabled}
                  className={resultButton}
                  onClick={() => {
                    setDiffOpen(true)
                  }}
                >
                  Review changes
                </button>
              ) : null}
              {current && !['accepted', 'integrated'].includes(result.reviewState) ? (
                <button
                  type="button"
                  disabled={disabled || result.snapshotUnavailable}
                  className={resultButton}
                  onClick={review.accept}
                >
                  {result.snapshotCommit || result.snapshotUnavailable
                    ? 'Accept result'
                    : 'Accept report'}
                </button>
              ) : null}
              {current &&
              result.reviewState === 'accepted' &&
              result.snapshotCommit &&
              !result.snapshotUnavailable ? (
                <button
                  type="button"
                  disabled={disabled}
                  className={resultButton}
                  onClick={review.integrate}
                >
                  Integrate accepted result
                </button>
              ) : null}
              {current && result.reviewState !== 'integrated' ? (
                <button
                  type="button"
                  disabled={disabled || result.snapshotUnavailable}
                  className={resultButton}
                  onClick={() => setEditing(!editing)}
                  aria-expanded={editing}
                >
                  Request correction
                </button>
              ) : null}
            </div>
            {editing ? (
              <form
                className="mt-2"
                onSubmit={(event) => {
                  event.preventDefault()
                  const submitted = feedback
                  review.correct(submitted, () => {
                    setFeedback((value) => (value === submitted ? '' : value))
                    setEditing(false)
                  })
                }}
              >
                <label htmlFor={`${id}-feedback`} className="mb-1 block text-2xs text-fg-muted">
                  Correction feedback
                </label>
                <textarea
                  id={`${id}-feedback`}
                  rows={2}
                  maxLength={64000}
                  value={feedback}
                  disabled={busy}
                  onChange={(event) => setFeedback(event.target.value)}
                  placeholder="What needs to change?"
                  className="w-full rounded-md border border-border bg-surface-1 px-2 py-1.5 text-xs text-fg placeholder:text-fg-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
                />
                <button
                  type="submit"
                  disabled={
                    disabled ||
                    !current ||
                    !feedback.trim() ||
                    result.snapshotUnavailable ||
                    result.reviewState === 'integrated'
                  }
                  className={resultButton}
                >
                  Send correction
                </button>
              </form>
            ) : null}
            <details className="mt-2 text-2xs text-fg-subtle">
              <summary className="cursor-pointer rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring">
                Checks and provenance · {result.workerReportedChecks.length} worker reported ·{' '}
                {result.verifiedChecks.length} independent
              </summary>
              <p className="mt-2 break-all font-mono">
                Result {result.resultId} · Attempt {result.attemptId}
              </p>
              <p className="break-all font-mono">
                Snapshot {result.snapshotCommit ?? 'not available'}
              </p>
              <p className="mt-2">
                Worker checks are reported claims. Independent verification runs git diff --check on
                the snapshot; it does not run tests.
              </p>
              {(['workerReportedChecks', 'verifiedChecks'] as const).map((kind) => (
                <div key={kind} className="mt-2">
                  <p className="font-medium text-fg-muted">
                    {kind === 'workerReportedChecks'
                      ? 'Worker reported checks'
                      : 'Independent snapshot checks'}
                  </p>
                  {!result[kind].length ? (
                    <p>None recorded.</p>
                  ) : (
                    <ul className="mt-1 space-y-1">
                      {result[kind].map((check, index) => (
                        <li key={index}>
                          <p className="break-all font-mono">{check.command}</p>
                          <p className="break-all">
                            {check.exitCode === null
                              ? 'Exit status unknown'
                              : `Exit ${check.exitCode}`}{' '}
                            · {check.cwd} · {check.snapshotCommit ?? 'Snapshot not recorded'}
                          </p>
                          {check.detail ? <p className="break-words">{check.detail}</p> : null}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
              {current && result.snapshotCommit && !result.snapshotUnavailable ? (
                <button
                  type="button"
                  disabled={disabled}
                  className={`${resultButton} mt-1`}
                  onClick={review.verify}
                >
                  Check snapshot whitespace
                </button>
              ) : null}
              {result.files.length ? (
                <details className="mt-2">
                  <summary className="cursor-pointer">
                    Changed files ({result.files.length})
                  </summary>
                  <ul className="break-all font-mono">
                    {result.files.map((path) => (
                      <li key={path}>{path}</li>
                    ))}
                  </ul>
                </details>
              ) : null}
              {result.reviewHistory.length ? (
                <details className="mt-2">
                  <summary className="cursor-pointer">Review history</summary>
                  <ul>
                    {result.reviewHistory.map((entry, index) => (
                      <li key={index} className="break-words">
                        {LABEL[entry.state]} · {new Date(entry.at).toLocaleString()}
                        {entry.feedback ? ` · ${entry.feedback}` : ''}
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}
            </details>
            {result.unresolvedIssues.length ? (
              <details className="mt-2 text-xs text-warning">
                <summary className="cursor-pointer">
                  Unresolved issues ({result.unresolvedIssues.length})
                </summary>
                <ul className="list-disc break-words pl-4">
                  {result.unresolvedIssues.map((issue, index) => (
                    <li key={index}>{issue}</li>
                  ))}
                </ul>
              </details>
            ) : null}
            {result.nextAction ? (
              <details className="mt-2 text-2xs text-fg-muted">
                <summary className="cursor-pointer">Worker’s suggested next action</summary>
                <p className="break-words">{result.nextAction}</p>
              </details>
            ) : null}
          </>
        ) : null}
        {busy ? (
          <p role="status" className="mt-2 text-xs text-fg-muted">
            Working on this result…
          </p>
        ) : null}
        {review.notice ? (
          <p role="status" className="mt-2 text-xs text-fg-muted">
            {review.notice}
          </p>
        ) : null}
        {review.error ? (
          <div className="mt-2">
            <ResultError message={review.error} />
          </div>
        ) : null}
        {review.retry ? (
          <button
            type="button"
            disabled={busy || loading}
            className={`${resultButton} mt-1`}
            onClick={review.retry.run}
          >
            Retry {review.retry.label}
          </button>
        ) : null}
      </div>
      {open && diffOpen && target && review.task ? (
        <DelegatedResultDiff
          key={`${target.resultId}:${target.snapshotCommit}`}
          open={diffOpen}
          onOpenChange={setDiffOpen}
          title={child.title}
          sessionId={sessionId}
          taskId={review.task.taskId}
          target={target}
        />
      ) : null}
    </div>
  )
}
