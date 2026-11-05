import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, FileDiff, RotateCcw } from 'lucide-react'
import { DiffViewer, parseDiff } from '../diffs'
import type { DiffComment } from '../diffs'

/** Files listed before the rest fold behind "Show N more files". */
const PREVIEW_FILES = 3

interface FileStat {
  path: string
  added: number
  removed: number
}

type UndoState = 'idle' | 'confirming' | 'pending' | 'done'

function splitPath(path: string): { dir: string; name: string } {
  const at = path.lastIndexOf('/')
  return at < 0 ? { dir: '', name: path } : { dir: path.slice(0, at + 1), name: path.slice(at + 1) }
}

function Stat({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="flex shrink-0 items-center gap-1.5 text-xs tabular-nums">
      {added > 0 ? <span className="text-success">+{added.toLocaleString()}</span> : null}
      {removed > 0 ? <span className="text-danger">−{removed.toLocaleString()}</span> : null}
    </span>
  )
}

/**
 * Summary card for one settled turn's file changes: how many files, the line
 * totals, and the first few files with their own counts. Review opens the
 * full diff inline (with line notes when `onComment` is set); Undo restores
 * the workspace to the checkpoint taken when the turn began.
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
  const [showAll, setShowAll] = useState(false)
  const [undo, setUndo] = useState<UndoState>('idle')
  const [focusPath, setFocusPath] = useState<string | null>(null)
  const reviewRef = useRef<HTMLDivElement>(null)

  const stats = useMemo(() => {
    const files: FileStat[] = parseDiff(diffText).files.map((file) => {
      let added = 0
      let removed = 0
      for (const hunk of file.hunks) {
        for (const line of hunk.lines) {
          if (line.type === 'add') added += 1
          else if (line.type === 'del') removed += 1
        }
      }
      return { path: file.path, added, removed }
    })
    return {
      files,
      added: files.reduce((sum, f) => sum + f.added, 0),
      removed: files.reduce((sum, f) => sum + f.removed, 0),
    }
  }, [diffText])

  // Once the review is open, bring the file the reader picked into view.
  useEffect(() => {
    if (!open || focusPath === null) return
    const target = reviewRef.current?.querySelector(`[data-file-path="${CSS.escape(focusPath)}"]`)
    target?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' })
  }, [open, focusPath])

  if (error !== undefined && error.length > 0) {
    return (
      <div
        className="my-2 flex items-center gap-2 rounded-xl border border-border bg-surface-1 px-3 py-2"
        data-turn-diff={turnId}
        role="status"
      >
        <FileDiff size={13} aria-hidden="true" className="shrink-0 text-fg-subtle" />
        <span className="min-w-0 flex-1 truncate text-xs text-danger">{error}</span>
        {onRetry !== undefined ? (
          <button
            type="button"
            onClick={onRetry}
            className="shrink-0 text-xs text-fg-muted underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
          >
            Retry turn diff
          </button>
        ) : null}
      </div>
    )
  }

  const count = stats.files.length
  const noun = `file${count === 1 ? '' : 's'}`
  const listed = showAll ? stats.files : stats.files.slice(0, PREVIEW_FILES)
  const hidden = count - listed.length

  const confirmUndo = (): void => {
    if (onUndo === undefined) return
    setUndo('pending')
    void onUndo().then((ok) => setUndo(ok ? 'done' : 'idle'))
  }

  const openFile = (path: string): void => {
    setFocusPath(path)
    setOpen(true)
  }

  const action =
    'flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring disabled:pointer-events-none disabled:opacity-50'

  return (
    <div
      className="ari-turn-card my-3 overflow-hidden rounded-xl border border-border bg-surface-1"
      data-turn-diff={turnId}
    >
      <div className="flex items-center gap-3 px-3 py-2.5">
        <span
          aria-hidden="true"
          className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border bg-surface-2 text-fg-muted"
        >
          <FileDiff size={15} strokeWidth={1.8} />
        </span>
        <div className="min-w-0 flex-1">
          {undo === 'confirming' ? (
            <p className="text-sm text-fg">
              Restore these files to before this turn?
              <span className="block text-xs text-fg-muted">Changes made after it are undone too.</span>
            </p>
          ) : (
            <>
              <p className="text-sm font-medium text-fg">
                {undo === 'done' ? `Undid changes to ${count} ${noun}` : `Edited ${count} ${noun}`}
              </p>
              <Stat added={stats.added} removed={stats.removed} />
            </>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {undo === 'confirming' || undo === 'pending' ? (
            <>
              <button
                type="button"
                onClick={() => setUndo('idle')}
                disabled={undo === 'pending'}
                className={`${action} text-fg-muted hover:bg-surface-2 hover:text-fg`}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmUndo}
                disabled={undo === 'pending'}
                aria-label="Confirm undo"
                className={`${action} bg-danger/15 text-danger hover:bg-danger/25`}
              >
                {undo === 'pending' ? 'Undoing…' : 'Undo changes'}
              </button>
            </>
          ) : (
            <>
              {onUndo !== undefined && undo !== 'done' ? (
                <button
                  type="button"
                  onClick={() => setUndo('confirming')}
                  disabled={undoDisabled}
                  title={undoDisabled ? 'Available once the turn finishes' : undefined}
                  className={`${action} text-fg-muted hover:bg-surface-2 hover:text-fg`}
                >
                  Undo
                  <RotateCcw size={12} aria-hidden="true" />
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => setOpen((o) => !o)}
                aria-expanded={open}
                aria-label={`Turn diff: ${count} ${noun} changed`}
                className={`${action} border border-border bg-surface-2/60 text-fg hover:bg-surface-2`}
              >
                {open ? 'Hide changes' : 'Review'}
              </button>
            </>
          )}
        </div>
      </div>

      {count > 0 ? (
        <ul className="border-t border-border/70">
          {listed.map((file) => {
            const { dir, name } = splitPath(file.path)
            return (
              <li key={file.path}>
                <button
                  type="button"
                  onClick={() => openFile(file.path)}
                  title={file.path}
                  className="flex w-full items-center gap-3 px-3 py-1.5 text-left transition-colors hover:bg-surface-2/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-ring"
                >
                  <span className="min-w-0 flex-1 truncate text-[13px]">
                    <span className="text-fg-subtle">{dir}</span>
                    <span className="text-fg">{name}</span>
                  </span>
                  <Stat added={file.added} removed={file.removed} />
                </button>
              </li>
            )
          })}
          {hidden > 0 || showAll ? (
            <li>
              <button
                type="button"
                onClick={() => setShowAll((s) => !s)}
                className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-xs text-fg-muted transition-colors hover:bg-surface-2/60 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-ring"
              >
                {showAll ? 'Show fewer' : `Show ${hidden} more ${hidden === 1 ? 'file' : 'files'}`}
                <ChevronDown
                  size={12}
                  aria-hidden="true"
                  className={`transition-transform duration-150 ${showAll ? 'rotate-180' : ''}`}
                />
              </button>
            </li>
          ) : null}
        </ul>
      ) : null}

      {/* Height tween via grid-template-rows 0fr↔1fr; matches the diff viewer's cards. */}
      <div
        className={`grid transition-[grid-template-rows] duration-[180ms] ease-out ${
          open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
        }`}
      >
        <div className="overflow-hidden">
          {open ? (
            <div ref={reviewRef} className="ari-enter-rise border-t border-border/70 p-2">
              <DiffViewer diffText={diffText} onLineComment={onComment} />
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}
