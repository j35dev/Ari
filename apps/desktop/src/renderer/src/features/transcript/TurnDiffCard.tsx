import { useMemo, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import type { GitTurnDiffSummary } from '@ari/contracts/rpc'
import { chip } from '../../lib/recipes'
import { DiffViewer, parseDiff } from '../diffs'
import type { DiffComment } from '../diffs'
import { TurnDiffFiles } from './TurnDiffFiles'

type UndoState = 'idle' | 'confirming' | 'pending' | 'done'

interface FileStat {
  path: string
  added: number
  removed: number
  binary: boolean
}

/** Files named as chips before the rest fold into a count. */
const MAX_CHIPS = 4

/** A quiet text action at the end of the row; each use adds its own colour. */
const TEXT_ACTION =
  'inline-flex h-7 shrink-0 items-center rounded-md px-2 text-[13px] transition-colors hover:bg-fg/6 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring disabled:pointer-events-none disabled:opacity-50'

function fileName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

/**
 * The quiet row a turn that changed files ends on: how many it edited, then
 * each file as a chip with its own `+n −n`, read from the patch or a large
 * turn's metadata. The row opens the diff; large turns load one file at a
 * time. With `onComment` present the viewer accepts inline line notes that
 * flow back to the composer. Undo sits at the end of the row and restores the
 * workspace to the checkpoint taken when the turn began, after confirmation.
 */
export function TurnDiffCard({
  turnId,
  diffText,
  summary,
  sessionId,
  error,
  onRetry,
  onComment,
  onUndo,
  undoDisabled = false,
}: {
  turnId: string
  diffText: string
  summary?: GitTurnDiffSummary
  sessionId?: string
  error?: string
  onRetry?: () => void
  onComment?: (comment: DiffComment) => void
  /** Resolves false when the revert failed and the files are untouched. */
  onUndo?: () => Promise<boolean>
  undoDisabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [undo, setUndo] = useState<UndoState>('idle')
  const files = useMemo<FileStat[]>(() => {
    if (summary) {
      return summary.files.map((file) => ({
        path: file.path,
        added: file.additions,
        removed: file.deletions,
        binary: file.binary,
      }))
    }
    return parseDiff(diffText).files.map((file) => {
      let added = 0
      let removed = 0
      for (const hunk of file.hunks) {
        for (const line of hunk.lines) {
          if (line.type === 'add') added += 1
          else if (line.type === 'del') removed += 1
        }
      }
      return { path: file.path, added, removed, binary: file.isBinary === true }
    })
  }, [diffText, summary])

  if (error !== undefined && error.length > 0) {
    return (
      <div
        className="my-1 flex min-h-7 items-center gap-2 text-[13px]"
        data-turn-diff={turnId}
        role="status"
      >
        <span className="ari-status" data-status="error" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-fg">{error}</span>
        {onRetry !== undefined ? (
          <button
            type="button"
            onClick={onRetry}
            className={`${TEXT_ACTION} text-fg-muted hover:text-fg`}
          >
            Retry turn diff
          </button>
        ) : null}
      </div>
    )
  }

  const fileCount = files.length
  const noun = `file${fileCount === 1 ? '' : 's'}`
  const shown = files.slice(0, MAX_CHIPS)
  const hidden = fileCount - shown.length

  const confirmUndo = (): void => {
    if (onUndo === undefined) return
    setUndo('pending')
    void onUndo().then((ok) => setUndo(ok ? 'done' : 'idle'))
  }

  return (
    <div className="my-1" data-turn-diff={turnId}>
      <div className="group flex min-h-7 flex-wrap items-center gap-x-2 gap-y-1.5 text-[13px] text-fg-subtle">
        {undo === 'confirming' || undo === 'pending' ? (
          <>
            <span className="min-w-0 flex-1 truncate text-fg">
              Restore these files to before this turn? Later changes go too.
            </span>
            <button
              type="button"
              onClick={() => setUndo('idle')}
              disabled={undo === 'pending'}
              className={`${TEXT_ACTION} text-fg-muted hover:text-fg`}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={confirmUndo}
              disabled={undo === 'pending'}
              aria-label="Confirm undo"
              className={`${TEXT_ACTION} font-medium text-danger`}
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
              aria-label={`Turn diff: ${fileCount} ${noun} changed`}
              className="flex h-7 shrink-0 items-center gap-1.5 rounded-md text-left transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
            >
              <span>
                {undo === 'done' ? 'Undid changes to' : 'Edited'} {fileCount} {noun}
              </span>
              <ChevronRight
                size={14}
                aria-hidden="true"
                className={`shrink-0 transition-transform duration-[180ms] motion-reduce:transition-none ${open ? 'rotate-90' : ''}`}
              />
            </button>
            {shown.map((file) => (
              <span key={file.path} title={file.path} className={`${chip} min-w-0 max-w-full`}>
                <span className="min-w-0 truncate">{fileName(file.path)}</span>
                {file.binary ? <span className="text-fg-subtle">Binary</span> : null}
                {file.added > 0 ? <span className="text-success">+{file.added}</span> : null}
                {file.removed > 0 ? <span className="text-danger">−{file.removed}</span> : null}
              </span>
            ))}
            {hidden > 0 ? <span className="shrink-0 text-xs">+{hidden} more</span> : null}
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
                className={`${TEXT_ACTION} ml-auto text-fg-subtle opacity-0 hover:text-fg focus-visible:opacity-100 group-hover:opacity-100`}
              >
                Undo
              </button>
            ) : null}
          </>
        )}
      </div>
      {/* Height tween via grid-template-rows 0fr↔1fr; matches the diff viewer's sections. */}
      <div
        className={`grid transition-[grid-template-rows] duration-[180ms] ease-out ${
          open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
        }`}
      >
        <div className="overflow-hidden">
          {summary && sessionId ? (
            <TurnDiffFiles
              active={open}
              sessionId={sessionId}
              summary={summary}
              onComment={onComment}
            />
          ) : open ? (
            <div className="ari-enter-rise pb-1 pt-1.5">
              <div className="overflow-hidden rounded-lg border border-border bg-surface-0">
                <DiffViewer diffText={diffText} onLineComment={onComment} />
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}
