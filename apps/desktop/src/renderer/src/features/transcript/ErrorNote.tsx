import { useState } from 'react'
import { AlertTriangle, ChevronRight } from 'lucide-react'
import { friendlyErrorText } from '../moment'
import { classifyTurnError, UNCLASSIFIED_TITLE } from '../session/turnError'

/**
 * Historical turn failure rendered as one terminal-like status row. The
 * actionable banner owns the current failure; this row preserves older
 * failures in context without dumping provider stderr into the transcript.
 */
export function ErrorNote({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  const { title } = classifyTurnError(text)
  const summary = title === UNCLASSIFIED_TITLE ? friendlyErrorText(text) : title

  return (
    <div className="ari-error-note my-1 pl-3">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-label={`Turn failed: ${summary}`}
        className="group flex w-full items-center gap-2 rounded-md px-1 py-[3px] text-left transition-colors hover:bg-danger-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-ring"
      >
        <AlertTriangle size={11} className="shrink-0 text-danger" aria-hidden="true" />
        <span className="shrink-0 text-xs font-medium text-danger">failed</span>
        <span className="min-w-0 flex-1 truncate font-mono text-2xs text-fg-muted">{summary}</span>
        <ChevronRight
          size={12}
          aria-hidden="true"
          className={`shrink-0 text-fg-subtle opacity-50 transition-transform duration-150 group-hover:opacity-100 ${open ? 'rotate-90' : ''}`}
        />
      </button>
      {open ? (
        <pre className="mb-1 ml-5 mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all border-l border-danger-subtle py-1 pl-3 font-mono text-2xs leading-relaxed text-fg-muted">
          {text}
        </pre>
      ) : null}
    </div>
  )
}
