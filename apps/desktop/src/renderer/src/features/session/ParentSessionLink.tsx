import { CornerUpLeft } from 'lucide-react'

/**
 * Where this session came from, as one quiet line at the top-left of the
 * pane: the parent that delegated it, or Aria. It is positioned so it stays
 * readable over the scene of an empty session.
 */
export const paneOriginLink =
  'relative ms-3 mt-2 flex h-6 max-w-[calc(100%-1.5rem)] shrink-0 items-center gap-1.5 self-start rounded-md px-1.5 text-[12.5px] text-fg-subtle transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring'

/**
 * A way back to the session that delegated this one. Renders nothing for
 * top-level sessions. The branch readout lives in the titlebar's git control.
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
    <button
      type="button"
      onClick={() => onOpenSession?.(parentSession.id)}
      aria-label={`Open parent session: ${parentSession.title}`}
      title={parentSession.title}
      className={paneOriginLink}
    >
      <CornerUpLeft size={14} className="shrink-0" aria-hidden="true" />
      <span className="max-w-56 truncate">{parentSession.title}</span>
    </button>
  )
}
