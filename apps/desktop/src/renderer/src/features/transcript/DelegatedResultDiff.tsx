import { useMemo, useState } from 'react'
import { Dialog } from '@ari/ui/dialog'
import type { OrchestrationDiff } from '@ari/contracts/orchestration'
import { DiffSurface } from '../diffs/DiffSurface'
import { parseDiff } from '../diffs/parseDiff'
import { ResultError, resultButton } from './result-controls'

const MAX_PREVIEW_CHARS = 2_000_000

/** Shared review surface, pinned to the orchestration diff's exact endpoints. */
export function DelegatedResultDiff({
  open,
  onOpenChange,
  title,
  version,
  diff,
  busy,
  error,
  onRetry,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  version: number
  diff: OrchestrationDiff | null
  busy: boolean
  error: string | null
  onRetry: () => void
}) {
  const [selected, setSelected] = useState('')
  const [offsets, setOffsets] = useState<Record<string, number>>({})
  const tooLarge = (diff?.patch?.length ?? 0) > MAX_PREVIEW_CHARS
  const patches = useMemo(() => {
    if (!open || tooLarge || !diff?.patch) return new Map<string, string>()
    return new Map(
      diff.patch.split(/(?=^diff --git )/m).flatMap((text) => {
        const file = parseDiff(text).files[0]
        return file ? [[file.path, text] as const] : []
      }),
    )
  }, [open, diff, tooLarge])
  const file = diff?.files.find((entry) => entry.path === selected) ?? diff?.files[0]
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <Dialog.Content size="lg">
        <header className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-3">
          <div className="min-w-0 flex-1">
            <Dialog.Title className="truncate text-sm">
              {title} · Version {version}
            </Dialog.Title>
            <Dialog.Description className="break-all font-mono text-2xs">
              {diff
                ? `${diff.baseCommit.slice(0, 12)} → ${diff.currentSnapshotCommit.slice(0, 12)} · ${diff.totals.files} files`
                : 'Review result changes'}
            </Dialog.Description>
          </div>
          <Dialog.Close className={resultButton}>Close review</Dialog.Close>
        </header>
        {busy && !diff ? (
          <p role="status" className="p-4 text-xs text-fg-muted">
            Loading changes…
          </p>
        ) : null}
        {error && !diff ? (
          <div className="p-4 text-xs">
            <ResultError message={error} />
            <button type="button" disabled={busy} onClick={onRetry} className={resultButton}>
              Retry changes
            </button>
          </div>
        ) : null}
        {tooLarge ? (
          <p role="status" className="p-4 text-xs text-fg-muted">
            This result is too large to preview here. Its changes have not been displayed.
          </p>
        ) : file ? (
          <>
            <div className="shrink-0 border-b border-border px-4 py-2">
              <select
                aria-label="Result changed file"
                value={file.path}
                onChange={(event) => setSelected(event.target.value)}
                className="w-full min-w-0 rounded-md border border-border bg-surface-1 px-2 py-1 font-mono text-xs text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
              >
                {diff?.files.map((entry) => (
                  <option key={entry.path} value={entry.path}>
                    {entry.path}
                    {entry.binary ? ' (binary)' : ` (+${entry.additions} −${entry.deletions})`}
                  </option>
                ))}
              </select>
            </div>
            <div className="min-h-0 flex-1">
              {file.binary ? (
                <p className="p-4 text-xs text-fg-muted">Binary file changed. No text preview.</p>
              ) : patches.has(file.path) ? (
                <DiffSurface
                  key={`${diff?.currentSnapshotCommit}:${file.path}`}
                  diffText={patches.get(file.path)!}
                  path={file.path}
                  comparisonId={`${diff?.baseCommit}:${diff?.currentSnapshotCommit}`}
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
        ) : diff ? (
          <p className="p-4 text-xs text-fg-muted">No changed files in this snapshot.</p>
        ) : null}
      </Dialog.Content>
    </Dialog>
  )
}
