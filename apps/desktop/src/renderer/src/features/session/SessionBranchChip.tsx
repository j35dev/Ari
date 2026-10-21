import { useEffect, useRef, useState } from 'react'
import { CornerLeftUp, GitBranch } from 'lucide-react'
import { createLogger } from '@ari/shared/logger'
import { rpc } from '../../lib/rpc'

const log = createLogger('session:branch')

/** How often the readout re-checks the branch while mounted and visible. */
export const BRANCH_POLL_MS = 30_000

/**
 * Contextual branch readout inside the session space: shows the active
 * session's git branch in a slim reserved strip at the top of the transcript.
 * Asks git.status with the session scope — the worktree resolves server-side —
 * on mount, on a poll and when the window comes back into view, so a branch
 * change behind the open session refreshes instead of going stale until
 * remount. The poll skips while the window is hidden: each check costs a git
 * spawn on the main process. The strip mounts only when a branch
 * exists and reserves its own row, so the pill never overlays scrolling
 * checkpoints; outside repos it stays hidden.
 */
export function SessionBranchChip({
  sessionId,
  parentSession = null,
  onOpenSession,
}: {
  sessionId: string | null
  /** The session that delegated to this one; shown as a way back to it. */
  parentSession?: { id: string; title: string } | null
  onOpenSession?: (id: string) => void
}) {
  const [branch, setBranch] = useState<string | null>(null)
  const missesRef = useRef(0)

  useEffect(() => {
    setBranch(null)
    missesRef.current = 0
    if (sessionId === null) return
    let cancelled = false
    let inFlight = false
    const refresh = (): void => {
      if (inFlight) return
      inFlight = true
      void rpc
        .invoke('git.status', { sessionId })
        .finally(() => {
          inFlight = false
        })
        .then((status) => {
          if (cancelled) return
          if (status.isRepo && status.branch) {
            missesRef.current = 0
            setBranch(status.branch)
            return
          }
          // git.status reports every git failure as non-repo, so a single
          // miss means nothing — only consecutive misses clear the readout,
          // which hides a removed repo without blanking on transient blips.
          // Rejected RPCs keep the last known branch unconditionally.
          missesRef.current += 1
          if (missesRef.current >= 3) setBranch(null)
        })
        .catch((error: unknown) => log.warn('rpc call failed', error))
    }
    const poll = (): void => {
      if (document.visibilityState !== 'hidden') refresh()
    }
    refresh()
    const timer = setInterval(poll, BRANCH_POLL_MS)
    document.addEventListener('visibilitychange', poll)
    window.addEventListener('focus', poll)
    return () => {
      cancelled = true
      clearInterval(timer)
      document.removeEventListener('visibilitychange', poll)
      window.removeEventListener('focus', poll)
    }
  }, [sessionId])

  if (branch === null && parentSession === null) return null
  return (
    <div className="flex h-7 shrink-0 items-center gap-2 px-3">
      {parentSession !== null ? (
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
      ) : null}
      {branch !== null ? (
        <span
          className="ml-auto flex h-6 items-center gap-1.5 rounded-full border border-border/80 bg-surface-1/90 px-2.5 font-mono text-2xs text-fg-muted shadow-sm transition-colors hover:border-border-strong hover:text-fg"
          title="Active branch"
        >
          <GitBranch size={11} className="text-accent" aria-hidden="true" />
          <span className="max-w-40 truncate font-semibold">{branch}</span>
        </span>
      ) : null}
    </div>
  )
}
