import { useId, useState, type ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import type { ResultPackage } from '@ari/contracts/orchestration'
import { outlineButton, primaryButton, quietButton } from '../../lib/recipes'
import type { DelegatedChild } from './types'
import { MarkdownBlock } from './MarkdownBlock'
import { DelegatedResultDiff } from './DelegatedResultDiff'
import { ResultError, resultButton } from './result-controls'
import { useDelegatedResult } from './use-delegated-result'

const LABEL: Record<ResultPackage['reviewState'], string> = {
  available: 'Ready for review',
  reviewing: 'Reviewing',
  changes_requested: 'Changes requested',
  accepted: 'Accepted',
  integrated: 'Integrated',
}

/** What the row's action says once a result has been looked at; short, so rows line up. */
const ACTION_LABEL: Record<ResultPackage['reviewState'], string> = {
  available: 'View result',
  reviewing: 'Reviewing',
  changes_requested: 'Changes asked',
  accepted: 'Accepted',
  integrated: 'Integrated',
}

/**
 * The width every row's trailing slot shares, so the column before it lines
 * up whether a row ends in a result action, a running time, or nothing.
 */
export const RESULT_SLOT = 'min-w-[6.75rem] justify-end'

/** A line of guidance under the result summary. */
const NOTE = 'mt-2 text-[13px] text-fg-muted'
/** The same line when it should not be skimmed past: ink, not a status colour. */
const CAUTION = 'mt-2 text-[13px] text-fg'
const FIELD =
  'rounded-md border border-border-strong bg-surface-1 text-[13px] text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring'
const SUMMARY =
  'cursor-pointer rounded-sm transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring'

/** A quiet entry point beside a settled child, with no permanent management panel. */
export function DelegatedResult({
  sessionId,
  child,
  placeholder,
}: {
  sessionId: string
  child: DelegatedChild
  /** Shown in the action's place while the child has no result to open. */
  placeholder?: ReactNode
}) {
  return (
    <ScopedDelegatedResult
      key={`${sessionId}:${child.sessionId}`}
      sessionId={sessionId}
      child={child}
      placeholder={placeholder}
    />
  )
}

function ScopedDelegatedResult({
  sessionId,
  child,
  placeholder,
}: {
  sessionId: string
  child: DelegatedChild
  placeholder?: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [diffOpen, setDiffOpen] = useState(false)
  const id = useId()
  const review = useDelegatedResult(sessionId, child.sessionId, open)
  const { result, target, current, busy, loading } = review
  const settled = ['done', 'failed', 'stopped', 'idle', 'removed'].includes(child.state)
  if (!settled && !open && !review.task) return placeholder ?? null
  const disabled = busy || loading || !!review.loadError || !settled
  return (
    // `contents`: in a delegation row the action sits at the end of the agent's
    // line and the result opens as a well on the line below it.
    <div className="contents">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
        aria-label={`${open ? 'Hide' : 'Inspect'} result for ${child.title}`}
        // A text action, not a boxed button: a list of agents would otherwise
        // end every line in the same outlined button.
        className={`${quietButton} ${RESULT_SLOT} h-7 shrink-0 gap-1 px-2 font-normal text-fg-subtle ${
          open ? 'bg-fg/6 text-fg' : ''
        }`}
      >
        {open ? 'Hide result' : result ? ACTION_LABEL[result.reviewState] : 'View result'}
        <ChevronDown
          size={13}
          aria-hidden="true"
          className={`transition-transform duration-150 motion-reduce:transition-none ${open ? 'rotate-180' : ''}`}
        />
      </button>
      <div
        id={id}
        hidden={!open}
        className="mb-2 mt-1 w-full rounded-lg border border-border bg-surface-0 px-3.5 py-3"
      >
        {loading ? (
          <p role="status" className="text-[13px] text-fg-subtle">
            Loading result…
          </p>
        ) : null}
        {review.loadError ? (
          <div>
            <ResultError message={review.loadError} />
            <button
              type="button"
              disabled={loading || busy}
              onClick={() => {
                void review.refresh()
              }}
              className={`${resultButton} mt-1`}
            >
              Retry result
            </button>
          </div>
        ) : null}
        {!loading && !review.loadError && !result ? (
          <p className="text-[13px] text-fg-muted">
            {target
              ? 'The selected result changed or is unavailable. Choose a version to inspect.'
              : 'No versioned result is available. The worker report above is not an accepted code snapshot.'}
          </p>
        ) : null}
        {review.task?.results.length ? (
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <label htmlFor={`${id}-version`} className="text-xs text-fg-subtle">
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
              className={`h-7 min-w-0 px-2 ${FIELD}`}
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
              <span className="text-xs text-fg-muted">{LABEL[result.reviewState]}</span>
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
            <div className="ari-scroll max-h-52 overflow-auto break-words">
              <MarkdownBlock text={result.summary} />
            </div>
            {result.terminalStatus !== 'completed' ? (
              <p className={CAUTION}>
                Attempt {result.terminalStatus}. Review unfinished work before accepting.
              </p>
            ) : null}
            {result.snapshotUnavailable ? (
              <p className={CAUTION}>
                Snapshot unavailable. Restore the workspace or retry in a new session before
                accepting.
              </p>
            ) : !result.snapshotCommit ? (
              <p className={NOTE}>
                Report only. Acceptance records the report; no code can be integrated.
              </p>
            ) : null}
            {!current ? (
              <p className="mt-2 text-[13px] text-fg-subtle">
                Historical version.{' '}
                {review.currentResult
                  ? `Version ${review.currentResult.version} is current.`
                  : 'A newer attempt has no result yet.'}{' '}
                Choose the current version to accept or integrate.
              </p>
            ) : null}
            {/* Accepting or integrating is the one filled action; review is beside it. */}
            <div className="mt-3 flex flex-wrap gap-1.5">
              {result.snapshotCommit && !result.snapshotUnavailable ? (
                <button
                  type="button"
                  disabled={disabled}
                  className={outlineButton}
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
                  className={primaryButton}
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
                  className={primaryButton}
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
                <label htmlFor={`${id}-feedback`} className="mb-1 block text-xs text-fg-subtle">
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
                  className={`block w-full px-2.5 py-1.5 placeholder:text-fg-subtle ${FIELD}`}
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
                  className={`${outlineButton} mt-1.5`}
                >
                  Send correction
                </button>
              </form>
            ) : null}
            <details className="mt-3 text-xs leading-relaxed text-fg-subtle">
              <summary className={SUMMARY}>
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
                  <summary className={SUMMARY}>Changed files ({result.files.length})</summary>
                  <ul className="break-all font-mono">
                    {result.files.map((path) => (
                      <li key={path}>{path}</li>
                    ))}
                  </ul>
                </details>
              ) : null}
              {result.reviewHistory.length ? (
                <details className="mt-2">
                  <summary className={SUMMARY}>Review history</summary>
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
              <details className="mt-2 text-[13px] leading-relaxed text-fg">
                <summary className={SUMMARY}>
                  Unresolved issues ({result.unresolvedIssues.length})
                </summary>
                <ul className="mt-1 list-disc break-words pl-5 text-fg-muted">
                  {result.unresolvedIssues.map((issue, index) => (
                    <li key={index}>{issue}</li>
                  ))}
                </ul>
              </details>
            ) : null}
            {result.nextAction ? (
              <details className="mt-2 text-xs leading-relaxed text-fg-subtle">
                <summary className={SUMMARY}>Worker’s suggested next action</summary>
                <p className="mt-1 break-words text-fg-muted">{result.nextAction}</p>
              </details>
            ) : null}
          </>
        ) : null}
        {busy ? (
          <p role="status" className={NOTE}>
            Working on this result…
          </p>
        ) : null}
        {review.notice ? (
          <p role="status" className={NOTE}>
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
