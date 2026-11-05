import { useMemo, useState } from 'react'
import { ChevronRight, FileDiff } from 'lucide-react'
import { DiffViewer, parseDiff } from '../diffs'
import type { DiffComment } from '../diffs'

type UndoState = 'idle' | 'confirming' | 'pending' | 'done'

/**
 * Collapsed-by-default row for one settled turn's git changes: file count and
 * line totals, expanding to the shared diff viewer (with line notes when
 * `onComment` is set). A quiet Undo restores the workspace to the checkpoint
 * taken when the turn began, after an inline confirm.
 */
export function TurnDiffCard({
  turnId,
  diffText,
  error,
  onRetry,
  onComment,
  onUndo,
  undoDisabled = false,
}: {
  turnId: string
  diffText: string
  error?: string
  onRetry?: () => void
  onComment?: (comment: DiffComment) => void
  /** Resolves false when the revert failed and the files are untouched. */
  onUndo?: () => Promise<boolean>
  undoDisabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [undo, setUndo] = useState<UndoState>('idle')
  const stats = useMemo(() => {
    const { files } = parseDiff(diffText)
    let added = 0
    let removed = 0
    for (const file of files) {
      for (const hunk of file.hunks) {
        for (const line of hunk.lines) {
          if (line.type === 'add') added += 1
          else if (line.type === 'del') removed += 1
        }
      }
    }
    return { fileCount: files.length, added, removed }
  }, [diffText])

  if (error !== undefined && error.length > 0) {
    return (
      <div
        className="my-2 flex items-center gap-2 rounded-md border border-border bg-surface-1 px-2 py-1.5"
        data-turn-diff={turnId}
        role="status"
      >
        <FileDiff size={12} aria-hidden="true" className="shrink-0 text-fg-subtle" />
        <span className="min-w-0 flex-1 truncate text-xs text-danger">{error}</span>
        {onRetry !== undefined ? (
          <button
            type="button"
            onClick={onRetry}
            className="shrink-0 text-2xs text-fg-muted underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
          >
            Retry turn diff
          </button>
        ) : null}
      </div>
    )
  }

  const noun = `file${stats.fileCount === 1 ? '' : 's'}`
  const link =
    'shrink-0 rounded px-1 text-2xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring disabled:pointer-events-none disabled:opacity-50'

  const confirmUndo = (): void => {
    if (onUndo === undefined) return
    setUndo('pending')
    void onUndo().then((ok) => setUndo(ok ? 'done' : 'idle'))
  }

  return (
    <div className="my-2" data-turn-diff={turnId}>
      <div className="group flex items-center gap-1 rounded-md border border-border bg-surface-1 pr-1.5 transition-colors hover:bg-surface-2">
        {undo === 'confirming' || undo === 'pending' ? (
          <>
            <span className="min-w-0 flex-1 truncate px-2 py-1.5 text-xs text-fg">
              Restore these files to before this turn? Later changes go too.
            </span>
            <button
              type="button"
              onClick={() => setUndo('idle')}
              disabled={undo === 'pending'}
              className={`${link} text-fg-muted hover:text-fg`}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={confirmUndo}
              disabled={undo === 'pending'}
              aria-label="Confirm undo"
              className={`${link} font-medium text-danger hover:text-danger/80`}
            >
              {undo === 'pending' ? 'Undoing…' : 'Undo'}
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={() => setOpen((o) => !o)}
              aria-expanded={open}
              aria-label={`Turn diff: ${stats.fileCount} ${noun} changed`}
              className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 py-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-ring"
            >
              <ChevronRight
                size={12}
                aria-hidden="true"
                className={`shrink-0 text-fg-subtle transition-transform duration-[180ms] ${open ? 'rotate-90' : ''}`}
              />
              <FileDiff size={12} aria-hidden="true" className="shrink-0 text-fg-subtle" />
              <span className="min-w-0 flex-1 truncate text-xs text-fg-muted">
                {undo === 'done' ? 'Undid changes to' : 'Edited'} {stats.fileCount} {noun}
              </span>
              <span className="ml-auto flex shrink-0 items-center gap-1 text-2xs tabular-nums">
                {stats.added > 0 ? <span className="text-success">+{stats.added}</span> : null}
                {stats.removed > 0 ? <span className="text-danger">−{stats.removed}</span> : null}
              </span>
            </button>
            {onUndo !== undefined && undo !== 'done' ? (
              <button
                type="button"
                onClick={() => setUndo('confirming')}
                disabled={undoDisabled}
                title={
                  undoDisabled
                    ? 'Available once the turn finishes'
                    : 'Undo this turn’s file changes'
                }
                className={`${link} text-fg-subtle opacity-0 hover:text-fg focus-visible:opacity-100 group-hover:opacity-100`}
              >
                Undo
              </button>
            ) : null}
          </>
        )}
      </div>
      {/* Height tween via grid-template-rows 0fr↔1fr; matches the diff viewer's cards. */}
      <div
        className={`grid transition-[grid-template-rows] duration-[180ms] ease-out ${
          open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
        }`}
      >
        <div className="overflow-hidden">
          {open ? (
            <div className="ari-enter-rise pt-2">
              <DiffViewer diffText={diffText} onLineComment={onComment} />
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}
