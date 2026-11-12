import { useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { friendlyErrorText } from '../moment'
import { classifyTurnError, UNCLASSIFIED_TITLE } from '../session/turnError'

/**
 * Historical turn failure as one quiet line: the red status dot and what went
 * wrong. The actionable banner owns the current failure; this row preserves
 * older failures in context, and keeps provider stderr folded until asked for.
 */
export function ErrorNote({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  const { title } = classifyTurnError(text)
  const summary = title === UNCLASSIFIED_TITLE ? friendlyErrorText(text) : title

  return (
    <div className="ari-error-note my-1">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-label={`Turn failed: ${summary}`}
        className="group flex h-7 w-fit max-w-full items-center gap-2 rounded-md text-left text-sm text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
      >
        <span className="ari-status" data-status="error" aria-hidden="true" />
        <span className="min-w-0 truncate">{summary}</span>
        <ChevronRight
          size={14}
          aria-hidden="true"
          className={`shrink-0 text-fg-subtle transition-[color,transform] duration-150 group-hover:text-fg motion-reduce:transition-none ${open ? 'rotate-90' : ''}`}
        />
      </button>
      {open ? (
        <pre className="ari-enter-rise ml-1.5 mt-0.5 max-h-40 overflow-auto whitespace-pre-wrap break-all border-l border-border-strong py-1 pl-4 font-mono text-[12.5px] leading-relaxed text-fg-muted">
          {text}
        </pre>
      ) : null}
    </div>
  )
}
