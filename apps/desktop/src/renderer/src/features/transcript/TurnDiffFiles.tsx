import { useEffect, useState } from 'react'
import type { GitTurnDiffSummary, RpcResults } from '@ari/contracts/rpc'
import { quietButton } from '../../lib/recipes'
import { rpc } from '../../lib/rpc'
import { DiffViewer, type DiffComment } from '../diffs'

/** A one-line state in place of the diff. */
const NOTE = 'flex min-h-7 items-center text-[13px] text-fg-muted'

/** Keep one file patch in memory; changing files cannot replace the turn's saved endpoints. */
export function TurnDiffFiles({
  active,
  sessionId,
  summary,
  onComment,
}: {
  active: boolean
  sessionId: string
  summary: GitTurnDiffSummary
  onComment?: (comment: DiffComment) => void
}) {
  const [selected, setSelected] = useState(summary.files[0]?.path ?? '')
  const [retry, setRetry] = useState(0)
  const [patch, setPatch] = useState<{
    key: string
    result: RpcResults['git.turnDiffFile']
  } | null>(null)
  const file = summary.files.find((entry) => entry.path === selected) ?? summary.files[0]
  const key = `${sessionId}:${summary.baseOid}:${summary.headOid}:${file?.path ?? ''}:${retry}`
  useEffect(() => {
    if (!active || !file || file.binary || patch?.key === key) return
    let cancelled = false
    void rpc
      .invoke('git.turnDiffFile', {
        sessionId,
        baseOid: summary.baseOid,
        headOid: summary.headOid,
        path: file.path,
        ...(file.oldPath ? { oldPath: file.oldPath } : {}),
      })
      .then((result) => {
        if (!cancelled) setPatch({ key, result })
      })
      .catch(() => {
        if (!cancelled)
          setPatch({ key, result: { diffText: null, error: 'Could not load this file’s diff.' } })
      })
    return () => {
      cancelled = true
    }
    // The key pins the session, trees, path and retry. A completed patch stays cached on collapse.
  }, [active, key])

  if (!active || !file) return null
  const result = patch?.key === key ? patch.result : null
  return (
    <div className="pb-1 pt-1.5">
      <div className="flex items-center gap-3 pb-2">
        <select
          aria-label="Changed file"
          value={file.path}
          onChange={(event) => setSelected(event.target.value)}
          className="h-7 min-w-0 flex-1 rounded-md border border-border-strong bg-surface-1 px-2 font-mono text-xs text-fg-muted transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
        >
          {summary.files.map((entry) => (
            <option key={entry.path} value={entry.path}>
              {entry.path}
              {entry.binary ? ' (binary)' : ` (+${entry.additions} −${entry.deletions})`}
            </option>
          ))}
        </select>
        <span className="shrink-0 text-xs text-fg-subtle">One file at a time</span>
      </div>
      {file.binary ? (
        <p role="status" className={NOTE}>
          Binary file changed.
        </p>
      ) : result === null ? (
        <p role="status" className={NOTE}>
          Loading file diff…
        </p>
      ) : result.tooLarge ? (
        <p role="status" className={NOTE}>
          This file is too large to preview in chat.
        </p>
      ) : result.error ? (
        <div role="status" className="flex min-h-7 items-center gap-2 text-[13px]">
          <span className="ari-status" data-status="error" aria-hidden="true" />
          <span className="min-w-0 text-fg">{result.error}</span>
          <button
            type="button"
            onClick={() => setRetry((value) => value + 1)}
            className={quietButton}
          >
            Retry file diff
          </button>
        </div>
      ) : (
        <div className="ari-scroll max-h-96 overflow-auto rounded-lg border border-border bg-surface-0">
          <DiffViewer diffText={result.diffText ?? ''} onLineComment={onComment} />
        </div>
      )}
    </div>
  )
}
