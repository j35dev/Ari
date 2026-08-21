import { useState } from 'react'
import { ChevronRight } from 'lucide-react'

/** Collapsible reasoning block; collapsed by default. */
export function ThinkingBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="my-1">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex items-center gap-1 rounded-sm px-1 py-0.5 text-2xs text-fg-subtle transition-colors hover:bg-surface-1 hover:text-fg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
      >
        <ChevronRight
          size={11}
          className={`transition-transform duration-150 ${open ? 'rotate-90' : ''}`}
        />
        thinking
      </button>
      {open ? (
        <p className="mt-1 border-l-2 border-border pl-3 text-xs italic leading-relaxed text-fg-subtle">
          {text}
        </p>
      ) : null}
    </div>
  )
}
