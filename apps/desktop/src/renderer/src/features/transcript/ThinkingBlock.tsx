import { useState } from 'react'
import { Brain, ChevronRight } from 'lucide-react'
import { thoughtPreview } from './toolLabels'

/**
 * Collapsible reasoning, one quiet line until asked: "Thought" and a preview
 * of its first line, opening to the full thought as plain subtle text. On its
 * own it reads like a collapsed burst; `compact` is the same line as a step
 * inside an expanded activity burst, where it leads with a glyph like its
 * neighbours.
 */
export function ThinkingBlock({
  text,
  compact = false,
  expanded = false,
}: {
  text: string
  compact?: boolean
  expanded?: boolean
}) {
  const [openOverride, setOpenOverride] = useState<boolean | null>(null)
  const open = openOverride ?? expanded
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
        <span className="shrink-0">Thought</span>
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
