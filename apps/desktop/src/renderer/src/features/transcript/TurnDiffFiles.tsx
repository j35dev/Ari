import { useEffect, useState } from 'react'
import type { GitTurnDiffSummary, RpcResults } from '@ari/contracts/rpc'
import { useSessionClient } from '../session/session-client'
import { DiffViewer, type DiffComment } from '../diffs'

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
  const rpc = useSessionClient()
  const [selected, setSelected] = useState(summary.files[0]?.path ?? '')
  const [retry, setRetry] = useState(0)
  const [patch, setPatch] = useState<{
    key: string
    result: RpcResults['git.turnDiffFile']
  } | null>(null)
  const file = summary.files.find((entry) => entry.path === selected) ?? summary.files[0]
  const key = JSON.stringify([rpc.viewKey, rpc.authorizationEpoch, sessionId, summary.baseOid, summary.headOid, file?.path ?? '', retry])
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
    <div className="pt-2">
      <div className="flex items-center gap-2 pb-2">
        <select
          aria-label="Changed file"
          value={file.path}
          onChange={(event) => setSelected(event.target.value)}
          className="min-w-0 flex-1 rounded-md border border-border bg-surface-1 px-2 py-1 font-mono text-xs text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
        >
          {summary.files.map((entry) => (
            <option key={entry.path} value={entry.path}>
              {entry.path}
              {entry.binary ? ' (binary)' : ` (+${entry.additions} −${entry.deletions})`}
            </option>
          ))}
        </select>
        <span className="shrink-0 text-2xs text-fg-subtle">One file at a time</span>
      </div>
      {file.binary ? (
        <p role="status" className="py-2 text-xs text-fg-muted">
          Binary file changed.
        </p>
      ) : result === null ? (
        <p role="status" className="py-2 text-xs text-fg-muted">
          Loading file diff…
        </p>
      ) : result.tooLarge ? (
        <p role="status" className="py-2 text-xs text-fg-muted">
          This file is too large to preview in chat.
        </p>
      ) : result.error ? (
        <div role="status" className="flex items-center gap-2 py-2 text-xs">
          <span className="text-danger">{result.error}</span>
          <button
            type="button"
            onClick={() => setRetry((value) => value + 1)}
            className="text-fg-muted underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
          >
            Retry file diff
          </button>
        </div>
      ) : (
        <div className="ari-scroll max-h-96 overflow-auto">
          <DiffViewer diffText={result.diffText ?? ''} onLineComment={onComment} />
        </div>
      )}
    </div>
  )
}
