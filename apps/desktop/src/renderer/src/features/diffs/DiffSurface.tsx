import { useEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ArrowDown, ArrowUp, Columns2, Rows3, TextWrap } from 'lucide-react'
import type { GitReviewNote } from '@ari/contracts/rpc'
import type { DiffLine } from './parseDiff'
import { parseDiff } from './parseDiff'
import { reviewRows } from './review-rows'
import { useDiffHighlight } from './use-diff-highlight'

export type DiffRange = Pick<GitReviewNote, 'side' | 'startLine' | 'endLine' | 'context'>
export interface DiffSurfaceProps {
  diffText: string
  path: string
  comparisonId: string
  onRange?: (range: DiffRange) => void
}
const control =
  'flex size-7 items-center justify-center rounded-md text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring disabled:opacity-30'

/** Shared, virtualized split/unified review with bounded syntax, search and side-aware ranges. */
export function DiffSurface({ diffText, path, comparisonId, onRange }: DiffSurfaceProps) {
  const [split, setSplit] = useState(true)
  const [wrap, setWrap] = useState(false)
  const [ignoreWhitespace, setIgnoreWhitespace] = useState(false)
  const [raw, setRaw] = useState(false)
  const [query, setQuery] = useState('')
  const [match, setMatch] = useState(0)
  const [hunk, setHunk] = useState(0)
  const [selection, setSelection] = useState<{
    side: 'old' | 'new'
    start: number
    end: number
  } | null>(null)
  const scroll = useRef<HTMLDivElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const file = useMemo(() => parseDiff(diffText).files[0], [diffText])
  const rows = useMemo(
    () => (file ? reviewRows(file, split, ignoreWhitespace) : []),
    [file, split, ignoreWhitespace],
  )
  const highlights = useDiffHighlight(rows, path)
  const virtual = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroll.current,
    estimateSize: () => 24,
    overscan: 12,
  })
  const matches = useMemo(
    () =>
      query
        ? rows.flatMap((row, index) =>
            `${row.old?.content ?? ''}\n${row.next?.content ?? ''}`
              .toLowerCase()
              .includes(query.toLowerCase())
              ? [index]
              : [],
          )
        : [],
    [query, rows],
  )
  const hunks = useMemo(() => rows.flatMap((row, index) => (row.header ? [index] : [])), [rows])
  const currentMatch = Math.min(match, Math.max(0, matches.length - 1))
  useEffect(() => {
    setSelection(null)
    setMatch(0)
    setHunk(0)
  }, [comparisonId, path])
  useEffect(() => {
    scroll.current?.scrollTo?.({ top: 0 })
  }, [path])
  useEffect(() => {
    virtual.measure()
  }, [split, wrap, virtual])
  useEffect(() => {
    if (matches[currentMatch] !== undefined)
      virtual.scrollToIndex(matches[currentMatch], { align: 'center' })
  }, [matches, currentMatch, virtual])
  const navigate = (direction: number) =>
    setMatch(matches.length ? (currentMatch + direction + matches.length) % matches.length : 0)
  const select = (side: 'old' | 'new', number: number, extend: boolean) => {
    const range =
      extend && selection?.side === side
        ? { ...selection, end: number }
        : { side, start: number, end: number }
    setSelection(range)
    const startLine = Math.min(range.start, range.end)
    const endLine = Math.max(range.start, range.end)
    const context = rows
      .flatMap((row) => {
        const line = side === 'old' ? row.old : row.next
        const at = side === 'old' ? line?.oldLineNo : line?.newLineNo
        return line && at !== undefined && at >= startLine && at <= endLine ? [line.content] : []
      })
      .join('\n')
      .slice(0, 8000)
    onRange?.({ side, startLine, endLine, context })
  }
  const gutter = (line: DiffLine | undefined, side: 'old' | 'new') => {
    const number = side === 'old' ? line?.oldLineNo : line?.newLineNo
    return (
      <button
        type="button"
        disabled={!onRange || number === undefined}
        aria-label={`Select ${side} line ${number ?? ''}`}
        onClick={(event) => number !== undefined && select(side, number, event.shiftKey)}
        className="w-12 shrink-0 select-none border-r border-border/40 px-2 text-right font-mono text-2xs tabular-nums text-fg-subtle enabled:hover:text-accent focus-visible:outline-none focus-visible:bg-accent-subtle"
      >
        {number}
      </button>
    )
  }
  const cell = (line: DiffLine | undefined, side: 'old' | 'new', index: number) => {
    const selectedNumber = selection?.side === 'old' ? line?.oldLineNo : line?.newLineNo
    const selected =
      selection &&
      (!split || selection.side === side) &&
      selectedNumber !== undefined &&
      selectedNumber >= Math.min(selection.start, selection.end) &&
      selectedNumber <= Math.max(selection.start, selection.end)
    const tint =
      line?.type === 'add' ? 'bg-success-subtle' : line?.type === 'del' ? 'bg-danger-subtle' : ''
    return (
      <div
        className={`flex min-w-0 ${tint} ${selected ? 'ring-1 ring-inset ring-accent/40' : ''}`}
        data-line-type={line?.type}
      >
        {!split ? gutter(line, 'old') : null}
        {gutter(line, split ? side : 'new')}
        <span aria-hidden className="w-5 shrink-0 select-none text-center text-fg-subtle">
          {line?.type === 'add' ? '+' : line?.type === 'del' ? '−' : ''}
        </span>
        <code
          className={`min-w-0 flex-1 pr-4 font-mono text-xs ${wrap ? 'whitespace-pre-wrap break-all' : 'whitespace-pre'}`}
        >
          {line && highlights[`${index}:${side}`] ? (
            <span dangerouslySetInnerHTML={{ __html: highlights[`${index}:${side}`]! }} />
          ) : (
            (line?.content ?? ' ')
          )}
        </code>
      </div>
    )
  }
  return (
    <section
      className="flex h-full min-h-0 flex-col"
      aria-label={`Diff for ${path}`}
      onKeyDown={(event) => {
        if ((event.metaKey || event.ctrlKey) && event.key === 'f') {
          event.preventDefault()
          search.current?.focus()
        }
      }}
    >
      <div className="flex min-h-10 shrink-0 flex-wrap items-center gap-1 border-b border-border/60 bg-surface-0 px-3 py-1">
        <input
          ref={search}
          type="search"
          aria-label="Find in diff"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
            setMatch(0)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              navigate(event.shiftKey ? -1 : 1)
            }
          }}
          placeholder="Find in diff…"
          className="h-7 min-w-20 flex-1 bg-transparent px-1 text-xs text-fg outline-none placeholder:text-fg-subtle focus-visible:ring-1 focus-visible:ring-accent-ring"
        />
        {query ? (
          <span role="status" className="px-2 font-mono text-2xs text-fg-subtle">
            {matches.length ? currentMatch + 1 : 0}/{matches.length}
          </span>
        ) : null}
        <button
          type="button"
          className={control}
          aria-label="Previous match"
          disabled={!matches.length}
          onClick={() => navigate(-1)}
        >
          <ArrowUp size={13} />
        </button>
        <button
          type="button"
          className={control}
          aria-label="Next match"
          disabled={!matches.length}
          onClick={() => navigate(1)}
        >
          <ArrowDown size={13} />
        </button>
        <span className="mx-1 h-4 w-px bg-border" />
        <button
          type="button"
          className={control}
          aria-label="Split diff"
          aria-pressed={split}
          onClick={() => setSplit(true)}
        >
          <Columns2 size={14} />
        </button>
        <button
          type="button"
          className={control}
          aria-label="Unified diff"
          aria-pressed={!split}
          onClick={() => setSplit(false)}
        >
          <Rows3 size={14} />
        </button>
        <button
          type="button"
          className={control}
          aria-label="Wrap lines"
          aria-pressed={wrap}
          onClick={() => setWrap(!wrap)}
        >
          <TextWrap size={14} />
        </button>
        <label className="ml-2 flex items-center gap-1.5 text-2xs text-fg-muted">
          <input
            type="checkbox"
            checked={ignoreWhitespace}
            onChange={(event) => setIgnoreWhitespace(event.target.checked)}
          />
          Ignore whitespace
        </label>
        <button
          type="button"
          className="ml-2 text-2xs text-fg-muted hover:text-fg"
          aria-pressed={raw}
          onClick={() => setRaw(!raw)}
        >
          Raw patch
        </button>
      </div>
      {split && !raw ? (
        <div className="grid grid-cols-2 border-b border-border/60 bg-surface-0 font-mono text-2xs text-fg-subtle">
          <span className="px-4 py-1.5">Before</span>
          <span className="border-l border-border/60 px-4 py-1.5">After</span>
        </div>
      ) : null}
      <div
        ref={scroll}
        className="ari-scroll shiki min-h-0 flex-1 overflow-auto"
        tabIndex={0}
        aria-label="Diff lines"
      >
        {raw ? (
          <pre className="p-4 font-mono text-xs text-fg">{diffText}</pre>
        ) : file?.isBinary ? (
          <p className="p-8 text-sm text-fg-muted">
            Binary content changed. Open the file to inspect it.
          </p>
        ) : rows.length === 0 ? (
          <p className="p-8 text-sm text-fg-subtle">No text changes in this selection.</p>
        ) : (
          <div style={{ height: virtual.getTotalSize(), position: 'relative' }}>
            {virtual.getVirtualItems().map((item) => {
              const row = rows[item.index]!
              return (
                <div
                  key={item.key}
                  data-index={item.index}
                  ref={virtual.measureElement}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${item.start}px)`,
                  }}
                  className={`min-h-6 leading-6 ${query && matches[currentMatch] === item.index ? 'outline outline-1 outline-accent/50' : ''}`}
                >
                  {row.header ? (
                    <div className="bg-surface-2/60 px-4 font-mono text-2xs text-fg-subtle">
                      {row.header}
                    </div>
                  ) : split ? (
                    <div className="grid grid-cols-2 [&>div+div]:border-l [&>div+div]:border-border/60">
                      {cell(row.old, 'old', item.index)}
                      {cell(row.next, 'new', item.index)}
                    </div>
                  ) : (
                    cell(row.next ?? row.old, row.next ? 'new' : 'old', item.index)
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
      <footer className="flex h-8 shrink-0 items-center gap-2 border-t border-border/60 px-3 text-2xs text-fg-subtle">
        <span>
          {hunks.length} hunks{ignoreWhitespace ? ' · whitespace filtered' : ''}
        </span>
        <div className="flex-1" />
        <button
          type="button"
          className={control}
          aria-label="Previous hunk"
          disabled={raw || !hunks.length || hunk === 0}
          onClick={() => {
            const next = Math.max(0, hunk - 1)
            setHunk(next)
            virtual.scrollToIndex(hunks[next] ?? 0)
          }}
        >
          <ArrowUp size={12} />
        </button>
        <button
          type="button"
          className={control}
          aria-label="Next hunk"
          disabled={raw || !hunks.length || hunk >= hunks.length - 1}
          onClick={() => {
            const next = Math.min(hunks.length - 1, hunk + 1)
            setHunk(next)
            virtual.scrollToIndex(hunks[next] ?? 0)
          }}
        >
          <ArrowDown size={12} />
        </button>
      </footer>
    </section>
  )
}
