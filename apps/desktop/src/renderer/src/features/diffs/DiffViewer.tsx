import { useMemo, useState } from 'react'
import { ChevronRight, MessageSquarePlus, X } from 'lucide-react'
import { iconButton, primaryButton } from '../../lib/recipes'
import { parseDiff } from './parseDiff'
import type { DiffFile, DiffHunk, DiffLine, DiffLineType } from './parseDiff'

export interface DiffViewerProps {
  /** Raw unified diff text (e.g. `git diff` output) to render. */
  diffText: string
  /**
   * Conductor-style review loop: called when the user saves an inline comment
   * on a diff line. Absent = commenting UI hidden (read-only contexts).
   */
  onLineComment?: (comment: { path: string; line: number | null; text: string }) => void
}

/** One saved line note threaded up to the session's composer. */
export interface DiffComment {
  path: string
  /** New-file line number when known, else null (deleted/context lines). */
  line: number | null
  text: string
}

/** Changed lines carry the diff tint and full ink; context stays muted. */
const ROW_TONE: Record<DiffLineType, string> = {
  context: 'text-fg-muted',
  add: 'bg-success-subtle text-fg',
  del: 'bg-danger-subtle text-fg',
}

const GUTTER_CLASS =
  'w-10 select-none px-1 text-right font-mono text-[11px] leading-5 text-fg-subtle'

function additions(file: DiffFile): number {
  return file.hunks.reduce(
    (sum, hunk) => sum + hunk.lines.filter((line) => line.type === 'add').length,
    0,
  )
}

function deletions(file: DiffFile): number {
  return file.hunks.reduce(
    (sum, hunk) => sum + hunk.lines.filter((line) => line.type === 'del').length,
    0,
  )
}

function HunkRow({
  line,
  path,
  onComment,
}: {
  line: DiffLine
  path?: string
  onComment?: (c: DiffComment) => void
}) {
  const [commenting, setCommenting] = useState(false)
  const [draft, setDraft] = useState('')

  const save = (): void => {
    const text = draft.trim()
    if (text.length > 0 && path !== undefined && onComment !== undefined) {
      onComment({ path, line: line.newLineNo ?? null, text })
    }
    setDraft('')
    setCommenting(false)
  }

  return (
    <div className="group/line relative">
      <div
        data-line-type={line.type}
        className={`grid grid-cols-[2.5rem_2.5rem_minmax(0,1fr)] ${ROW_TONE[line.type]}`}
      >
        <span className={GUTTER_CLASS}>{line.oldLineNo ?? ''}</span>
        <span className={GUTTER_CLASS}>{line.newLineNo ?? ''}</span>
        <pre className="min-w-0 whitespace-pre-wrap break-all px-2 font-mono leading-5">
          {line.content}
        </pre>
      </div>
      {path !== undefined && onComment !== undefined && !commenting ? (
        <button
          type="button"
          aria-label={`Comment on ${path}:${line.newLineNo ?? line.oldLineNo ?? ''}`}
          title="Add a review note"
          onClick={() => setCommenting(true)}
          className="absolute right-1 top-0 flex size-5 items-center justify-center rounded-sm bg-surface-1 text-fg-subtle opacity-0 transition-[color,opacity] hover:text-fg focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring group-hover/line:opacity-100"
        >
          <MessageSquarePlus size={12} />
        </button>
      ) : null}
      {commenting ? (
        <div className="border-y border-border px-3 py-2">
          <textarea
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault()
                save()
              }
              if (e.key === 'Escape') {
                setDraft('')
                setCommenting(false)
              }
            }}
            rows={2}
            aria-label={`Review note for ${path ?? 'line'}`}
            placeholder="Review note — sent with your next message (Mod+Enter to save)"
            className="w-full resize-none rounded-md border border-border-strong bg-surface-1 px-2.5 py-1.5 text-[13px] text-fg placeholder:text-fg-subtle focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
          />
          <div className="mt-1.5 flex items-center justify-end gap-1">
            <button
              type="button"
              onClick={save}
              disabled={draft.trim().length === 0}
              className={primaryButton}
            >
              Save note
            </button>
            <button
              type="button"
              aria-label="Cancel note"
              onClick={() => {
                setDraft('')
                setCommenting(false)
              }}
              className={iconButton}
            >
              <X size={14} />
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

function HunkBlock({
  hunk,
  path,
  onComment,
}: {
  hunk: DiffHunk
  path?: string
  onComment?: (c: DiffComment) => void
}) {
  return (
    <div className="border-t border-border">
      <div className="select-none px-3 font-mono text-[11px] leading-6 text-fg-subtle">
        {hunk.header}
      </div>
      {hunk.lines.map((line, i) => (
        <HunkRow key={i} line={line} path={path} onComment={onComment} />
      ))}
    </div>
  )
}

function FileSection({
  file,
  onComment,
}: {
  file: DiffFile
  onComment?: (c: DiffComment) => void
}) {
  const [open, setOpen] = useState(true)
  const added = additions(file)
  const removed = deletions(file)
  const commentable = !file.isBinary && onComment !== undefined

  return (
    <section data-file-path={file.path} className="border-t border-border first:border-t-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={`Toggle ${file.path}`}
        className="flex h-7 w-full items-center gap-2 px-3 text-left font-mono text-xs text-fg-muted transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-ring"
      >
        <ChevronRight
          size={12}
          aria-hidden="true"
          className={`shrink-0 text-fg-subtle transition-transform duration-[180ms] ${open ? 'rotate-90' : ''}`}
        />
        <span className="truncate">{file.path}</span>
        <span className="ml-auto flex shrink-0 items-center gap-2 tabular-nums">
          {file.isBinary ? <span className="text-fg-subtle">Binary</span> : null}
          {added > 0 ? <span className="text-success">+{added}</span> : null}
          {removed > 0 ? <span className="text-danger">-{removed}</span> : null}
        </span>
      </button>
      {/* Height tween via grid-template-rows 0fr↔1fr; no measurement needed. */}
      <div
        className={`grid transition-[grid-template-rows] duration-[180ms] ease-out ${
          open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
        }`}
      >
        <div className="overflow-hidden">
          {file.hunks.map((hunk, i) => (
            <HunkBlock
              key={i}
              hunk={hunk}
              path={commentable ? file.path : undefined}
              onComment={commentable ? onComment : undefined}
            />
          ))}
        </div>
      </div>
    </section>
  )
}

/**
 * Renders a unified diff as collapsible per-file sections with old/new line
 * number gutters and success/danger tinted add/del rows. It draws no box of
 * its own: the caller sets it in a well (a tool step's detail, a turn's
 * changes), so the line tints run edge to edge. A plain map is fine below ~2k
 * changed lines; swap the body for a virtualized list later.
 */
export function DiffViewer({ diffText, onLineComment }: DiffViewerProps) {
  const { files } = useMemo(() => parseDiff(diffText), [diffText])

  if (files.length === 0) {
    return <div className="px-3 py-2 text-xs text-fg-subtle">No changes</div>
  }

  return (
    <div className="flex flex-col text-[length:var(--ari-well-text,12.5px)]">
      {files.map((file, i) => (
        <FileSection key={`${file.path}#${i}`} file={file} onComment={onLineComment} />
      ))}
    </div>
  )
}
