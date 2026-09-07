import { useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { thoughtPreview } from './toolLabels'

/**
 * Collapsible reasoning row, collapsed by default in the Claude style: a dim
 * italic preview line that expands to the full thought. Used standalone and
 * as a step inside an expanded activity burst.
 */
export function ThinkingBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="my-1 rounded-lg border border-border/50 bg-surface-1/30 px-2 py-1 transition-colors">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label="Reasoning"
        className="flex w-full items-center gap-2 rounded-md py-0.5 text-left transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
      >
        <ChevronRight
          size={12}
          className={`shrink-0 text-accent transition-transform duration-150 ${open ? 'rotate-90' : ''}`}
        />
        <span className="text-2xs font-semibold uppercase tracking-wider text-accent/90">Thought</span>
        <span className="min-w-0 flex-1 truncate text-2xs italic text-fg-subtle">
          {thoughtPreview(text)}
        </span>
      </button>
      {open ? (
        <p className="mt-1.5 mb-1 ml-4 whitespace-pre-wrap border-l border-accent/30 pl-3 text-xs italic leading-relaxed text-fg-muted">
          {text}
        </p>
      ) : null}
    </div>
  )
}
