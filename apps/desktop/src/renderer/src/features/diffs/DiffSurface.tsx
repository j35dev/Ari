import { useEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ArrowDown, ArrowUp, Columns2, MoreHorizontal, Rows3, Search, TextWrap } from 'lucide-react'
import { Popover } from '@ari/ui/popover'
import type { GitReviewNote } from '@ari/contracts/rpc'
import type { DiffLine } from './parseDiff'
import { parseDiff } from './parseDiff'
import { reviewRows } from './review-rows'
import { useDiffHighlight } from './use-diff-highlight'
import { useEngineSettings } from '../settings/useEngineSettings'
import { iconButton, menuItem } from '../../lib/recipes'

export type DiffRange = Pick<GitReviewNote, 'side' | 'startLine' | 'endLine' | 'context'>
export interface DiffSurfaceProps {
  diffText: string
  path: string
  comparisonId: string
  onRange?: (range: DiffRange) => void
  scrollOffset?: number
  onScrollOffset?: (offset: number) => void
}
const control = `${iconButton} aria-pressed:bg-fg/9 aria-pressed:text-fg`
/** A text toggle in the toolbar: quiet until hovered, washed while on. */
const toggleText =
  'inline-flex h-7 items-center rounded-md px-2 text-xs text-fg-muted transition-colors hover:bg-fg/6 hover:text-fg aria-pressed:bg-fg/9 aria-pressed:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring'
/** One diff line: 12.5px mono on a 21px row (about 1.65). Keep in step with the row classes. */
const ROW_HEIGHT = 21

/** Shared, virtualized split/unified review with bounded syntax, search and side-aware ranges. */
export function DiffSurface({
  diffText,
  path,
  comparisonId,
  onRange,
  scrollOffset = 0,
  onScrollOffset,
}: DiffSurfaceProps) {
  // Null until the user picks; until then Settings → Source control decides.
  const [preferSplit, setSplit] = useState<boolean | null>(null)
  const { settings } = useEngineSettings()
  const defaults = settings?.sourceControl
  const [wrapPref, setWrap] = useState<boolean | null>(null)
  const [ignoreWhitespace, setIgnoreWhitespace] = useState(false)
  const [raw, setRaw] = useState(false)
  const [optionsOpen, setOptionsOpen] = useState(false)
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
  // A new or deleted file has nothing on one side: split view would spend half
  // the width on an empty column, so it reads as a single column instead.
  const oneSided = useMemo(() => {
    if (!file) return false
    const lines = reviewRows(file, false, false).filter((row) => !row.header)
    return lines.length > 0 && (lines.every((row) => !row.old) || lines.every((row) => !row.next))
  }, [file])
  // In a side panel two columns are too narrow to read, so it starts unified.
  const root = useRef<HTMLElement>(null)
  const [narrow, setNarrow] = useState(false)
  useEffect(() => {
    const element = root.current
    if (!element || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setNarrow(entry.contentRect.width < 640)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  const wrap = wrapPref ?? defaults?.wrapDiffLines ?? false
  const split = (preferSplit ?? (defaults?.diffView !== 'unified' && !narrow)) && !oneSided
  const rows = useMemo(
    () => (file ? reviewRows(file, split, ignoreWhitespace) : []),
    [file, split, ignoreWhitespace],
  )
  const maxChars = useMemo(
    () =>
      rows.reduce(
        (max, row) => Math.max(max, row.old?.content.length ?? 0, row.next?.content.length ?? 0),
        40,
      ),
    [rows],
  )
  const highlights = useDiffHighlight(rows, path)
  const virtual = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroll.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
    initialOffset: scrollOffset,
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
    scroll.current?.scrollTo?.({ top: scrollOffset })
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
        className="w-12 shrink-0 select-none px-2 text-right font-mono text-[12.5px] tabular-nums text-fg-subtle/70 enabled:hover:text-fg focus-visible:bg-fg/9 focus-visible:text-fg focus-visible:outline-none"
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
        className={`flex min-w-0 text-fg ${tint} ${selected ? 'ring-1 ring-inset ring-accent/40' : ''}`}
        data-line-type={line?.type}
      >
        {!split ? gutter(line, 'old') : null}
        {gutter(line, split ? side : 'new')}
        <span aria-hidden className="w-5 shrink-0 select-none text-center text-fg-subtle">
          {line?.type === 'add' ? '+' : line?.type === 'del' ? '−' : ''}
        </span>
        <code
          className={`min-w-0 flex-1 pr-4 font-mono text-[12.5px] ${wrap ? 'whitespace-pre-wrap [overflow-wrap:anywhere]' : 'whitespace-pre'}`}
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
      ref={root}
      className="flex h-full min-h-0 flex-col"
      aria-label={`Diff for ${path}`}
      onKeyDown={(event) => {
        if ((event.metaKey || event.ctrlKey) && event.key === 'f') {
          event.preventDefault()
          search.current?.focus()
        }
      }}
    >
      <div className="flex min-h-9 shrink-0 flex-wrap items-center gap-0.5 border-b border-border py-0.5 pl-4 pr-2">
        <Search size={14} className="shrink-0 text-fg-subtle" aria-hidden />
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
          className="h-7 min-w-20 flex-1 rounded-md bg-transparent px-1.5 text-[13px] text-fg outline-none placeholder:text-fg-subtle focus-visible:ring-2 focus-visible:ring-accent-ring"
        />
        {query ? (
          <span role="status" className="px-2 font-mono text-xs tabular-nums text-fg-subtle">
            {matches.length ? currentMatch + 1 : 0}/{matches.length}
          </span>
        ) : null}
        {query ? (
          <>
            <button
              type="button"
              className={control}
              aria-label="Previous match"
              disabled={!matches.length}
              onClick={() => navigate(-1)}
            >
              <ArrowUp size={14} />
            </button>
            <button
              type="button"
              className={control}
              aria-label="Next match"
              disabled={!matches.length}
              onClick={() => navigate(1)}
            >
              <ArrowDown size={14} />
            </button>
          </>
        ) : null}
        <span className="mx-1 h-4 w-px bg-border" aria-hidden />
        <button
          type="button"
          className={control}
          aria-label="Split diff"
          title={oneSided ? 'Only one side changed' : 'Side by side'}
          aria-pressed={split}
          disabled={oneSided}
          onClick={() => {
            setSplit(true)
          }}
        >
          <Columns2 size={14} />
        </button>
        <button
          type="button"
          className={control}
          aria-label="Unified diff"
          title="Unified view"
          aria-pressed={!split}
          onClick={() => {
            setSplit(false)
          }}
        >
          <Rows3 size={14} />
        </button>
        <button
          type="button"
          className={control}
          aria-label="Wrap lines"
          title="Wrap long lines"
          aria-pressed={wrap}
          onClick={() => setWrap(!wrap)}
        >
          <TextWrap size={14} />
        </button>
        {narrow ? (
          <Popover open={optionsOpen} onOpenChange={setOptionsOpen}>
            <Popover.Trigger aria-label="Diff options" className={control}>
              <MoreHorizontal size={14} />
            </Popover.Trigger>
            {/* Two rows in the popover's own menu look (4px inset, 32px rows). */}
            <Popover.Content align="end" className="w-48">
              <label className="flex h-8 items-center gap-2.5 rounded-md px-2.5 text-[13px] text-fg-muted">
                <input
                  type="checkbox"
                  checked={ignoreWhitespace}
                  onChange={(event) => setIgnoreWhitespace(event.target.checked)}
                  className="size-3.5 accent-fg"
                />
                Ignore whitespace
              </label>
              <button
                type="button"
                aria-pressed={raw}
                onClick={() => {
                  setRaw(!raw)
                  setOptionsOpen(false)
                }}
                className={`${menuItem} aria-pressed:text-fg`}
              >
                Raw patch
              </button>
            </Popover.Content>
          </Popover>
        ) : (
          <>
            <label className="ml-2 flex items-center gap-1.5 text-xs text-fg-muted">
              <input
                type="checkbox"
                checked={ignoreWhitespace}
                onChange={(event) => setIgnoreWhitespace(event.target.checked)}
                className="size-3.5 accent-fg"
              />
              Ignore whitespace
            </label>
            <button
              type="button"
              className={`ml-1 ${toggleText}`}
              aria-pressed={raw}
              onClick={() => setRaw(!raw)}
            >
              Raw patch
            </button>
          </>
        )}
      </div>
      {split && !raw ? (
        <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] border-b border-border bg-surface-0 text-xs text-fg-subtle">
          <span className="px-4 py-1">Before</span>
          <span className="border-l border-border px-4 py-1">After</span>
        </div>
      ) : null}
      <div
        ref={scroll}
        className="ari-scroll shiki min-h-0 flex-1 overflow-auto bg-surface-0 [scrollbar-gutter:stable]"
        tabIndex={0}
        aria-label="Diff lines"
        onScroll={(event) => onScrollOffset?.(event.currentTarget.scrollTop)}
      >
        {raw ? (
          <pre className="px-4 py-3 font-mono text-[12.5px] leading-[1.65] text-fg">{diffText}</pre>
        ) : file?.isBinary ? (
          <p className="px-4 py-3 text-[13px] text-fg-subtle">
            Binary content changed. Open the file to inspect it.
          </p>
        ) : rows.length === 0 ? (
          <p className="px-4 py-3 text-[13px] text-fg-subtle">No text changes in this selection.</p>
        ) : (
          <div
            className="font-mono text-[12.5px]"
            style={{
              height: virtual.getTotalSize(),
              position: 'relative',
              // Split halves wrap inside their column; only unified view scrolls sideways.
              minWidth: wrap
                ? undefined
                : split
                  ? `max(100%, calc(${maxChars * 2}ch + 9rem))`
                  : `max(100%, calc(${maxChars}ch + 7rem))`,
            }}
          >
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
                  className={`min-h-[21px] leading-[21px] ${query && matches[currentMatch] === item.index ? 'outline outline-1 outline-accent/50' : ''}`}
                >
                  {row.header ? (
                    <div className="bg-fg/4 px-4 font-mono text-xs leading-[21px] text-fg-subtle">
                      {row.header}
                    </div>
                  ) : split ? (
                    <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] [&>div+div]:border-l [&>div+div]:border-border">
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
      <footer className="flex h-8 shrink-0 items-center gap-0.5 border-t border-border pl-4 pr-2 text-xs text-fg-subtle">
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
          <ArrowUp size={14} />
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
          <ArrowDown size={14} />
        </button>
      </footer>
    </section>
  )
}
