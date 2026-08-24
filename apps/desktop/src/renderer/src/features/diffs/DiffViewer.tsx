import { useMemo, useState } from 'react'
import { ChevronRight, MessageSquarePlus, X } from 'lucide-react'
import { Badge } from '@ari/ui/badge'
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

const ROW_BG: Record<DiffLineType, string> = {
  context: '',
  add: 'bg-success-subtle',
  del: 'bg-danger-subtle',
}

const GUTTER_CLASS =
  'w-10 select-none border-r border-border/50 px-1 text-right font-mono text-2xs leading-5 text-fg-subtle'

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

function HunkRow({ line, path, onComment }: { line: DiffLine; path?: string; onComment?: (c: DiffComment) => void }) {
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
        className={`grid grid-cols-[2.5rem_2.5rem_minmax(0,1fr)] ${ROW_BG[line.type]}`}
      >
        <span className={GUTTER_CLASS}>{line.oldLineNo ?? ''}</span>
        <span className={GUTTER_CLASS}>{line.newLineNo ?? ''}</span>
        <pre className="min-w-0 px-2 font-mono text-xs leading-5 whitespace-pre-wrap break-all text-fg">
          {line.content}
        </pre>
      </div>
      {path !== undefined && onComment !== undefined && !commenting ? (
        <button
          type="button"
          aria-label={`Comment on ${path}:${line.newLineNo ?? line.oldLineNo ?? ''}`}
          title="Add a review note"
          onClick={() => setCommenting(true)}
          className="absolute right-1 top-0 flex h-5 w-5 items-center justify-center rounded-sm bg-surface-1 text-fg-subtle opacity-0 shadow-1 transition-opacity hover:text-accent focus-visible:opacity-100 focus-visible:outline-none group-hover/line:opacity-100"
        >
          <MessageSquarePlus size={11} />
        </button>
      ) : null}
      {commenting ? (
        <div className="border-t border-border/50 bg-surface-2 px-8 py-2">
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
            className="w-full resize-none rounded-sm border border-border bg-glass-input px-2 py-1 font-mono text-xs text-fg placeholder:text-fg-subtle focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
          />
          <div className="mt-1 flex items-center justify-end gap-1">
            <button
              type="button"
              onClick={save}
              disabled={draft.trim().length === 0}
              className="rounded-sm bg-accent px-2 py-0.5 text-2xs font-medium text-fg-on-accent transition-colors hover:bg-accent-hover disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
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
              className="flex h-5 w-5 items-center justify-center rounded-sm text-fg-subtle hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
            >
              <X size={11} />
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

function HunkBlock({ hunk, path, onComment }: { hunk: DiffHunk; path?: string; onComment?: (c: DiffComment) => void }) {
  return (
    <div className="border-t border-border/50 first:border-t-0">
      <div className="select-none bg-surface-2 px-2 font-mono text-2xs leading-5 text-fg-subtle">
        {hunk.header}
      </div>
      {hunk.lines.map((line, i) => (
        <HunkRow key={i} line={line} path={path} onComment={onComment} />
      ))}
    </div>
  )
}

function FileCard({ file, onComment }: { file: DiffFile; onComment?: (c: DiffComment) => void }) {
  const [open, setOpen] = useState(true)
  const added = additions(file)
  const removed = deletions(file)
  const commentable = !file.isBinary && onComment !== undefined

  return (
    <section data-file-path={file.path} className="overflow-hidden rounded-md border border-border bg-surface-1">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={`Toggle ${file.path}`}
        className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
      >
        <ChevronRight
          size={12}
          aria-hidden="true"
          className={`shrink-0 text-fg-subtle transition-transform duration-[180ms] ${open ? 'rotate-90' : ''}`}
        />
        <span className="truncate font-mono text-xs text-fg">{file.path}</span>
        <span className="ml-auto flex shrink-0 items-center gap-1">
          {file.isBinary ? <Badge tone="neutral" size="sm">binary</Badge> : null}
          {added > 0 ? (
            <Badge tone="success" size="sm">
              +{added}
            </Badge>
          ) : null}
          {removed > 0 ? (
            <Badge tone="danger" size="sm">
              -{removed}
            </Badge>
          ) : null}
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
 * Renders a unified diff as collapsible per-file cards with old/new line
 * number gutters and success/danger tinted add/del rows. A plain map is fine
 * below ~2k changed lines; swap the body for a virtualized list later.
 */
export function DiffViewer({ diffText, onLineComment }: DiffViewerProps) {
  const { files } = useMemo(() => parseDiff(diffText), [diffText])

  if (files.length === 0) {
    return <div className="p-3 text-xs text-fg-subtle">No changes</div>
  }

  return (
    <div className="flex flex-col gap-2">
      {files.map((file, i) => (
        <FileCard key={`${file.path}#${i}`} file={file} onComment={onLineComment} />
      ))}
    </div>
  )
}
