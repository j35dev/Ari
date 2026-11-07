import type { OrchestrationTask } from '@ari/contracts/orchestration'
import { MarkdownBlock } from '../transcript/MarkdownBlock'
import { workButton } from './work-actions'

const reviewLabel = {
  available: 'Result ready',
  reviewing: 'Reviewing',
  changes_requested: 'Changes requested',
  accepted: 'Accepted',
  integrated: 'Integrated',
}

export interface ComparisonSelection {
  taskId: string
  resultId: string
}

/** Selection pins result versions even when a newer attempt reports back. */
export function WorkComparison({
  tasks,
  selected,
  onClear,
}: {
  tasks: readonly OrchestrationTask[]
  selected: readonly ComparisonSelection[]
  onClear: () => void
}) {
  const entries = selected.flatMap((selection) => {
    const task = tasks.find((task) => task.taskId === selection.taskId)
    const result = task?.results.find((result) => result.resultId === selection.resultId)
    return task && result ? [{ task, result }] : []
  })
  if (entries.length < 2) return null
  const bases = entries.map(({ task }) => task.baseSnapshotCommit)
  const commonBase = bases[0] && bases.every((base) => base === bases[0]) ? bases[0] : null
  return (
    <section aria-label="Result comparison" className="my-3 border-y border-border py-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-xs font-medium text-fg">Compare results</h3>
        <button type="button" className={workButton} onClick={onClear}>
          Clear comparison
        </button>
      </div>
      <p className="mb-3 text-2xs text-fg-subtle">
        {commonBase
          ? `Common workspace base ${commonBase.slice(0, 12)}`
          : bases.every(Boolean)
            ? 'These tasks used different workspace bases.'
            : 'A common workspace base is not recorded for these results.'}
      </p>
      <div
        className="overflow-x-auto rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
        tabIndex={0}
        role="region"
        aria-label="Comparison table"
      >
        <table
          className="w-full table-fixed border-collapse text-left text-2xs"
          style={{ minWidth: entries.length * 200 + 100 }}
        >
          <thead>
            <tr>
              <th className="w-24 border-b border-border p-2 font-medium text-fg-muted">
                Evidence
              </th>
              {entries.map(({ task, result }) => (
                <th
                  key={result.resultId}
                  className="border-b border-border p-2 align-top font-medium text-fg"
                >
                  {task.title}
                  <span className="mt-1 block font-normal text-fg-subtle">
                    {task.driverKind} · {task.modelId ?? 'Default'} · Version {result.version}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              <th className="border-b border-border p-2 align-top font-medium">Outcome</th>
              {entries.map(({ task, result }) => (
                <td
                  key={result.resultId}
                  className="border-b border-border p-2 align-top text-fg-muted"
                >
                  {result.terminalStatus} · {reviewLabel[result.reviewState]}
                  {result.resultId !== task.currentResultId ? ' · Historical version' : ''}
                  <span className="mt-1 block font-mono">
                    {result.snapshotCommit?.slice(0, 12) ?? 'Report only'}
                  </span>
                </td>
              ))}
            </tr>
            <tr>
              <th className="border-b border-border p-2 align-top font-medium">Checks</th>
              {entries.map(({ result }) => (
                <td
                  key={result.resultId}
                  className="border-b border-border p-2 align-top text-fg-muted"
                >
                  {(['workerReportedChecks', 'verifiedChecks'] as const).map((kind) => (
                    <div key={kind} className="mb-2">
                      <p className="font-medium">
                        {kind === 'workerReportedChecks' ? 'Worker reported' : 'Verified'}
                      </p>
                      {result[kind].length ? (
                        <ul>
                          {result[kind].map((check, index) => (
                            <li key={index} className="mt-1 break-words">
                              <code>{check.command}</code> ·{' '}
                              {check.exitCode === null ? 'Exit unknown' : `Exit ${check.exitCode}`}
                              <span className="block">
                                {check.cwd} ·{' '}
                                {check.snapshotCommit?.slice(0, 12) ?? 'Snapshot not recorded'}
                              </span>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p>None recorded</p>
                      )}
                    </div>
                  ))}
                </td>
              ))}
            </tr>
            <tr>
              <th className="border-b border-border p-2 align-top font-medium">Open issues</th>
              {entries.map(({ result }) => (
                <td
                  key={result.resultId}
                  className="border-b border-border p-2 align-top text-fg-muted"
                >
                  {result.unresolvedIssues.length ? (
                    <ul className="list-disc pl-3">
                      {result.unresolvedIssues.map((issue, index) => (
                        <li key={index}>{issue}</li>
                      ))}
                    </ul>
                  ) : (
                    'None reported'
                  )}
                </td>
              ))}
            </tr>
            <tr>
              <th className="p-2 align-top font-medium">Report</th>
              {entries.map(({ result }) => (
                <td key={result.resultId} className="p-2 align-top">
                  <MarkdownBlock text={result.summary} />
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  )
}
