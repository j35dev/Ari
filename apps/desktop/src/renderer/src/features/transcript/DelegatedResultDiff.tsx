import { useEffect, useState } from 'react'
import { Dialog } from '@ari/ui/dialog'
import type { OrchestrationResultDiff, ResultPackage } from '@ari/contracts/orchestration'
import { useSessionClient } from '../session/session-client'
import { DiffSurface } from '../diffs/DiffSurface'
import { ResultError, resultButton } from './result-controls'

type Target = Pick<ResultPackage, 'resultId' | 'attemptId' | 'version' | 'snapshotCommit'>
type Manifest = Extract<OrchestrationResultDiff, { kind: 'files' }>
const message = (cause: unknown) =>
  cause instanceof Error ? cause.message : 'Could not load this comparison.'

/** On-demand, read-only review. No saved comparison or current-workspace controls. */
export function DelegatedResultDiff({
  open,
  onOpenChange,
  title,
  sessionId,
  taskId,
  target,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  sessionId: string
  taskId: string
  target: Target
}) {
  const client = useSessionClient()
  if (client.scope.kind === 'remote') return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <Dialog.Content>
        <Dialog.Title>{title}</Dialog.Title>
        <Dialog.Description>Versioned result comparisons are unavailable on this host.</Dialog.Description>
        <Dialog.Close className={resultButton}>Close review</Dialog.Close>
      </Dialog.Content>
    </Dialog>
  )
  const identity = JSON.stringify([
    client.viewKey, client.authorizationEpoch,
    sessionId,
    taskId,
    target.resultId,
    target.attemptId,
    target.version,
    target.snapshotCommit,
  ])
  return (
    <PinnedReview key={identity} {...{ open, onOpenChange, title, sessionId, taskId, target }} />
  )
}

function PinnedReview({
  open,
  onOpenChange,
  title,
  sessionId,
  taskId,
  target,
}: Parameters<typeof DelegatedResultDiff>[0]) {
  const rpc = useSessionClient()
  const [manifest, setManifest] = useState<Manifest | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  const [selected, setSelected] = useState('')
  const [offsets, setOffsets] = useState<Record<string, number>>({})
  const [fileRetry, setFileRetry] = useState(0)
  const [patch, setPatch] = useState<{ key: string; text: string; error: string | null } | null>(
    null,
  )
  const { resultId, attemptId, version, snapshotCommit } = target
  const matches = (response: OrchestrationResultDiff) =>
    response.resultId === resultId &&
    response.attemptId === attemptId &&
    response.version === version &&
    response.currentSnapshotCommit === snapshotCommit
  useEffect(() => {
    if (!open || !snapshotCommit) return
    let cancelled = false
    setManifest(null)
    setError(null)
    void rpc
      .invoke('orchestration.result.diff', {
        sessionId,
        taskId,
        resultId,
        attemptId,
        version,
        snapshotCommit,
        kind: 'files',
      })
      .then((response) => {
        if (cancelled) return
        if (response.kind !== 'files' || !matches(response))
          throw new Error('The selected result snapshot changed. Reopen this version to retry.')
        setManifest(response)
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(message(cause))
      })
    return () => {
      cancelled = true
    }
  }, [open, sessionId, taskId, resultId, attemptId, version, snapshotCommit, retry])
  const file = manifest?.files.find((entry) => entry.path === selected) ?? manifest?.files[0]
  const key =
    manifest && file
      ? `${manifest.baseCommit}:${manifest.currentSnapshotCommit}:${file.path}:${fileRetry}`
      : ''
  useEffect(() => {
    if (!open || !manifest || !file || file.binary || !snapshotCommit) return
    let cancelled = false
    void rpc
      .invoke('orchestration.result.diff', {
        sessionId,
        taskId,
        resultId,
        attemptId,
        version,
        snapshotCommit,
        kind: 'file',
        baseCommit: manifest.baseCommit,
        path: file.path,
        ...(file.oldPath ? { oldPath: file.oldPath } : {}),
      })
      .then((response) => {
        if (cancelled) return
        if (
          response.kind !== 'file' ||
          !matches(response) ||
          response.baseCommit !== manifest.baseCommit ||
          response.path !== file.path
        )
          throw new Error('The selected file comparison changed. Retry this file.')
        setPatch({ key, text: response.patch, error: null })
      })
      .catch((cause: unknown) => {
        if (!cancelled) setPatch({ key, text: '', error: message(cause) })
      })
    return () => {
      cancelled = true
    }
  }, [
    open,
    manifest,
    file?.path,
    key,
    sessionId,
    taskId,
    resultId,
    attemptId,
    version,
    snapshotCommit,
  ])
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <Dialog.Content size="lg">
        <header className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-3">
          <div className="min-w-0 flex-1">
            <Dialog.Title className="truncate text-sm">
              {title} · Version {version}
            </Dialog.Title>
            <Dialog.Description className="break-all font-mono text-2xs">
              {manifest
                ? `${manifest.baseCommit.slice(0, 12)} → ${manifest.currentSnapshotCommit.slice(0, 12)} · ${manifest.totals.files} files`
                : 'Review selected result changes'}
            </Dialog.Description>
          </div>
          <Dialog.Close className={resultButton}>Close review</Dialog.Close>
        </header>
        {error ? (
          <div className="p-4 text-xs">
            <ResultError message={error} />
            <button
              type="button"
              onClick={() => setRetry((value) => value + 1)}
              className={resultButton}
            >
              Retry changes
            </button>
          </div>
        ) : !snapshotCommit ? (
          <p className="p-4 text-xs text-fg-muted">No code snapshot available for this result.</p>
        ) : !manifest ? (
          <p role="status" className="p-4 text-xs text-fg-muted">
            Loading changes…
          </p>
        ) : null}
        {file ? (
          <>
            <div className="shrink-0 border-b border-border px-4 py-2">
              <select
                aria-label="Result changed file"
                value={file.path}
                onChange={(event) => setSelected(event.target.value)}
                className="w-full min-w-0 rounded-md border border-border bg-surface-1 px-2 py-1 font-mono text-xs text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
              >
                {manifest?.files.map((entry) => (
                  <option key={entry.path} value={entry.path}>
                    {entry.oldPath ? `${entry.oldPath} → ` : ''}
                    {entry.path} · {entry.status}
                    {entry.binary ? ' (binary)' : ` (+${entry.additions} −${entry.deletions})`}
                  </option>
                ))}
              </select>
              {manifest?.truncated ? (
                <p className="mt-1 text-2xs text-warning">File list limited to 5,000 files.</p>
              ) : null}
            </div>
            <div className="min-h-0 flex-1">
              {file.binary ? (
                <p className="p-4 text-xs text-fg-muted">Binary file changed. No text preview.</p>
              ) : patch?.key !== key ? (
                <p role="status" className="p-4 text-xs text-fg-muted">
                  Loading file diff…
                </p>
              ) : patch.error ? (
                <div className="p-4 text-xs">
                  <ResultError message={patch.error} />
                  <button
                    type="button"
                    onClick={() => setFileRetry((value) => value + 1)}
                    className={resultButton}
                  >
                    Retry file
                  </button>
                </div>
              ) : patch.text ? (
                <DiffSurface
                  key={file.path}
                  diffText={patch.text}
                  path={file.path}
                  comparisonId={`${manifest?.baseCommit}:${snapshotCommit}`}
                  scrollOffset={offsets[file.path] ?? 0}
                  onScrollOffset={(offset) =>
                    setOffsets((previous) => ({ ...previous, [file.path]: offset }))
                  }
                />
              ) : (
                <p className="p-4 text-xs text-fg-muted">No text patch available for this file.</p>
              )}
            </div>
          </>
        ) : manifest ? (
          <p className="p-4 text-xs text-fg-muted">No changed files in this snapshot.</p>
        ) : null}
      </Dialog.Content>
    </Dialog>
  )
}
