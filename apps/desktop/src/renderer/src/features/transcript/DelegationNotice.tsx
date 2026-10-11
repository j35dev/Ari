import { useState } from 'react'
import { ChevronRight, CornerDownRight } from 'lucide-react'

/** The bracketed line Ari opens every notice with; the card's own label replaces it. */
const SIGNATURE = /^\[Ari delegation update:[^\]]*\]\s*/

/**
 * A wake-up Ari wrote for this session when delegated children finished. It
 * is a user-role message on the wire, but nobody typed it, so it renders as a
 * quiet status row instead of a prompt bubble: which children reported, with
 * the exact text the agent received one click away.
 */
export function DelegationNotice({
  text,
  sessionIds,
  sessionTitle,
  onOpenSession,
}: {
  text: string
  sessionIds: readonly string[]
  sessionTitle?: (id: string) => string | undefined
  onOpenSession?: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  const names = sessionIds.map((id) => sessionTitle?.(id) ?? 'a removed session')
  // The notice says how each child ended; an update made only of failures
  // should not read as good news.
  const allFailed = sessionIds.every((id) => text.includes(`(${id}) failed.`))
  const summary = `${names.join(', ')} ${allFailed ? 'failed' : 'reported back'}`
  return (
    <div className="ari-burst my-1 pl-3" data-activity="settled">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-label={`Delegation update: ${summary}`}
        className="group flex w-full items-center gap-2 rounded-md px-1 py-[3px] text-left transition-colors hover:bg-surface-1/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-ring"
      >
        <CornerDownRight size={11} aria-hidden="true" className="shrink-0 text-accent" />
        <span className="shrink-0 text-xs text-fg-muted">Delegation update</span>
        <span className="min-w-0 flex-1 truncate font-mono text-2xs text-fg-subtle">{summary}</span>
        <ChevronRight
          size={12}
          aria-hidden="true"
          className={`shrink-0 text-fg-subtle opacity-40 transition-transform duration-150 group-hover:opacity-100 motion-reduce:transition-none ${open ? 'rotate-90' : ''}`}
        />
      </button>
      {open ? (
        <div className="ari-burst-steps mb-1 ml-5 mt-1 border-l border-border pl-3">
          {onOpenSession ? (
            <p className="flex flex-wrap gap-1.5 pb-1">
              {sessionIds.map((id) => {
                const title = sessionTitle?.(id)
                return title === undefined ? null : (
                  <button
                    key={id}
                    type="button"
                    onClick={() => onOpenSession(id)}
                    className="rounded-sm border border-border px-1.5 py-0.5 text-2xs text-fg-muted transition-colors hover:border-border-strong hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
                  >
                    Open {title}
                  </button>
                )
              })}
            </p>
          ) : null}
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words font-mono text-2xs leading-relaxed text-fg-muted">
            {text.replace(SIGNATURE, '')}
          </pre>
        </div>
      ) : null}
    </div>
  )
}
