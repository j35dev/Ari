import { useMemo, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { Badge } from '@ari/ui/badge'
import { parseDiff } from './parseDiff'
import type { DiffFile, DiffHunk, DiffLine, DiffLineType } from './parseDiff'

export interface DiffViewerProps {
  /** Raw unified diff text (e.g. `git diff` output) to render. */
  diffText: string
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

function HunkRow({ line }: { line: DiffLine }) {
  return (
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
  )
}

function HunkBlock({ hunk }: { hunk: DiffHunk }) {
  return (
    <div className="border-t border-border/50 first:border-t-0">
      <div className="select-none bg-surface-2 px-2 font-mono text-2xs leading-5 text-fg-subtle">
        {hunk.header}
      </div>
      {hunk.lines.map((line, i) => (
        <HunkRow key={i} line={line} />
      ))}
    </div>
  )
}

function FileCard({ file }: { file: DiffFile }) {
  const [open, setOpen] = useState(true)
  const added = additions(file)
  const removed = deletions(file)

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
            <HunkBlock key={i} hunk={hunk} />
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
export function DiffViewer({ diffText }: DiffViewerProps) {
  const { files } = useMemo(() => parseDiff(diffText), [diffText])

  if (files.length === 0) {
    return <div className="p-3 text-xs text-fg-subtle">No changes</div>
  }

  return (
    <div className="flex flex-col gap-2">
      {files.map((file, i) => (
        <FileCard key={`${file.path}#${i}`} file={file} />
      ))}
    </div>
  )
}
