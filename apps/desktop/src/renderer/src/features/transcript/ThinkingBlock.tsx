import { useState } from 'react'
import { Brain, ChevronRight } from 'lucide-react'
import { thoughtPreview } from './toolLabels'

/**
 * Collapsible reasoning row, collapsed by default. The collapsed state shows
 * the thought's opening line rather than a bare "thinking" label so a run of
 * reasoning stays scannable without being expanded. Used standalone and as a
 * step inside a collapsed activity group.
 */
export function ThinkingBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="my-0.5">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label="Reasoning"
        className="flex w-full items-center gap-1.5 rounded-sm px-1 py-0.5 text-left transition-colors hover:bg-surface-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
      >
        <ChevronRight
          size={11}
          className={`shrink-0 text-fg-subtle transition-transform duration-150 ${open ? 'rotate-90' : ''}`}
        />
        <Brain size={11} className="shrink-0 text-fg-subtle" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-2xs italic text-fg-subtle">
          {thoughtPreview(text)}
        </span>
      </button>
      {open ? (
        <p className="mb-1 ml-3 whitespace-pre-wrap border-l-2 border-border pl-3 text-2xs italic leading-relaxed text-fg-subtle">
          {text}
        </p>
      ) : null}
    </div>
  )
}
