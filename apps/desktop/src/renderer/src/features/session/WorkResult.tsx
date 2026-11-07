import { useRef, useState } from 'react'
import type {
  OrchestrationDiff,
  OrchestrationTask,
  ResultPackage,
} from '@ari/contracts/orchestration'
import { MarkdownBlock } from '../transcript/MarkdownBlock'
import { invokeWork, workActionKey, workButton, workInput } from './work-actions'

const LABEL: Record<ResultPackage['reviewState'], string> = {
  available: 'Result ready',
  reviewing: 'Reviewing',
  changes_requested: 'Changes requested',
  accepted: 'Accepted',
  integrated: 'Integrated',
}

export function WorkResult({
  sessionId,
  task,
  onChanged,
}: {
  sessionId: string
  task: OrchestrationTask
  onChanged: () => void
}) {
  const [selected, setSelected] = useState<string | null>(null)
  const [diff, setDiff] = useState<OrchestrationDiff | null>(null)
  const [feedback, setFeedback] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const receipts = useRef(new Map<string, string>())
  const key = (value: unknown) => {
    const fingerprint = JSON.stringify(value)
    const existing = receipts.current.get(fingerprint)
    if (existing) return existing
    const next = workActionKey()
    receipts.current.set(fingerprint, next)
    return next
  }
  const result =
    task.results.find((item) => item.resultId === (selected ?? task.currentResultId)) ??
    task.results.at(-1)
  if (!result) return null
  const current = result.resultId === task.currentResultId
  const run = async (action: () => Promise<void>) => {
    if (busy) return
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await action()
      onChanged()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not complete the result action.')
    } finally {
      setBusy(false)
    }
  }
  const review = (state: 'reviewing' | 'changes_requested' | 'accepted') =>
    run(async () => {
      await invokeWork('orchestration.review', {
        sessionId,
        taskId: task.taskId,
        resultId: result.resultId,
        snapshotCommit: result.snapshotCommit,
        state,
        ...(feedback.trim() ? { feedback: feedback.trim() } : {}),
        idempotencyKey: key([
          'review',
          result.resultId,
          result.snapshotCommit,
          state,
          feedback.trim(),
        ]),
      })
      setFeedback('')
      if (state === 'changes_requested')
        setNotice(
          'Feedback recorded. Retry the task to start an attempt with this review feedback.',
        )
    })
  return (
    <section aria-label="Result review" className="border-b border-border px-4 py-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <label htmlFor={`result-version-${task.taskId}`} className="text-xs font-medium text-fg">
          Result
        </label>
        <select
          id={`result-version-${task.taskId}`}
          value={result.resultId}
          className="rounded border border-border bg-surface-1 px-2 py-1 text-xs text-fg"
          onChange={(event) => {
            setSelected(event.target.value)
            setDiff(null)
            setError(null)
          }}
        >
          {task.results.map((item) => (
            <option key={item.resultId} value={item.resultId}>
              Version {item.version}
              {item.resultId === task.currentResultId ? ' · Current' : ''}
            </option>
          ))}
        </select>
        <span className="text-2xs text-fg-muted">{LABEL[result.reviewState]}</span>
      </div>
      <MarkdownBlock text={result.summary} />
      {result.terminalStatus !== 'completed' ? (
        <p className="mt-3 text-xs text-warning">
          Attempt {result.terminalStatus}. Review the unresolved work before accepting.
        </p>
      ) : null}
      {result.files.length ? (
        <details className="mt-3 text-xs text-fg-muted">
          <summary className="cursor-pointer">Changed files ({result.files.length})</summary>
          <ul className="mt-2 space-y-1 break-all font-mono text-2xs">
            {result.files.map((path) => (
              <li key={path}>{path}</li>
            ))}
          </ul>
        </details>
      ) : null}
      {result.snapshotCommit ? (
        <p className="mt-3 break-all font-mono text-2xs text-fg-subtle">
          Snapshot {result.snapshotCommit.slice(0, 12)}
        </p>
      ) : (
        <p className="mt-3 text-2xs text-fg-subtle">
          {result.snapshotUnavailable
            ? 'Snapshot unavailable · Restore the workspace or retry in a new session.'
            : 'Report only · No isolated code snapshot'}
        </p>
      )}
      {(['workerReportedChecks', 'verifiedChecks'] as const).map((kind) =>
        result[kind].length ? (
          <div key={kind} className="mt-3">
            <p className="text-xs font-medium text-fg">
              {kind === 'workerReportedChecks' ? 'Worker reported checks' : 'Verified checks'}
            </p>
            <ul className="mt-1 space-y-2">
              {result[kind].map((check, index) => (
                <li key={index} className="text-2xs text-fg-muted">
                  <p className="break-all font-mono">{check.command}</p>
                  <p>
                    {check.exitCode === null ? 'Exit status unknown' : `Exit ${check.exitCode}`} ·{' '}
                    {check.cwd}
                    {check.snapshotCommit
                      ? ` · ${check.snapshotCommit.slice(0, 12)}`
                      : ' · Snapshot not recorded'}
                  </p>
                  {check.detail ? <p>{check.detail}</p> : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null,
      )}
      {!result.workerReportedChecks.length && !result.verifiedChecks.length ? (
        <p className="mt-3 text-2xs text-fg-subtle">No checks recorded</p>
      ) : null}
      {result.unresolvedIssues.length ? (
        <div className="mt-3 text-xs text-warning">
          <p>Unresolved issues</p>
          <ul className="mt-1 list-disc pl-4">
            {result.unresolvedIssues.map((issue, index) => (
              <li key={index}>{issue}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {result.nextAction ? <p className="mt-3 text-xs text-fg-muted">{result.nextAction}</p> : null}
      <div className="mt-3 flex flex-wrap gap-1">
        {result.snapshotCommit ? (
          <button
            type="button"
            disabled={busy}
            className={workButton}
            onClick={() =>
              void run(async () => {
                const next = await invokeWork('orchestration.diff', {
                  sessionId,
                  taskId: task.taskId,
                  resultId: result.resultId,
                  patch: true,
                })
                if (next.currentSnapshotCommit !== result.snapshotCommit)
                  throw new Error(
                    'This result snapshot changed. Select the current result before reviewing the diff.',
                  )
                setDiff(next)
                if (result.reviewState === 'available' && current)
                  await invokeWork('orchestration.review', {
                    sessionId,
                    taskId: task.taskId,
                    resultId: result.resultId,
                    snapshotCommit: result.snapshotCommit,
                    state: 'reviewing',
                    idempotencyKey: key([
                      'review',
                      result.resultId,
                      result.snapshotCommit,
                      'reviewing',
                    ]),
                  })
              })
            }
          >
            Review diff
          </button>
        ) : null}
        {current && !['accepted', 'integrated'].includes(result.reviewState) ? (
          <button
            type="button"
            disabled={busy || result.snapshotUnavailable}
            title={
              result.snapshotUnavailable
                ? 'Restore the worker snapshot before accepting.'
                : undefined
            }
            className={workButton}
            onClick={() => void review('accepted')}
          >
            Accept result
          </button>
        ) : null}
        {current && result.reviewState === 'accepted' && result.snapshotCommit ? (
          <button
            type="button"
            disabled={busy}
            className={workButton}
            onClick={() =>
              void run(async () => {
                const response = await invokeWork('orchestration.integrate', {
                  sessionId,
                  taskId: task.taskId,
                  resultId: result.resultId,
                  snapshotCommit: result.snapshotCommit!,
                  idempotencyKey: key(['integrate', result.resultId, result.snapshotCommit]),
                })
                if (response.status === 'conflict')
                  throw new Error(
                    `Integration conflicts: ${response.files?.join(', ') ?? 'refresh the diff for details'}`,
                  )
                setNotice('Result integrated into the project workspace.')
              })
            }
          >
            Integrate accepted snapshot
          </button>
        ) : null}
        {current && result.snapshotCommit ? (
          <button
            type="button"
            disabled={busy}
            className={workButton}
            onClick={() =>
              void run(async () => {
                const verified = await invokeWork('orchestration.verify', {
                  sessionId,
                  taskId: task.taskId,
                  resultId: result.resultId,
                  snapshotCommit: result.snapshotCommit!,
                  idempotencyKey: key(['verify', result.resultId, result.snapshotCommit]),
                })
                const check = verified.verifiedChecks.at(-1)
                if (check?.exitCode !== 0)
                  throw new Error(
                    check?.detail ??
                      'Snapshot whitespace check did not pass. Inspect the recorded check for details.',
                  )
                setNotice('Snapshot whitespace check passed.')
              })
            }
          >
            Check snapshot
          </button>
        ) : null}
      </div>
      {diff ? (
        <details open className="mt-3 text-xs text-fg-muted">
          <summary className="cursor-pointer">
            {diff.totals.files} files · +{diff.totals.additions} −{diff.totals.deletions}
          </summary>
          <pre className="mt-2 max-h-96 overflow-auto whitespace-pre rounded bg-surface-1 p-2 font-mono text-2xs">
            {diff.patch || 'No text patch. Check the changed-file list for binary files.'}
          </pre>
        </details>
      ) : null}
      {current && result.reviewState !== 'integrated' ? (
        <form
          className="mt-4"
          onSubmit={(event) => {
            event.preventDefault()
            if (feedback.trim()) void review('changes_requested')
          }}
        >
          <label
            className="mb-2 block text-xs text-fg-muted"
            htmlFor={`result-feedback-${task.taskId}`}
          >
            Request changes
          </label>
          <textarea
            id={`result-feedback-${task.taskId}`}
            rows={3}
            maxLength={64000}
            value={feedback}
            onChange={(event) => setFeedback(event.target.value)}
            className={workInput}
            placeholder="Explain what needs to change…"
          />
          <button
            type="submit"
            disabled={busy || !feedback.trim()}
            className={`${workButton} mt-1`}
          >
            Record review feedback
          </button>
        </form>
      ) : null}
      {!current ? (
        <p className="mt-3 text-xs text-fg-subtle">
          Historical version · Select the current version to accept or integrate.
        </p>
      ) : null}
      {result.reviewHistory.length ? (
        <details className="mt-3 text-2xs text-fg-subtle">
          <summary className="cursor-pointer">Review history</summary>
          <ul className="mt-2 space-y-1">
            {result.reviewHistory.map((entry, index) => (
              <li key={index}>
                {LABEL[entry.state]} · {new Date(entry.at).toLocaleString()}
                {entry.feedback ? ` · ${entry.feedback}` : ''}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {notice ? (
        <p role="status" className="mt-3 text-xs text-success">
          {notice}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="mt-3 text-xs text-danger">
          {error}
        </p>
      ) : null}
    </section>
  )
}
