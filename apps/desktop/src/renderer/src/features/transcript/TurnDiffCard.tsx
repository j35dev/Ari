import { useMemo, useState } from 'react'
import { ChevronRight, FileDiff } from 'lucide-react'
import { DiffViewer, parseDiff } from '../diffs'
import type { DiffComment } from '../diffs'

/**
 * Collapsed-by-default card for one settled turn's git changes. The header
 * summarizes the diff (files, +/− counts) via the shared parser; expanding
 * renders the shared unified diff viewer (M8.6). With `onComment` present the
 * viewer accepts inline line notes that flow back to the composer (M21.1).
 */
export function TurnDiffCard({
  turnId,
  diffText,
  onComment,
}: {
  turnId: string
  diffText: string
  onComment?: (comment: DiffComment) => void
}) {
  const [open, setOpen] = useState(false)
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

  return (
    <div className="my-2" data-turn-diff={turnId}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={`Turn diff: ${stats.fileCount} file${stats.fileCount === 1 ? '' : 's'} changed`}
        className="flex w-full items-center gap-1.5 rounded-md border border-border bg-surface-1 px-2 py-1.5 text-left transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
      >
        <ChevronRight
          size={12}
          aria-hidden="true"
          className={`shrink-0 text-fg-subtle transition-transform duration-[180ms] ${open ? 'rotate-90' : ''}`}
        />
        <FileDiff size={12} aria-hidden="true" className="shrink-0 text-fg-subtle" />
        <span className="min-w-0 flex-1 truncate text-xs text-fg-muted">
          Edited {stats.fileCount} file{stats.fileCount === 1 ? '' : 's'}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1 font-mono text-2xs">
          {stats.added > 0 ? <span className="text-success">+{stats.added}</span> : null}
          {stats.removed > 0 ? <span className="text-danger">−{stats.removed}</span> : null}
        </span>
      </button>
      {/* Height tween via grid-template-rows 0fr↔1fr; matches the diff viewer's cards. */}
      <div
        className={`grid transition-[grid-template-rows] duration-[180ms] ease-out ${
          open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
        }`}
      >
        <div className="overflow-hidden">
          {open ? (
            <div className="pt-2">
              <DiffViewer diffText={diffText} onLineComment={onComment} />
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}
