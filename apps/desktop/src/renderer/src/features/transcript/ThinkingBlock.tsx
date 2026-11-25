import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Brain, ChevronRight } from 'lucide-react'
import { thoughtPreview } from './toolLabels'
import { useSmoothText } from './use-smooth-text'

/** "Thought for 6s"; a thought that never ran here has no measured length. */
function thoughtLabel(ms: number | null): string {
  if (ms === null) return 'Thought'
  const s = Math.max(1, Math.round(ms / 1000))
  return s < 60 ? `Thought for ${s}s` : `Thought for ${Math.floor(s / 60)}m ${s % 60}s`
}

/**
 * Reasoning. While the model is thinking it reads "Thinking" with the thought
 * itself flowing through a short window pinned to its newest line, so the
 * reader can follow along without the transcript growing. Once the turn moves
 * on it folds to one quiet line, "Thought for 6s" and a preview of its first
 * line, opening to the full thought as plain subtle text. `compact` is the
 * same line as a step inside an expanded activity burst, where it leads with
 * a glyph like its neighbours.
 */
export function ThinkingBlock({
  text,
  compact = false,
  expanded = false,
  live = false,
}: {
  text: string
  compact?: boolean
  expanded?: boolean
  /** The turn is on this thought right now. */
  live?: boolean
}) {
  const [openOverride, setOpenOverride] = useState<boolean | null>(null)
  const open = openOverride ?? expanded
  const startedRef = useRef<number | null>(live ? performance.now() : null)
  const [tookMs, setTookMs] = useState<number | null>(null)
  useEffect(() => {
    if (live) {
      startedRef.current ??= performance.now()
      return
    }
    if (startedRef.current !== null && tookMs === null)
      setTookMs(performance.now() - startedRef.current)
  }, [live, tookMs])

  if (live && !compact && !expanded) return <LiveThought text={text} />

  return (
    <div className={compact ? undefined : 'my-1'}>
      <button
        type="button"
        onClick={() => setOpenOverride((previous) => !(previous ?? expanded))}
        aria-expanded={open}
        aria-label="Reasoning"
        className={`group flex max-w-full items-center rounded-md text-left transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring ${
          compact
            ? 'h-[30px] w-full gap-2.5 text-[13.5px] text-fg-muted'
            : 'h-7 w-fit gap-1.5 text-sm text-fg-subtle'
        }`}
      >
        {compact ? (
          <Brain size={14} className="shrink-0 text-fg-subtle" aria-hidden="true" />
        ) : null}
        <span className={compact && live ? 'ari-shimmer shrink-0' : 'shrink-0'}>
          {compact && live ? 'Thinking' : thoughtLabel(tookMs)}
        </span>
        <span
          className={`min-w-0 truncate text-[13px] ${
            compact ? 'text-fg-subtle transition-colors group-hover:text-fg-muted' : ''
          }`}
        >
          {thoughtPreview(text)}
        </span>
        {compact ? null : (
          <ChevronRight
            size={14}
            aria-hidden="true"
            className={`shrink-0 transition-transform duration-150 motion-reduce:transition-none ${open ? 'rotate-90' : ''}`}
          />
        )}
      </button>
      {open ? (
        <p
          className={`ari-enter-rise max-w-[620px] whitespace-pre-wrap text-[13.5px] leading-relaxed text-fg-subtle ${
            compact ? 'pb-2 pl-6 pt-0.5' : 'ml-1.5 mt-0.5 border-l border-border-strong py-1 pl-4'
          }`}
        >
          {text}
        </p>
      ) : null}
    </div>
  )
}

/**
 * The thought being written: a shimmering "Thinking" over a window a few
 * lines tall that stays on the newest line, its older lines fading out at the
 * top. Its height is fixed once it fills, so the transcript below holds still.
 */
function LiveThought({ text }: { text: string }) {
  const paced = useSmoothText(text, true)
  const windowRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const node = windowRef.current
    if (!node) return
    node.scrollTop = node.scrollHeight
    if (node.scrollHeight > node.clientHeight + 1) node.dataset['overflow'] = ''
  }, [paced])
  return (
    <div className="my-1" role="status" aria-label="Thinking">
      <div className="flex h-7 items-center gap-1.5 text-sm">
        <span className="ari-shimmer">Thinking</span>
      </div>
      {paced.trim().length > 0 ? (
        <div
          ref={windowRef}
          className="ari-thought-window ml-1.5 border-l border-border-strong pl-4 text-[13.5px] leading-relaxed text-fg-subtle"
        >
          <p className="whitespace-pre-wrap py-0.5">{paced}</p>
        </div>
      ) : null}
    </div>
  )
}
