import { useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { thoughtPreview } from './toolLabels'

/**
 * Collapsible reasoning row, collapsed by default in the Claude style: a dim
 * italic preview line that expands to the full thought. Used standalone and
 * as a step inside an expanded activity burst.
 */
export function ThinkingBlock({ text, compact = false }: { text: string; compact?: boolean }) {
  const [open, setOpen] = useState(false)
  return (
    <div
      className={
        compact
          ? 'my-0.5'
          : 'my-1 rounded-lg border border-border/50 bg-surface-1/30 px-2 py-1 transition-colors'
      }
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label="Reasoning"
        className={`flex w-full items-center gap-2 rounded-md text-left transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring ${compact ? 'px-1 py-[3px]' : 'py-0.5'}`}
      >
        <ChevronRight
          size={12}
          className={`shrink-0 transition-transform duration-150 ${compact ? 'text-fg-subtle' : 'text-accent'} ${open ? 'rotate-90' : ''}`}
        />
        <span
          className={`text-2xs font-semibold uppercase tracking-wider ${compact ? 'text-fg-subtle' : 'text-accent/90'}`}
        >
          thought
        </span>
        <span className="min-w-0 flex-1 truncate text-2xs italic text-fg-subtle">
          {thoughtPreview(text)}
        </span>
      </button>
      {open ? (
        <p
          className={`mb-1 whitespace-pre-wrap border-l pl-3 text-xs italic leading-relaxed text-fg-muted ${compact ? 'ml-4 mt-1 border-border' : 'ml-4 mt-1.5 border-accent/30'}`}
        >
          {text}
        </p>
      ) : null}
    </div>
  )
}
