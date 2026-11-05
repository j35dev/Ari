import { CornerLeftUp } from 'lucide-react'

/**
 * A way back to the session that delegated this one, in a slim strip at the
 * top of the transcript. Renders nothing for top-level sessions. The branch
 * readout that used to share this strip lives in the titlebar's git control.
 */
export function ParentSessionLink({
  parentSession = null,
  onOpenSession,
}: {
  parentSession?: { id: string; title: string } | null
  onOpenSession?: (id: string) => void
}) {
  if (parentSession === null) return null
  return (
    <div className="flex h-7 shrink-0 items-center px-3">
      <button
        type="button"
        onClick={() => onOpenSession?.(parentSession.id)}
        aria-label={`Open parent session: ${parentSession.title}`}
        title={parentSession.title}
        className="flex h-6 min-w-0 items-center gap-1.5 rounded-full px-2 text-2xs text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
      >
        <CornerLeftUp size={11} className="shrink-0 text-accent" aria-hidden="true" />
        <span className="max-w-56 truncate">{parentSession.title}</span>
      </button>
    </div>
  )
}
