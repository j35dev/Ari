import { useState } from 'react'
import { Info } from 'lucide-react'

/** Longer notices (a command's output) fold to their first lines. */
const FOLD_LINES = 6
const FOLD_CHARS = 600

/**
 * Something Ari tells the user mid-turn that did not fail it: the model that
 * actually answered, what an approval now covers, or what a slash command
 * reported. A sentence shows in full; command output longer than a few lines
 * folds behind "Show all". Either way it wraps inside the pane, and keeps the
 * output's own line breaks, without the failure styling an error note carries.
 */
export function NoticeNote({ text }: { text: string }) {
  const body = text.trim()
  const lines = body.split('\n')
  const long = lines.length > FOLD_LINES || body.length > FOLD_CHARS
  const [open, setOpen] = useState(false)
  const shown =
    long && !open ? lines.slice(0, FOLD_LINES).join('\n').slice(0, FOLD_CHARS).trimEnd() : body
  return (
    <div
      role="note"
      className="my-1 flex min-w-0 items-start gap-2 py-1 text-[13.5px] leading-relaxed text-fg-muted"
    >
      <Info size={14} className="mt-1 shrink-0 text-fg-subtle" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <span className="block whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
          {shown}
          {long && !open ? '…' : null}
        </span>
        {long ? (
          <button
            type="button"
            onClick={() => setOpen((value) => !value)}
            aria-expanded={open}
            className="mt-0.5 rounded-sm text-xs text-fg-subtle underline underline-offset-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
          >
            {open ? 'Show less' : 'Show all'}
          </button>
        ) : null}
      </div>
    </div>
  )
}
