import { useState } from 'react'
import { SquareSlash } from 'lucide-react'
import type { SlashInvocation } from '@ari/contracts/slash-commands'

/** Arguments longer than this, or on several lines, start folded. */
const FOLD_CHARS = 160

/**
 * A user message that is a slash command, drawn as a compact chip — the
 * command's name, then its arguments — instead of a chat bubble. Long
 * arguments fold behind "Show all" and always wrap inside the pane.
 */
export function CommandChip({ command }: { command: SlashInvocation }) {
  const long = command.args.length > FOLD_CHARS || command.args.includes('\n')
  const [open, setOpen] = useState(false)
  const args = long && !open ? `${command.args.slice(0, FOLD_CHARS).split('\n')[0]}…` : command.args
  return (
    <div
      data-slash-command={command.name}
      className="ari-command-chip ml-1 flex min-w-0 max-w-[72%] items-start gap-2 rounded-xl border border-border bg-surface-2/60 px-3 py-1.5 text-[13px] text-fg"
    >
      <SquareSlash size={14} aria-hidden className="mt-[3px] shrink-0 text-fg-subtle" />
      <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">
        <span className="font-medium">/{command.name}</span>
        {args ? <span className="text-fg-muted"> {args}</span> : null}
        {long ? (
          <button
            type="button"
            onClick={() => setOpen((value) => !value)}
            aria-expanded={open}
            className="ml-1.5 rounded-sm text-xs text-fg-subtle underline underline-offset-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
          >
            {open ? 'Show less' : 'Show all'}
          </button>
        ) : null}
      </span>
    </div>
  )
}
